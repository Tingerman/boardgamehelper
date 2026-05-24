// Agent 图编译入口
//
// 节点拓扑（详见 AGENT_GRAPH.md）：
//
//   START → N1 detect_intent ─┬→ rag → N6 catalog_check ─┬→ catalog_hit_need_ingest → N7 ingest → N2
//                             │                          ├→ catalog_hit_already_in_db → N2
//                             │                          ├→ user_specified_book → N2
//                             │                          └→ no_match → N2
//                             │       N2 hybrid_retrieve → N3 answer → N4 faithfulness ─┬→ END
//                             │                                                          └→ retry → N3
//                             ├→ off_topic → N5 refuse → END
//                             └→ greeting  → N5 refuse → END
import { StateGraph, START, END, MemorySaver, Command } from '@langchain/langgraph';
import { StateAnnotation } from './state.mjs';
import { detectIntentNode } from './nodes/intent.mjs';
import { catalogCheckNode, routeAfterCatalog } from './nodes/catalog.mjs';
import { ingestNode } from './nodes/ingest.mjs';
import { hybridRetrieveNode } from './nodes/retrieve.mjs';
import { answerNode } from './nodes/answer.mjs';
import {
  faithfulnessNode,
  routeAfterFaithfulness,
  incrementRetryNode,
} from './nodes/faithfulness.mjs';
import { refuseNode } from './nodes/refuse.mjs';
import { catalogProbeNode } from './nodes/catalog_probe.mjs';

let _compiled = null;
let _checkpointer = null;

/**
 * N1 后路由：bookIds 非空时跳过 N6 catalog_check（用户已强指定）。
 */
export function routeAfterIntent(state) {
  if (state.intent === 'off_topic' || state.intent === 'greeting') return 'refuse';
  if (state.intent === 'rag' && Array.isArray(state.bookIds) && state.bookIds.length > 0) {
    return 'hybrid_retrieve';
  }
  return 'catalog_check';
}

/**
 * N8 后路由：用户接受 L2 升级（l2Resumed=true）时回 N2 重检索；否则收口。
 */
export function routeAfterCatalogProbe(state) {
  return state.l2Resumed === true ? 'hybrid_retrieve' : END;
}

export function buildGraph() {
  if (_compiled) return _compiled;
  _checkpointer = new MemorySaver();

  const builder = new StateGraph(StateAnnotation)
    .addNode('detect_intent', detectIntentNode)
    .addNode('catalog_check', catalogCheckNode)
    .addNode('do_ingest', ingestNode)
    .addNode('hybrid_retrieve', hybridRetrieveNode)
    .addNode('do_answer', answerNode)
    .addNode('do_faithfulness', faithfulnessNode)
    .addNode('retry', incrementRetryNode)
    .addNode('catalog_probe', catalogProbeNode)
    .addNode('refuse', refuseNode)
    .addEdge(START, 'detect_intent')
    .addConditionalEdges('detect_intent', routeAfterIntent, {
      catalog_check: 'catalog_check',
      hybrid_retrieve: 'hybrid_retrieve',
      refuse: 'refuse',
    })
    .addConditionalEdges('catalog_check', routeAfterCatalog, {
      do_ingest: 'do_ingest',
      hybrid_retrieve: 'hybrid_retrieve',
    })
    .addEdge('do_ingest', 'hybrid_retrieve')
    .addEdge('hybrid_retrieve', 'do_answer')
    .addEdge('do_answer', 'do_faithfulness')
    .addConditionalEdges('do_faithfulness', routeAfterFaithfulness, {
      [END]: END,
      retry: 'retry',
      catalog_probe: 'catalog_probe',
    })
    .addEdge('retry', 'do_answer')
    .addConditionalEdges('catalog_probe', routeAfterCatalogProbe, {
      hybrid_retrieve: 'hybrid_retrieve',
      [END]: END,
    })
    .addEdge('refuse', END);

  _compiled = builder.compile({ checkpointer: _checkpointer });
  return _compiled;
}

export function getCheckpointer() {
  if (!_compiled) buildGraph();
  return _checkpointer;
}

/**
 * 主调用入口
 * @param {string} question
 * @param {{ bookIds?: string[], bookId?: string|null, sseEmit?: Function, threadId?: string, cacheDir?: string }} opts
 */
export async function invokeAgent(question, opts = {}) {
  const graph = buildGraph();
  const bookIds = Array.isArray(opts.bookIds)
    ? opts.bookIds
    : (opts.bookId ? [opts.bookId] : []);
  const threadId = opts.threadId || `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const initial = { question, bookIds };
  const config = {
    recursionLimit: 25,
    configurable: {
      thread_id: threadId,
      sseEmit: opts.sseEmit || (() => {}),
      cacheDir: opts.cacheDir,
    },
  };
  const final = await graph.invoke(initial, config);
  const interrupts = await collectInterrupts(graph, threadId);
  return shapeOutput(final, threadId, interrupts);
}

/**
 * 续跑入口：当 invokeAgent 返回 interrupted=true 时调用
 */
export async function resumeAgent(threadId, resumeValue, opts = {}) {
  const graph = buildGraph();
  if (!threadId) throw new Error('threadId required');
  const config = {
    recursionLimit: 25,
    configurable: {
      thread_id: threadId,
      sseEmit: opts.sseEmit || (() => {}),
      cacheDir: opts.cacheDir,
    },
  };
  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
  if (!snapshot || !snapshot.values || Object.keys(snapshot.values).length === 0) {
    const err = new Error('session_expired');
    err.code = 'session_expired';
    throw err;
  }
  const final = await graph.invoke(new Command({ resume: resumeValue }), config);
  const interrupts = await collectInterrupts(graph, threadId);
  return shapeOutput(final, threadId, interrupts);
}

/**
 * 收集当前 thread 处于"待恢复"的 interrupt（任务级别）
 */
async function collectInterrupts(graph, threadId) {
  try {
    const snap = await graph.getState({ configurable: { thread_id: threadId } });
    if (!snap || !Array.isArray(snap.tasks)) return [];
    const out = [];
    for (const t of snap.tasks) {
      if (Array.isArray(t.interrupts)) {
        for (const itr of t.interrupts) {
          if (itr && itr.value) out.push(itr);
        }
      }
    }
    return out;
  } catch (_) {
    return [];
  }
}

function shapeOutput(final, threadId, interrupts) {
  if (Array.isArray(interrupts) && interrupts.length > 0) {
    const payload = interrupts[0].value || {};
    return {
      interrupted: true,
      threadId,
      candidates: payload.candidates || [],
      reason: payload.reason || null,
      partialAnswer: final.answer || '',
      partialSources: rerankSourcesByCitation(final.sources, final.citedChunks),
      bookIds: final.bookIds || [],
    };
  }
  const sources = rerankSourcesByCitation(final.sources, final.citedChunks);
  return {
    interrupted: false,
    threadId,
    answer: final.answer,
    sources,
    intent: final.intent,
    bookIds: final.bookIds,
    faithfulness: final.faithfulness,
    retryCount: final.retryCount,
    catalogStatus: final.catalogStatus,
    matchedBy: final.matchedBy,
    matchConfidence: final.matchConfidence,
    ingestResult: final.ingestResult,
    citedChunks: final.citedChunks,
    l2Candidates: final.l2Candidates || [],
    l2Resumed: final.l2Resumed === true,
  };
}

/**
 * 按 LLM 显式 citation 优先 + RRF score 兜底重排 sources。
 * 给每条 source 写 cited 标记。
 */
export function rerankSourcesByCitation(sources, citedChunks) {
  if (!Array.isArray(sources) || sources.length === 0) return sources || [];
  const cited = new Set(Array.isArray(citedChunks) ? citedChunks : []);
  const tagged = sources.map(s => ({ ...s, cited: cited.has(s.chunkIndex) }));
  // 稳定排序：cited 优先；同组内按 score 降序
  return tagged
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (a.s.cited !== b.s.cited) return a.s.cited ? -1 : 1;
      const sa = parseFloat(a.s.score) || 0;
      const sb = parseFloat(b.s.score) || 0;
      if (sa !== sb) return sb - sa;
      return a.i - b.i;
    })
    .map(({ s }) => s);
}
