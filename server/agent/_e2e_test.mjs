// 端到端结构性 sanity（不调真外部 API）
//
// 验证：
//   - graph 编译成功 + SSE emit 在 N6 命中 catalog_only 时被调用
//   - bookId 透传 → user_specified_book
//   - LLM 兜底命中（mock chat 返回 index=1）

import { setDeps } from './deps.mjs';
import { invokeAgent } from './graph.mjs';
import { _setAliasIndex } from '../catalog/matcher.mjs';
import { setCatalog } from '../catalog/cache.mjs';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

const fakeRag = {
  client: {
    async chat(messages) {
      const sys = messages.find(m => m.role === 'system')?.content || '';
      const user = messages.find(m => m.role === 'user')?.content || '';
      if (sys.includes('意图分类器')) return '{"intent":"rag"}';
      if (sys.includes('答案校验器')) return '{"verdict":"supported"}';
      // matcher Layer 2 / answer 都是 user-only 单条
      if (user.includes('候选桌游列表')) return '{"index":1,"confidence":0.9,"reason":"x"}';
      return 'mock answer';
    },
  },
  async getEmbedding() { return [0.1, 0.2, 0.3, 0.4]; },
  cosineSimilarity() { return 0.9; },
  getDocuments() {
    return [{
      id: 'pdf-catan::0',
      pageContent: '卡坦岛规则示例',
      embedding: [0.1, 0.2, 0.3, 0.4],
      metadata: { bookId: 'pdf-catan', bookName: '卡坦岛', chunkIndex: 0 },
    }];
  },
  getBm25() { return null; },
};
setDeps({ rag: fakeRag });

// === 1. user_specified bookIds → 跳过 N6，直接进 retrieve ===
{
  _setAliasIndex([]);
  setCatalog([]);
  const r = await invokeAgent('随便问', { bookIds: ['pdf-catan'] });
  ok(Array.isArray(r.bookIds) && r.bookIds[0] === 'pdf-catan', 'bookIds 透传');
  ok(r.catalogStatus !== 'catalog_hit_need_ingest', '已跳过 N6 ingest 路径');
  ok(typeof r.answer === 'string', '产出 answer');
}

// === 2. L1 catalog_only → 触发 SSE route 事件 + 退化为 no_match（因为 N7 真调爬虫会抛 fetch 错） ===
{
  _setAliasIndex([{
    alias: '大创造时代',
    entry: { kind: 'catalog_only', dynIdStr: 'fake-dyn', zhName: '大创造时代', enName: 'AoI', summary: 's' },
    kind: 'catalog_only',
  }]);
  const events = [];
  const r = await invokeAgent('大创造时代怎么计分', {
    sseEmit: (event, data) => events.push({ event, data }),
  });
  // route 应被 emit；之后 N7 真调 fetch 会失败，emit error，退化为 no_match → 走 N2 兜底
  const hasRoute = events.some(e => e.event === 'route');
  ok(hasRoute, 'sseEmit route after L1 catalog_only hit');
  // 错误事件应该有
  const hasError = events.some(e => e.event === 'error');
  ok(hasError, 'N7 fetch failure emits error');
  // 最终仍应跑完图（degraded path）
  ok(typeof r.answer === 'string', 'graph completes despite N7 failure');
}

// === 3. L1 in_db ===
{
  _setAliasIndex([{
    alias: '卡坦岛',
    entry: { kind: 'in_db', bookId: 'pdf-catan', zhName: '卡坦岛', enName: 'Catan', summary: 's' },
    kind: 'in_db',
  }]);
  const events = [];
  const r = await invokeAgent('卡坦岛怎么换资源', {
    sseEmit: (event, data) => events.push({ event, data }),
  });
  ok(r.catalogStatus === 'catalog_hit_already_in_db', 'L1 in_db status');
  ok(r.bookIds && r.bookIds[0] === 'pdf-catan', 'L1 in_db bookId');
  ok(events.length === 1 && events[0].event === 'op_log', 'in_db emits only op_log');
}

// === 4. all miss → no_match → 走全库 ===
{
  _setAliasIndex([]);
  const r = await invokeAgent('完全无关的桌游');
  ok(r.catalogStatus === 'no_match', 'all miss status');
  ok(Array.isArray(r.bookIds) && r.bookIds.length === 0, 'no_match bookIds empty');
  ok(typeof r.answer === 'string' && r.answer.length > 0, 'still produces answer via full-corpus retrieve');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
