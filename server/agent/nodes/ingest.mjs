// N7 ingest_pipeline 节点
//
// 该节点是 LangGraph state 适配层，真实流水线在 server/ingest/bilibili-pipeline.mjs。
// 这里只负责：
//   1. 从 state.catalogEntry 提取参数
//   2. 调用共享 ingestFromBilibiliOpus
//   3. 将结果回填到 state（catalogStatus / ingestResult / bookIds）

import { getDeps } from '../deps.mjs';
import { ingestFromBilibiliOpus, _inflightSet } from '../../ingest/bilibili-pipeline.mjs';

export async function ingestNode(state, config) {
  const { catalogEntry } = state;
  const sseEmit = config?.configurable?.sseEmit ?? (() => {});

  if (!catalogEntry || !catalogEntry.dynIdStr) {
    sseEmit('error', { code: 'invalid_catalog_entry' });
    return { catalogStatus: 'no_match', ingestResult: null };
  }

  const { rag, cacheDir } = getDeps();

  const defaultMeta = (catalogEntry.zhName || catalogEntry.enName || catalogEntry.summary)
    ? {
        zhName: catalogEntry.zhName || null,
        enName: catalogEntry.enName || null,
        summary: catalogEntry.summary || '',
      }
    : null;

  const result = await ingestFromBilibiliOpus({
    dynIdStr: catalogEntry.dynIdStr,
    manualMeta: null, // N7 自动触发场景没有用户手输
    defaultMeta,
    sseEmit,
    rag,
    cacheDir,
    articleId: catalogEntry.articleId || null,
    fullTitle: catalogEntry.fullTitle || null,
  });

  if (!result.ok) {
    return { catalogStatus: 'no_match', ingestResult: null };
  }

  return {
    ingestResult: { bookId: result.bookId, chunks: result.chunks, durationMs: result.durationMs || 0 },
    // 把 N7 抓回的新源加入 bookIds，供下游 N2 retrieve 精确召回
    bookIds: [result.bookId],
  };
}

// 兼容老测试导出
export { _inflightSet };
