// matcher 单测
import { matchByAlias, matchByLlmIntro, buildCandidatePool, _setAliasIndex } from './matcher.mjs';

let pass = 0, fail = 0;
function eq(a, b, name) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n    expect:', b, '\n    actual:', a); }
}
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

// === Layer 1 ===
const idx = [
  { alias: 'age of innovation', entry: { kind: 'catalog_only', dynIdStr: '1', zhName: '大创造时代', enName: 'Age of Innovation', summary: 's1' }, kind: 'catalog_only' },
  { alias: '大创造时代', entry: { kind: 'catalog_only', dynIdStr: '1', zhName: '大创造时代', enName: 'Age of Innovation', summary: 's1' }, kind: 'catalog_only' },
  { alias: '卡坦岛', entry: { kind: 'in_db', bookId: 'pdf-catan', zhName: '卡坦岛', enName: 'Catan', summary: '骰子换资源' }, kind: 'in_db' },
  { alias: 'catan', entry: { kind: 'in_db', bookId: 'pdf-catan', zhName: '卡坦岛', enName: 'Catan', summary: '骰子换资源' }, kind: 'in_db' },
];
// 长度降序
idx.sort((a, b) => b.alias.length - a.alias.length);
_setAliasIndex(idx);

eq(matchByAlias('大创造时代怎么计分').entry.dynIdStr, '1', 'L1 zh hit');
eq(matchByAlias('Age of Innovation rules').entry.dynIdStr, '1', 'L1 en hit case-insensitive');
eq(matchByAlias('卡坦岛怎么换资源').entry.bookId, 'pdf-catan', 'L1 in_db hit');
eq(matchByAlias('随便聊聊'), null, 'L1 miss');
eq(matchByAlias(''), null, 'L1 empty query');

// 长度降序：query 同时含两个 alias 时取最长
_setAliasIndex([
  { alias: 'a', entry: { id: 1 }, kind: 'in_db' },
  { alias: 'abc', entry: { id: 2 }, kind: 'in_db' },
].sort((x, y) => y.alias.length - x.alias.length));
eq(matchByAlias('xxx abc yyy').entry.id, 2, 'L1 longest first');

// === Layer 2 ===
const candidates = [
  { kind: 'in_db', bookId: 'pdf-catan', zhName: '卡坦岛', enName: 'Catan', summary: '骰子、资源交换、扩张定居点的德式策略游戏' },
  { kind: 'in_db', bookId: 'pdf-brass', zhName: '工业革命', enName: 'Brass', summary: '工业网络建设的英国主题游戏' },
];

// 1. 命中 confidence ok
{
  const chat = async () => '{"index":1,"picked_zh_name":"卡坦岛","picked_en_name":"Catan","confidence":0.9,"reason":"骰子换资源是卡坦岛的核心机制"}';
  const r = await matchByLlmIntro(chat, '那个有骰子换资源的德式游戏怎么算分', candidates, { threshold: 0.7 });
  eq(r.entry.bookId, 'pdf-catan', 'L2 hit');
  ok(r.confidence === 0.9, 'L2 confidence passed through');
}

// 2. confidence 不达标
{
  const chat = async () => '{"index":1,"picked_zh_name":"卡坦岛","picked_en_name":"Catan","confidence":0.4,"reason":"不太确定"}';
  const r = await matchByLlmIntro(chat, '一个有骰子的游戏', candidates, { threshold: 0.7 });
  ok(r && r.belowThreshold === true, 'L2 below threshold flagged');
  eq(r.entry, null, 'L2 below threshold returns null entry');
}

// 3. index null
{
  const chat = async () => '{"index":null,"confidence":0.1,"reason":"不在候选里"}';
  const r = await matchByLlmIntro(chat, '三国杀', candidates);
  eq(r, null, 'L2 index null');
}

// 4. LLM 抛错
{
  const chat = async () => { throw new Error('boom'); };
  const r = await matchByLlmIntro(chat, '随便', candidates);
  eq(r, null, 'L2 LLM error');
}

// 5. 超时
{
  const chat = () => new Promise(r => setTimeout(() => r('{}'), 200));
  const r = await matchByLlmIntro(chat, 'x', candidates, { timeoutMs: 50 });
  eq(r, null, 'L2 timeout');
}

// 6. 候选池为空
{
  const r = await matchByLlmIntro(async () => 'never', 'x', []);
  eq(r, null, 'L2 empty pool short-circuit');
}

// 7. JSON 解析失败
{
  const chat = async () => 'garbage output';
  const r = await matchByLlmIntro(chat, 'x', candidates);
  eq(r, null, 'L2 parse fail');
}

// 8. index 越界
{
  const chat = async () => '{"index":99,"confidence":0.99}';
  const r = await matchByLlmIntro(chat, 'x', candidates);
  eq(r, null, 'L2 index out of range');
}

// 9. 幻觉防护：picked_zh/en_name 与 candidates[index] 不一致 → drop
{
  const chat = async () => '{"index":1,"picked_zh_name":"三国杀","picked_en_name":"Sanguosha","confidence":1,"reason":"三国杀在索引1"}';
  const r = await matchByLlmIntro(chat, '三国杀几个人玩', candidates);
  eq(r, null, 'L2 hallucination guard drops mismatched picked_name');
}

// 10. 幻觉防护：picked_*_name 全空 → drop（防止 LLM 偷懒不填）
{
  const chat = async () => '{"index":1,"picked_zh_name":null,"picked_en_name":null,"confidence":0.9}';
  const r = await matchByLlmIntro(chat, '一个游戏', candidates);
  eq(r, null, 'L2 guard rejects all-null picked_name');
}

// 11. 幻觉防护：只有英文名匹配也算通过
{
  const chat = async () => '{"index":1,"picked_zh_name":"乱填","picked_en_name":"Catan","confidence":0.9,"reason":"x"}';
  const r = await matchByLlmIntro(chat, 'catan rules', candidates);
  // zhName 不一致 → 整体 drop（更严格）
  eq(r, null, 'L2 guard requires both zh and en consistent');
}

// === buildCandidatePool ===
_setAliasIndex([
  { alias: 'a', entry: { kind: 'in_db', bookId: 'b1', summary: 's' }, kind: 'in_db' },
  { alias: 'a-en', entry: { kind: 'in_db', bookId: 'b1', summary: 's' }, kind: 'in_db' }, // 同一 entry 不同 alias，去重
  { alias: 'c', entry: { kind: 'catalog_only', dynIdStr: '2', summary: 'c' }, kind: 'catalog_only' },
  { alias: 'd', entry: { kind: 'in_db', bookId: 'b3', summary: '' }, kind: 'in_db' }, // 无 summary 也无 zhName 应被过滤
  { alias: 'e', entry: { kind: 'in_db', bookId: 'b4', zhName: 'E', summary: '' }, kind: 'in_db' }, // 有 zhName 应保留
]);
const pool = buildCandidatePool();
eq(pool.length, 3, 'pool dedup + filter');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
