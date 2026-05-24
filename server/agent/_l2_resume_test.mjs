// l2-interrupt-resume 端到端测试
//
// 验证：
//   1. N4 永 partial → invokeAgent 返回 interrupted=true，附带 candidates
//   2. resumeAgent(threadId, {accept:true, dynIdStrs}) → mock ingest 写入新 bookId → 第二轮跑完 → l2Resumed=true
//   3. resumeAgent(threadId, {accept:false}) → 收到 partial answer，l2Resumed=false
//   4. 不传 threadId 的旧调用仍能跑（兼容兜底）
import { setDeps } from './deps.mjs';
import { invokeAgent, resumeAgent } from './graph.mjs';
import { _setAliasIndex } from '../catalog/matcher.mjs';
import * as catalogCache from '../catalog/cache.mjs';

// matcher 通过 globalThis.__catalogCacheRef 拿 catalog（避免循环 import）
globalThis.__catalogCacheRef = catalogCache;
const { setCatalog } = catalogCache;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

// === Mock RAG：让 N4 永远判 partial，触发 N8 ===
function makeFakeRag(extra = {}) {
  return {
    client: {
      async chat(messages) {
        const sys = messages.find(m => m.role === 'system')?.content || '';
        if (sys.includes('意图分类器')) return '{"intent":"rag"}';
        if (sys.includes('答案校验器')) return '{"verdict":"partial"}';
        return '{"answer":"mock partial answer","citedChunks":[0]}';
      },
    },
    async getEmbedding() { return [0.1, 0.2]; },
    cosineSimilarity() { return 0.9; },
    getDocuments() {
      return [{
        id: 'pdf-catan::0',
        pageContent: '卡坦岛简短规则',
        embedding: [0.1, 0.2],
        metadata: { bookId: 'pdf-catan', bookName: '卡坦岛', chunkIndex: 0 },
      }];
    },
    getBm25() { return null; },
    getBookMeta(id) {
      if (id === 'pdf-catan') return { zhName: '卡坦岛', enName: 'Catan' };
      return null;
    },
    books: { has: (id) => id === 'pdf-catan' || (extra.ingestedSet && extra.ingestedSet.has(id)) },
    ...extra,
  };
}

// 模拟 catalog 中有同游戏的 B站源未入库
const fakeCatalog = [
  { kind: 'in_db', bookId: 'pdf-catan', zhName: '卡坦岛', enName: 'Catan', summary: '骰子换资源' },
  { kind: 'catalog_only', dynIdStr: '999', zhName: '卡坦岛', enName: 'Catan', summary: '另一篇 B站文章' },
];

// === 1. invokeAgent → interrupt ===
console.log('\n[1] N4 partial 用尽 retry → 触发 interrupt');
{
  const ingestedSet = new Set();
  const fakeRag = makeFakeRag({ ingestedSet });
  setDeps({ rag: fakeRag });
  _setAliasIndex([
    { alias: '卡坦岛', entry: fakeCatalog[0], kind: 'in_db' },
    { alias: '卡坦岛-bili', entry: fakeCatalog[1], kind: 'catalog_only' },
  ]);
  setCatalog(fakeCatalog);

  const r = await invokeAgent('卡坦岛怎么换资源', {
    bookIds: ['pdf-catan'],
    threadId: 'test-thread-1',
  });
  ok(r.interrupted === true, 'invokeAgent 返回 interrupted=true');
  ok(r.threadId === 'test-thread-1', 'threadId 透传');
  ok(Array.isArray(r.candidates) && r.candidates.length === 1, '收到 1 个候选');
  ok(r.candidates[0].dynIdStr === '999', '候选 dynIdStr=999');
  ok(typeof r.partialAnswer === 'string', '附带 partialAnswer');
}

// === 2. resume skip 路径 ===
console.log('\n[2] resume accept=false → 收 partial、l2Resumed=false');
{
  const r = await resumeAgent('test-thread-1', { accept: false, dynIdStrs: [] }, {});
  ok(r.interrupted === false, 'resume 后非中断态');
  ok(r.l2Resumed === false, 'l2Resumed=false');
  ok(typeof r.answer === 'string', '有 answer（partial）');
}

// === 3. accept 路径：mock ingest 成功 ===
console.log('\n[3] resume accept=true → mock ingest → l2Resumed=true → 第二轮跑完');
{
  // 重新做一次 invoke 拿到新 thread（thread-1 已在 step 2 收口）
  const ingestedSet = new Set();
  const fakeRag = makeFakeRag({ ingestedSet });
  setDeps({ rag: fakeRag });
  _setAliasIndex([
    { alias: '卡坦岛', entry: fakeCatalog[0], kind: 'in_db' },
    { alias: '卡坦岛-bili', entry: fakeCatalog[1], kind: 'catalog_only' },
  ]);
  setCatalog(fakeCatalog);

  const r1 = await invokeAgent('卡坦岛怎么换资源', {
    bookIds: ['pdf-catan'],
    threadId: 'test-thread-2',
  });
  ok(r1.interrupted === true, 'thread-2 first invoke interrupted');

  // Mock ingestBilibiliByUrl：通过 deps 注入（ESM 模块属性只读）
  const mockIngest = async ({ url }) => {
    const m = url.match(/(\d+)/);
    const bookId = `bili-${m[1]}`;
    ingestedSet.add(bookId);
    return { ok: true, bookId };
  };
  setDeps({ rag: fakeRag, ingestBilibiliByUrl: mockIngest });

  try {
    const r2 = await resumeAgent('test-thread-2', { accept: true, dynIdStrs: ['999'] }, {});
    ok(r2.interrupted === false, 'resume 非中断');
    ok(r2.l2Resumed === true, 'l2Resumed=true');
    ok(Array.isArray(r2.bookIds) && r2.bookIds.includes('bili-999'), 'bookIds 已扩展含 bili-999');
  } finally {
    setDeps({ rag: fakeRag });
  }
}

// === 4. resume 不存在的 thread → session_expired ===
console.log('\n[4] resume 不存在的 threadId → session_expired');
{
  let caught = null;
  try {
    await resumeAgent('non-existent-thread', { accept: false, dynIdStrs: [] }, {});
  } catch (err) {
    caught = err;
  }
  ok(caught && caught.code === 'session_expired', 'throw session_expired');
}

// === 5. 兼容：不传 threadId 仍能跑（自动生成）===
console.log('\n[5] 不传 threadId 自动生成');
{
  // 让 N4 supported，避免触发 interrupt
  const fakeRag = makeFakeRag();
  fakeRag.client.chat = async (messages) => {
    const sys = messages.find(m => m.role === 'system')?.content || '';
    if (sys.includes('意图分类器')) return '{"intent":"rag"}';
    if (sys.includes('答案校验器')) return '{"verdict":"supported"}';
    return '{"answer":"ok","citedChunks":[]}';
  };
  setDeps({ rag: fakeRag });
  _setAliasIndex([]);
  setCatalog([]);

  const r = await invokeAgent('随便问', { bookIds: ['pdf-catan'] });
  ok(r.interrupted === false, '非中断态');
  ok(typeof r.threadId === 'string' && r.threadId.length > 0, '自动生成 threadId');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
