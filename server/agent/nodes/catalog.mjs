// N6 catalog_check（双层匹配）
//
// 流程：
//   0. bookId 已传 → user_specified_book，跳过匹配
//   1. Layer 1: alias 硬匹配
//   2. Layer 2: 小模型 LLM 基于 summary 语义匹配
//   3. 都 miss → no_match
//
// 命中判定：entry.kind === 'in_db' → catalog_hit_already_in_db
//          entry.kind === 'catalog_only' → catalog_hit_need_ingest（emit route，触发 N7）
//
// 埋点：每次 N6 落一条 jsonl 到 server/metrics/n6.jsonl

import fs from 'node:fs';
import path from 'node:path';
import { END } from '@langchain/langgraph';
import { getDeps } from '../deps.mjs';
import { matchByAlias, buildCandidatePool, matchByLlmIntro, gameKeyForEntry } from '../../catalog/matcher.mjs';

const METRICS_PATH = path.resolve(process.cwd(), 'server/metrics/n6.jsonl');

function logMetric(record) {
  try {
    fs.mkdirSync(path.dirname(METRICS_PATH), { recursive: true });
    fs.appendFileSync(METRICS_PATH, JSON.stringify({ ts: Date.now(), ...record }) + '\n');
  } catch (err) {
    // 埋点失败不致命
    console.warn('[N6] metric log failed:', err.message);
  }
}

function makeBilingualBookId(entry) {
  if (entry.kind === 'in_db') return entry.bookId;
  if (entry.kind === 'catalog_only') return `bili-${entry.dynIdStr}`;
  return null;
}

/**
 * Layer A 隐式回流：N6 LLM 命中（含 belowThreshold）后异步把 keyTokens 写 staging。
 * 过滤：长度 < 2 的 token / 已是 alias / 已有 staging 命中由 staging 自身 normalize+dedupe（多写一行成本可忽略）。
 */
function recordKeyTokensFireAndForget({ entry, keyTokens, question, n6Confidence, n6Reason, belowThreshold }) {
  if (!Array.isArray(keyTokens) || keyTokens.length === 0) return;
  Promise.all([
    import('../../feedback/alias_staging.mjs'),
  ]).then(([staging]) => {
    const gameKey = gameKeyForEntry(entry);
    if (!gameKey) return;
    for (const tok of keyTokens) {
      if (typeof tok !== 'string') continue;
      const t = tok.trim();
      if (t.length < 2) continue;
      // 已是 alias（matchByAlias 命中）跳过，避免无意义重复
      if (matchByAlias(t)) continue;
      staging.recordCandidate({
        source: 'n6_llm_match',
        gameKey,
        gameZhName: entry.zhName || null,
        candidate: t,
        userQuery: question,
        extra: { n6Confidence, n6Reason, belowThreshold: !!belowThreshold },
      });
    }
  }).catch((err) => {
    console.warn('[N6] alias staging fire-and-forget failed:', err.message);
  });
}

export async function catalogCheckNode(state, config) {
  const { question, bookIds } = state;
  const sseEmit = config?.configurable?.sseEmit ?? (() => {});
  const t0 = Date.now();

  // 0. 用户已显式选定 bookIds（前端多选）→ 标 user_specified 直接放行
  //    注：正常情况 graph 在 N1 后已通过 routeAfterIntent 跳过 N6，这里是兜底防御
  if (bookIds && bookIds.length > 0) {
    logMetric({
      matchedBy: 'user_specified', catalogStatus: 'user_specified_book',
      latencyMs: Date.now() - t0, confidence: 1,
    });
    return {
      catalogStatus: 'user_specified_book',
      matchedBy: 'user_specified',
      matchConfidence: 1,
      bookIds,
    };
  }

  // 1. Layer 1
  const aliasHit = matchByAlias(question);
  if (aliasHit) {
    const entry = aliasHit.entry;
    return finalizeMatch({
      entry, matchedBy: 'alias_exact', confidence: 1, sseEmit, t0,
    });
  }

  // 2. Layer 2
  let candidates = [];
  let llmHit = null;
  let llmError = false;
  try {
    candidates = buildCandidatePool();
  } catch (_) {}
  if (candidates.length > 0) {
    try {
      const { rag } = getDeps();
      llmHit = await matchByLlmIntro(
        (msgs, opts) => rag.client.chat(msgs, opts),
        question,
        candidates
      );
    } catch (err) {
      llmError = true;
      console.warn('[N6] Layer 2 unexpected error:', err.message);
    }
  }

  if (llmHit && llmHit.entry) {
    // Layer A 异步回流：把 LLM 抽出来的 keyTokens 作为 alias 候选写 staging。
    // fire-and-forget，不阻塞主流程。
    recordKeyTokensFireAndForget({
      entry: llmHit.entry,
      keyTokens: llmHit.keyTokens || [],
      question,
      n6Confidence: llmHit.confidence,
      n6Reason: llmHit.reason,
      belowThreshold: false,
    });
    return finalizeMatch({
      entry: llmHit.entry, matchedBy: 'llm_intro', confidence: llmHit.confidence,
      sseEmit, t0,
    });
  }

  // belowThreshold 也回流 keyTokens（用于学到"模糊命中"的别名）
  if (llmHit && llmHit.belowThreshold && llmHit.picked) {
    recordKeyTokensFireAndForget({
      entry: llmHit.picked,
      keyTokens: llmHit.keyTokens || [],
      question,
      n6Confidence: llmHit.confidence,
      n6Reason: llmHit.reason,
      belowThreshold: true,
    });
  }

  // miss
  logMetric({
    matchedBy: null, catalogStatus: 'no_match',
    latencyMs: Date.now() - t0,
    poolSize: candidates.length,
    llmError,
    belowThreshold: !!(llmHit && llmHit.belowThreshold),
    pickedConfidence: llmHit ? llmHit.confidence : null,
  });
  return {
    catalogStatus: 'no_match',
    matchedBy: null,
    matchConfidence: null,
  };
}

function finalizeMatch({ entry, matchedBy, confidence, sseEmit, t0 }) {
  const isInDb = entry.kind === 'in_db';
  const status = isInDb ? 'catalog_hit_already_in_db' : 'catalog_hit_need_ingest';
  const newBookId = makeBilingualBookId(entry);

  if (!isInDb) {
    // catalog 命中但未入库，emit route 提示前端要走 ingest
    sseEmit('route', {
      route: 'ingest',
      game: entry.zhName,
      dynIdStr: entry.dynIdStr,
      matchedBy,
      matchConfidence: confidence,
    });
  }

  // op_log: catalog hit (常驻日志，含 B站 URL 可点击)
  const opLog = {
    type: 'catalog_hit',
    game: entry.zhName || entry.enName || entry.fullTitle,
    matchedBy,
    confidence,
    inDb: isInDb,
  };
  if (entry.dynIdStr) {
    opLog.url = `https://t.bilibili.com/${entry.dynIdStr}`;
    opLog.dynIdStr = entry.dynIdStr;
  }
  sseEmit('op_log', opLog);

  logMetric({
    matchedBy, catalogStatus: status,
    latencyMs: Date.now() - t0,
    confidence,
    bookId: newBookId,
  });

  return {
    catalogEntry: entry,
    catalogStatus: status,
    bookIds: newBookId ? [newBookId] : [],
    matchedBy,
    matchConfidence: confidence,
  };
}

/**
 * 路由函数：N6 → N7 或 N2
 */
export function routeAfterCatalog(state) {
  if (state.catalogStatus === 'catalog_hit_need_ingest') return 'do_ingest';
  return 'hybrid_retrieve';
}
