// Agent State 定义
//
// 字段分组：
//  - 输入：question / bookId
//  - N1 输出：intent
//  - N2 输出：bm25Hits / denseHits / mergedHits / context / sources
//  - N3 / N4 输出：answer / faithfulness
//  - 循环控制：retryCount（累加 reducer，每次 N4 判 retry 时 +1）
import { Annotation } from '@langchain/langgraph';

/**
 * @typedef {Object} RetrievalHit
 * @property {string} id           - chunk 唯一标识
 * @property {number} score        - 原始分数（cosine 或 BM25）
 * @property {string} pageContent  - chunk 文本内容
 * @property {Object} metadata     - bookId / bookName / chunkIndex
 */

/**
 * @typedef {Object} Source
 * @property {string} bookName
 * @property {number} chunkIndex
 * @property {string} content   - 截断展示用
 * @property {string} score     - 字符串化 RRF 分数
 */

export const StateAnnotation = Annotation.Root({
  // ----- 输入 -----
  question: Annotation(),
  // bookIds：用户在前端多选锁定的源；空数组 = 全库模式（走 N6 catalog matching）
  bookIds: Annotation({
    default: () => [],
    reducer: (_curr, next) => Array.isArray(next) ? next : [],
  }),

  // ----- N1 -----
  // 'rag' | 'off_topic' | 'greeting'
  intent: Annotation({
    default: () => null,
    reducer: (_curr, next) => next,
  }),

  // ----- N6 catalog_check -----
  // 'catalog_hit_need_ingest' | 'catalog_hit_already_in_db' | 'user_specified_book' | 'no_match'
  catalogStatus: Annotation({
    default: () => null,
    reducer: (_curr, next) => next,
  }),
  catalogEntry: Annotation({
    default: () => null,
    reducer: (_curr, next) => next,
  }),
  // 'alias_exact' | 'llm_intro' | 'user_specified' | null
  matchedBy: Annotation({
    default: () => null,
    reducer: (_curr, next) => next,
  }),
  matchConfidence: Annotation({
    default: () => null,
    reducer: (_curr, next) => next,
  }),

  // ----- N7 ingest_pipeline -----
  ingestResult: Annotation({
    default: () => null,
    reducer: (_curr, next) => next,
  }),

  // ----- N2 -----
  bm25Hits: Annotation({
    default: () => [],
    reducer: (_curr, next) => next ?? [],
  }),
  denseHits: Annotation({
    default: () => [],
    reducer: (_curr, next) => next ?? [],
  }),
  mergedHits: Annotation({
    default: () => [],
    reducer: (_curr, next) => next ?? [],
  }),
  context: Annotation({
    default: () => '',
    reducer: (_curr, next) => next ?? '',
  }),
  sources: Annotation({
    default: () => [],
    reducer: (_curr, next) => next ?? [],
  }),

  // ----- N8 catalog_probe -----
  // 当 N4 retry 用尽仍 partial/unsupported 时，N8 反查同游戏未 ingest 的 B站源
  l2Candidates: Annotation({
    default: () => [],
    reducer: (_curr, next) => Array.isArray(next) ? next : [],
  }),
  // L2 升级后 resume 标记：true 表示 N8 已用用户选中的源补抓并要回 N2 重检索；
  // routeAfterFaithfulness 据此短路，避免二次进 N8
  l2Resumed: Annotation({
    default: () => false,
    reducer: (_curr, next) => next === true,
  }),

  // ----- N3 / N4 -----
  answer: Annotation({
    default: () => '',
    reducer: (_curr, next) => next ?? '',
  }),
  // N3 输出：LLM 显式标注引用了哪些 chunkIndex（用于 sources 重排序）
  citedChunks: Annotation({
    default: () => [],
    reducer: (_curr, next) => next ?? [],
  }),
  // 'supported' | 'partial' | 'unsupported' | null
  faithfulness: Annotation({
    default: () => null,
    reducer: (_curr, next) => next,
  }),

  // ----- 循环控制 -----
  // 累加 reducer：N4 判 retry 时 return { retryCount: 1 } 即可累计
  retryCount: Annotation({
    default: () => 0,
    reducer: (curr, add) => (curr ?? 0) + (add ?? 0),
  }),
});
