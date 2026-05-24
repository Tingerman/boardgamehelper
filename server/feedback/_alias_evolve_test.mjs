// alias 自进化模块单测
//
// 覆盖：
//   - alias_staging: recordCandidate / aggregateStaging / markPromoted
//   - alias_promoter: promoteCycle 阈值过滤、跨命中检测、dryRun
//   - matcher: appendAlias 后 matchByAlias 立即生效；findGameByName 命中
//   - catalog/cache: loadAliasesExtra / saveAliasesExtra / setCatalog 合并
//
// 用临时文件路径覆盖默认的 staging / aliases_extra，避免污染真实数据。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}
function eq(a, b, name) {
  const okv = JSON.stringify(a) === JSON.stringify(b);
  if (okv) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n    expect:', b, '\n    actual:', a); }
}

// === 准备临时工作目录，让模块用本地路径 ===
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-evolve-test-'));
const tmpServer = path.join(tmpRoot, 'server');
fs.mkdirSync(path.join(tmpServer, 'data'), { recursive: true });
fs.mkdirSync(path.join(tmpServer, 'feedback'), { recursive: true });
const origCwd = process.cwd();
process.chdir(tmpRoot);

// === 1. catalog cache: aliases_extra 读写 ===
console.log('\n[catalog/cache] aliases_extra');
const cache = await import('../catalog/cache.mjs');
cache._resetForTest();

// 初始空
eq(cache.loadAliasesExtra(), {}, 'loadAliasesExtra: missing file → {}');

// 保存 + 重新加载
cache.saveAliasesExtra({ 'catan': ['卡坦', 'settlers'] });
const reloaded = cache.loadAliasesExtra();
eq(reloaded['catan'], ['卡坦', 'settlers'], 'saveAliasesExtra round-trip');

// setCatalog 把 aliases_extra 注入到对应 entry.aliases
cache.setCatalog([
  { dynIdStr: 'd1', zhName: '卡坦岛', enName: 'Catan', summary: 's1', ingested: false },
  { dynIdStr: 'd2', zhName: '其它游戏', enName: 'Other', summary: 's2', ingested: false },
]);
const catalog = cache.getCatalog();
const catanEntry = catalog.find(e => e.dynIdStr === 'd1');
const otherEntry = catalog.find(e => e.dynIdStr === 'd2');
// gameKey 是 zhName.toLowerCase = '卡坦岛'，与 'catan' 不匹配
ok(Array.isArray(catanEntry.aliases), 'catalog entry has aliases array');
eq(catanEntry.aliases, [], 'aliases miss when gameKey != map key');
// 把 map 改成正确 key
cache.saveAliasesExtra({ '卡坦岛': ['catan-alias-x'] });
cache.setCatalog([
  { dynIdStr: 'd1', zhName: '卡坦岛', enName: 'Catan', summary: 's1', ingested: false },
]);
eq(cache.getCatalog()[0].aliases, ['catan-alias-x'], 'setCatalog merges aliases_extra');

// === 2. alias_staging ===
console.log('\n[feedback/alias_staging]');
const staging = await import('./alias_staging.mjs');

// recordCandidate + aggregateStaging
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'catan', gameZhName: '卡坦', candidate: '卡坦', userQuery: 'q1', extra: {} });
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'catan', gameZhName: '卡坦', candidate: '卡坦', userQuery: 'q2', extra: {} });
staging.recordCandidate({ source: 'n5_user_correction', gameKey: 'catan', gameZhName: '卡坦', candidate: '卡坦', userQuery: 'q3', extra: {} });
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'tta', gameZhName: 'TTA', candidate: '历史巨轮', userQuery: 'q4', extra: {} });
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'tta', gameZhName: 'TTA', candidate: '骰子', userQuery: 'q5', extra: {} });
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'catan', gameZhName: '卡坦', candidate: '骰子', userQuery: 'q6', extra: {} });

const agg = staging.aggregateStaging();
const catanCard = agg.find(a => a.gameKey === 'catan' && a.candidate === '卡坦');
ok(catanCard && catanCard.count === 3, 'aggregate: 卡坦 count=3');
ok(catanCard && catanCard.distinctSources === 2, 'aggregate: 卡坦 distinctSources=2');
ok(!catanCard.alreadyPromoted, 'aggregate: 卡坦 not yet promoted');

// candidate 长度过短被拒
ok(!staging.recordCandidate({ source: 'x', gameKey: 'g', candidate: '' }), 'recordCandidate rejects empty');
ok(!staging.recordCandidate({ source: 'x', gameKey: 'g', candidate: '一' }), 'recordCandidate rejects len<2');

// markPromoted
staging.markPromoted('catan', '卡坦');
const agg2 = staging.aggregateStaging();
const catanCard2 = agg2.find(a => a.gameKey === 'catan' && a.candidate === '卡坦');
ok(catanCard2.alreadyPromoted, 'markPromoted reflected in aggregate');

// === 3. alias_promoter ===
console.log('\n[feedback/alias_promoter]');
// 设置 catalog cache，让 appendAlias 能找到 game
cache._resetForTest();
cache.saveAliasesExtra({});
cache.setCatalog([
  { dynIdStr: 'c-tta', zhName: 'Through the Ages', enName: 'TtA', summary: 's', ingested: false },
  { dynIdStr: 'c-catan', zhName: 'catan', enName: 'Catan', summary: 's', ingested: false },
]);
globalThis.__catalogCacheRef = cache;

const matcher = await import('../catalog/matcher.mjs');
matcher.setMatcherSources(null);

// 重写 staging 文件准备干净数据
fs.writeFileSync(staging._stagingPathForTest(), '');
// "历史巨轮" 命中 3 次，单一游戏 → 应升级
for (let i = 0; i < 3; i++) {
  staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'through the ages', candidate: '历史巨轮', userQuery: `q${i}`, extra: {} });
}
// "骰子" 跨游戏命中 → 应跳过
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'through the ages', candidate: '骰子', userQuery: 'q' });
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'through the ages', candidate: '骰子', userQuery: 'q' });
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'through the ages', candidate: '骰子', userQuery: 'q' });
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'catan', candidate: '骰子', userQuery: 'q' });
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'catan', candidate: '骰子', userQuery: 'q' });
staging.recordCandidate({ source: 'n6_llm_match', gameKey: 'catan', candidate: '骰子', userQuery: 'q' });

const promoter = await import('./alias_promoter.mjs');

// dryRun：不应落盘
const dr = await promoter.promoteCycle({ minCount: 3, minDistinctSources: 1, dryRun: true });
ok(dr.promoted.some(p => p.candidate === '历史巨轮'), 'dryRun promotes 历史巨轮');
ok(dr.skipped.some(s => s.candidate === '骰子' && s.reason.startsWith('cross_hit')), 'dryRun skips 骰子 (cross_hit)');
eq(cache.getAliasesExtraMap(), {}, 'dryRun did NOT write aliases_extra');

// 真升级
const real = await promoter.promoteCycle({ minCount: 3, minDistinctSources: 1, dryRun: false });
ok(real.promoted.some(p => p.candidate === '历史巨轮'), 'real promote: 历史巨轮');
ok(cache.getAliasesExtraMap()['through the ages']?.includes('历史巨轮'), 'aliases_extra written');
ok(matcher.matchByAlias('历史巨轮里腐败规则')?.entry?.zhName === 'Through the Ages', 'matchByAlias hits 历史巨轮 after promote');

// 二次跑：alreadyPromoted 跳过
const real2 = await promoter.promoteCycle({ minCount: 3, minDistinctSources: 1 });
ok(!real2.promoted.some(p => p.candidate === '历史巨轮'), 'second cycle skips already-promoted');

// === 4. matcher.findGameByName ===
console.log('\n[catalog/matcher] findGameByName');
const g1 = matcher.findGameByName('Through the Ages');
ok(g1 && g1.gameKey === 'through the ages', 'findGameByName: case-insensitive enName hit');
const g2 = matcher.findGameByName('  catan  ');
ok(g2 && g2.gameKey === 'catan', 'findGameByName: trim + zhName hit');
ok(matcher.findGameByName('不存在的游戏') === null, 'findGameByName: miss → null');
ok(matcher.findGameByName('') === null, 'findGameByName: empty → null');

// === 5. raw_feedback ===
console.log('\n[feedback/raw_feedback]');
const raw = await import('./raw_feedback.mjs');
fs.writeFileSync(raw._rawPathForTest(), '');
ok(raw.recordRawFeedback({ userQuery: '历史巨轮里腐败', userInput: '历史巨轮' }), 'recordRawFeedback ok');
ok(!raw.recordRawFeedback({ userQuery: '', userInput: 'x' }), 'recordRawFeedback rejects empty userQuery');
ok(!raw.recordRawFeedback({ userQuery: 'x', userInput: '' }), 'recordRawFeedback rejects empty userInput');
const all = raw.readAllRawFeedback();
ok(all.length === 1 && all[0].userInput === '历史巨轮', 'readAllRawFeedback returns recorded entry');
ok(all[0].reviewed === false, 'reviewed flag default false');

// 清理
process.chdir(origCwd);
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
