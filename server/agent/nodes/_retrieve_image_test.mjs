// retrieve 节点 chunk 级 imageUrls 单测
// node server/agent/nodes/_retrieve_image_test.mjs
import { setDeps } from '../deps.mjs';
import { hybridRetrieveNode } from './retrieve.mjs';

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

// 构造一个最小的 rag mock：3 个 chunk，分别命中不同 imageIndices
const docs = [
  {
    id: 'b1::0', pageContent: 'chunk0 文本', embedding: [1, 0, 0],
    metadata: { bookId: 'b1', bookName: '书1', chunkIndex: 0, imageIndices: [] },
  },
  {
    id: 'b1::1', pageContent: 'chunk1 命中第二张图', embedding: [0.9, 0.1, 0],
    metadata: { bookId: 'b1', bookName: '书1', chunkIndex: 1, imageIndices: [1] },
  },
  {
    id: 'b1::2', pageContent: 'chunk2 跨第二三张图', embedding: [0.8, 0.2, 0],
    metadata: { bookId: 'b1', bookName: '书1', chunkIndex: 2, imageIndices: [1, 2] },
  },
];

setDeps({
  rag: {
    getEmbedding: async () => [1, 0, 0],
    getDocuments: () => docs,
    cosineSimilarity: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    getBm25: () => null,
    getBookMeta: (id) => id === 'b1' ? {
      source: 'bilibili',
      sourceMeta: {
        dynIdStr: 'XX',
        articleId: 999,
        imageUrls: ['img0.jpg', 'img1.jpg', 'img2.jpg', 'img3.jpg'],
      },
    } : null,
  },
});

const out = await hybridRetrieveNode({ question: 'q', bookIds: ['b1'] });

console.log('\n[1] sources 字段结构');
assert(Array.isArray(out.sources), 'sources 是数组');
assert(out.sources.length === 3, 'sources 长度 3');

console.log('\n[2] chunk 级 imageUrls 反查');
const byIdx = Object.fromEntries(out.sources.map(s => [s.chunkIndex, s]));
assert(!byIdx[0].imageUrls, 'chunk0 无 imageIndices → 无 imageUrls 字段');
assert(JSON.stringify(byIdx[1].imageUrls) === '["img1.jpg"]', 'chunk1 → 仅 img1');
assert(JSON.stringify(byIdx[2].imageUrls) === '["img1.jpg","img2.jpg"]', 'chunk2 → img1+img2');

console.log('\n[3] sourceMeta 不再含 imageUrls 全数组');
const s = out.sources[0];
assert(s.sourceMeta && !('imageUrls' in s.sourceMeta), 'sourceMeta.imageUrls 已剥离');
assert(s.sourceMeta.dynIdStr === 'XX', 'sourceMeta.dynIdStr 保留');
assert(s.sourceMeta.articleId === 999, 'sourceMeta.articleId 保留');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
