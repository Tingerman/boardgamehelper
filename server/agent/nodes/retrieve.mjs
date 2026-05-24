// N2 hybrid_retrieve
//
// 召回 → 融合：
//   1) 节点内 Promise.all 并发跑 dense + BM25
//   2) RRF 按排名融合（rank-based，不依赖原始分数尺度）
//   3) 拼 context 给 N3，构造 sources 给前端
//
// 注：本期不做 rerank（后续效果优化 feature 接入 cross-encoder 或 Cohere rerank API）。
import { getDeps } from '../deps.mjs';

const TOPK_PER_RETRIEVER = 10;
const TOPK_FINAL = 5;
const RRF_K = 60; // 经验常数，论文推荐

/**
 * 稠密召回：复用现有 cosine 全量打分
 * @param {string[]} bookIds 空数组 = 全库；非空 = 仅命中其中任一 bookId 的 chunk
 */
async function denseRetrieve(question, bookIds, topK) {
  const { rag } = getDeps();
  const embedding = await rag.getEmbedding(question);

  let pool = rag.getDocuments();
  if (bookIds && bookIds.length > 0) {
    const set = new Set(bookIds);
    const filtered = pool.filter(d => set.has(d.metadata.bookId));
    if (filtered.length > 0) pool = filtered;
  }

  const scored = pool.map(doc => ({
    id: doc.id,
    score: rag.cosineSimilarity(embedding, doc.embedding),
    pageContent: doc.pageContent,
    metadata: doc.metadata,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * BM25 召回 → 关联 doc 详情
 */
async function bm25Retrieve(question, bookIds, topK) {
  const { rag } = getDeps();
  const bm25 = rag.getBm25();
  if (!bm25 || !bm25.ready()) return [];

  const docMap = new Map(rag.getDocuments().map(d => [d.id, d]));

  const filterActive = bookIds && bookIds.length > 0;
  const set = filterActive ? new Set(bookIds) : null;

  // 多召一些再 bookIds 过滤，避免过滤后空结果
  const raw = bm25.search(question, filterActive ? topK * 3 : topK);
  const enriched = [];
  for (const hit of raw) {
    const doc = docMap.get(hit.id);
    if (!doc) continue;
    if (filterActive && !set.has(doc.metadata.bookId)) continue;
    enriched.push({
      id: doc.id,
      score: hit.score,
      pageContent: doc.pageContent,
      metadata: doc.metadata,
    });
    if (enriched.length >= topK) break;
  }
  return enriched;
}

/**
 * RRF 融合
 *   score(d) = Σ_retriever  1 / (k + rank_in_that_retriever)
 * rank 从 0 起算，公式里 rank+1
 */
export function rrfMerge(hitsList, k = RRF_K, topK = TOPK_FINAL) {
  const accum = new Map(); // id -> { score, doc }
  for (const hits of hitsList) {
    hits.forEach((h, rank) => {
      const cur = accum.get(h.id);
      const inc = 1 / (k + rank + 1);
      if (cur) cur.score += inc;
      else accum.set(h.id, { score: inc, doc: h });
    });
  }
  return [...accum.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ score, doc }) => ({
      id: doc.id,
      score,
      pageContent: doc.pageContent,
      metadata: doc.metadata,
    }));
}

export async function hybridRetrieveNode(state) {
  const { question, bookIds } = state;

  const [denseHits, bm25Hits] = await Promise.all([
    denseRetrieve(question, bookIds, TOPK_PER_RETRIEVER),
    bm25Retrieve(question, bookIds, TOPK_PER_RETRIEVER),
  ]);

  const mergedHits = rrfMerge([denseHits, bm25Hits], RRF_K, TOPK_FINAL);
  // 给每段加 [chunk_N] 头，便于 N3 LLM 输出 citedChunks 时引用 chunkIndex
  const context = mergedHits
    .map(h => `[chunk_${h.metadata.chunkIndex}]\n${h.pageContent}`)
    .join('\n\n');

  // 按 bookId 缓存 book meta，避免重复查询
  const { rag } = getDeps();
  const bookMetaCache = new Map();
  const getMeta = (bid) => {
    if (!bookMetaCache.has(bid)) {
      bookMetaCache.set(bid, rag.getBookMeta?.(bid) || null);
    }
    return bookMetaCache.get(bid);
  };

  const sources = mergedHits.map(h => {
    const meta = getMeta(h.metadata.bookId);
    const src = {
      bookName: h.metadata.bookName,
      chunkIndex: h.metadata.chunkIndex,
      content: (h.pageContent || '').substring(0, 200) + '...',
      score: h.score.toFixed(4),
    };
    if (meta) {
      src.source = meta.source;
      // chunk 级 imageUrls：仅贴该 chunk 命中的图（imageIndices 反查）
      const allImages = (meta.sourceMeta && meta.sourceMeta.imageUrls) || null;
      const idxs = h.metadata.imageIndices || [];
      if (allImages && idxs.length > 0) {
        src.imageUrls = idxs
          .map(i => allImages[i])
          .filter(Boolean);
      }
      // 保留 dynIdStr / articleId 给前端构造源链接，但不再下发整篇 imageUrls 数组
      if (meta.sourceMeta) {
        const { imageUrls: _omit, ...restSourceMeta } = meta.sourceMeta;
        src.sourceMeta = restSourceMeta;
      }
    }
    return src;
  });

  return { bm25Hits, denseHits, mergedHits, context, sources };
}
