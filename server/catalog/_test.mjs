// catalog 模块单测
import { __test__ as bili } from './bilibili.mjs';
import { setCatalog, getCatalog, markIngested, reconcileIngestedFromRag, _resetForTest, getEntry } from './cache.mjs';

let pass = 0, fail = 0;
function eq(a, b, name) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n    expect:', b, '\n    actual:', a); }
}

// parseTitle
eq(bili.parseTitle('BGA桌游规则：大创造时代（Age of Innovation）'),
   { zhName: '大创造时代', enName: 'Age of Innovation' }, 'parseTitle full-width');
eq(bili.parseTitle('BGA桌游规则：Catan(卡坦岛)'),
   { zhName: 'Catan', enName: '卡坦岛' }, 'parseTitle half-width fallback');
eq(bili.parseTitle('随便一个标题'),
   { zhName: '随便一个标题', enName: null }, 'parseTitle no match');
eq(bili.parseTitle(''),
   { zhName: null, enName: null }, 'parseTitle empty');

// cache
_resetForTest();
setCatalog([
  { dynIdStr: '1', zhName: 'A', enName: 'a', summary: '', ingested: false },
  { dynIdStr: '2', zhName: 'B', enName: 'b', summary: '', ingested: false },
]);
eq(getCatalog().length, 2, 'setCatalog/getCatalog');
markIngested('1');
eq(getEntry('1').ingested, true, 'markIngested');
eq(getEntry('2').ingested, false, 'unmarked unchanged');

// reconcile
const fakeRag = {
  getBooks: () => [
    { id: 'pdf-foo' },
    { id: 'bili-2' },
    { id: 'bili-999' }, // 不在 catalog 里，忽略
  ],
};
const n = reconcileIngestedFromRag(fakeRag);
eq(n, 1, 'reconcile count');
eq(getEntry('2').ingested, true, 'reconcile mark');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
