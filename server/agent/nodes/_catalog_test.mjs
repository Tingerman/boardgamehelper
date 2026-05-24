// N6 catalog_check 节点单测
//
// mock：getDeps + matcher 模块状态
import { setDeps } from '../deps.mjs';
import { catalogCheckNode, routeAfterCatalog } from './catalog.mjs';
import { _setAliasIndex } from '../../catalog/matcher.mjs';

let pass = 0, fail = 0;
function eq(a, b, name) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n    expect:', b, '\n    actual:', a); }
}

const mockChat = async () => '{"index":1,"picked_zh_name":"卡坦岛","picked_en_name":"Catan","confidence":0.9,"reason":"x"}';
setDeps({ rag: { client: { chat: mockChat } } });

// === 0. user_specified ===
{
  _setAliasIndex([]);
  const r = await catalogCheckNode({ question: 'x', bookIds: ['pdf-foo'] }, {});
  eq(r.catalogStatus, 'user_specified_book', 'user_specified status');
  eq(r.matchedBy, 'user_specified', 'user_specified matchedBy');
  eq(r.bookIds, ['pdf-foo'], 'user_specified bookIds');
}

// === 1. Layer 1 hit catalog_only ===
{
  _setAliasIndex([{
    alias: '大创造时代',
    entry: { kind: 'catalog_only', dynIdStr: '1031', zhName: '大创造时代', enName: 'AoI', summary: 's' },
    kind: 'catalog_only',
  }]);
  const events = [];
  const r = await catalogCheckNode(
    { question: '大创造时代怎么计分', bookIds: [] },
    { configurable: { sseEmit: (event, data) => events.push({ event, data }) } }
  );
  eq(r.catalogStatus, 'catalog_hit_need_ingest', 'L1 hit catalog_only status');
  eq(r.bookIds, ['bili-1031'], 'L1 hit catalog_only bookIds');
  eq(r.matchedBy, 'alias_exact', 'L1 matchedBy');
  eq(r.matchConfidence, 1, 'L1 confidence=1');
  eq(events.length, 2, 'sseEmit twice (route+op_log)');
  eq(events[0].event, 'route', 'sseEmit route');
  eq(events[1].event, 'op_log', 'sseEmit op_log');
}

// === 2. Layer 1 hit in_db ===
{
  _setAliasIndex([{
    alias: '卡坦岛',
    entry: { kind: 'in_db', bookId: 'pdf-catan', zhName: '卡坦岛', enName: 'Catan', summary: 's' },
    kind: 'in_db',
  }]);
  const events = [];
  const r = await catalogCheckNode(
    { question: '卡坦岛怎么换资源', bookIds: [] },
    { configurable: { sseEmit: (e, d) => events.push({ e, d }) } }
  );
  eq(r.catalogStatus, 'catalog_hit_already_in_db', 'L1 hit in_db status');
  eq(r.bookIds, ['pdf-catan'], 'L1 hit in_db bookIds');
  eq(events.length, 1, 'in_db no route, only op_log');
  eq(events[0].e, 'op_log', 'op_log emitted for in_db hit');
}

// === 3. Layer 1 miss + Layer 2 hit ===
{
  _setAliasIndex([{
    alias: '卡坦岛',
    entry: { kind: 'in_db', bookId: 'pdf-catan', zhName: '卡坦岛', enName: 'Catan', summary: '骰子换资源德式' },
    kind: 'in_db',
  }]);
  const r = await catalogCheckNode(
    { question: '那个有骰子换资源的游戏', bookIds: [] },
    {}
  );
  eq(r.catalogStatus, 'catalog_hit_already_in_db', 'L2 hit in_db');
  eq(r.matchedBy, 'llm_intro', 'L2 matchedBy');
  eq(r.matchConfidence, 0.9, 'L2 confidence');
}

// === 4. all miss ===
{
  _setAliasIndex([{
    alias: '卡坦岛',
    entry: { kind: 'in_db', bookId: 'pdf-catan', zhName: '卡坦岛', enName: 'Catan', summary: 'a game' },
    kind: 'in_db',
  }]);
  // 让 LLM 返回 index=null
  setDeps({ rag: { client: { chat: async () => '{"index":null,"confidence":0.1}' } } });
  const r = await catalogCheckNode({ question: '三国杀', bookIds: [] }, {});
  eq(r.catalogStatus, 'no_match', 'no_match status');
  eq(r.matchedBy, null, 'no_match matchedBy');
}

// === 5. LLM error degrade ===
{
  _setAliasIndex([{
    alias: '卡坦岛',
    entry: { kind: 'in_db', bookId: 'pdf-catan', zhName: '卡坦岛', enName: 'Catan', summary: 'a game' },
    kind: 'in_db',
  }]);
  setDeps({ rag: { client: { chat: async () => { throw new Error('boom'); } } } });
  const r = await catalogCheckNode({ question: '随便聊', bookIds: [] }, {});
  eq(r.catalogStatus, 'no_match', 'LLM error → no_match');
}

// === 6. routing ===
eq(routeAfterCatalog({ catalogStatus: 'catalog_hit_need_ingest' }), 'do_ingest', 'route → ingest');
eq(routeAfterCatalog({ catalogStatus: 'catalog_hit_already_in_db' }), 'hybrid_retrieve', 'route → retrieve (in_db)');
eq(routeAfterCatalog({ catalogStatus: 'no_match' }), 'hybrid_retrieve', 'route → retrieve (miss)');
eq(routeAfterCatalog({ catalogStatus: 'user_specified_book' }), 'hybrid_retrieve', 'route → retrieve (user)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
