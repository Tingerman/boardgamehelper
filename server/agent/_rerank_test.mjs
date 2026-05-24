// rerankSourcesByCitation 单测
// node server/agent/_rerank_test.mjs
import { rerankSourcesByCitation } from './graph.mjs';

let pass = 0, fail = 0;
function eq(a, b, name) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n    expect:', b, '\n    actual:', a); }
}

const sources = [
  { chunkIndex: 3, score: '0.9000' },
  { chunkIndex: 26, score: '0.5000' },
  { chunkIndex: 7, score: '0.7000' },
  { chunkIndex: 12, score: '0.6000' },
];

console.log('\n[1] cited 排前 + 内部按 score');
const r1 = rerankSourcesByCitation(sources, [26, 12]);
eq(r1.map(s => s.chunkIndex), [12, 26, 3, 7], '12(0.6)、26(0.5) 排前；非引用按 score 排');
eq(r1.filter(s => s.cited).map(s => s.chunkIndex), [12, 26], 'cited 标记正确');

console.log('\n[2] 无 cited 时退化为 score 排序');
const r2 = rerankSourcesByCitation(sources, []);
eq(r2.map(s => s.chunkIndex), [3, 7, 12, 26], '按 score 降序');
eq(r2.every(s => !s.cited), true, '全部 cited=false');

console.log('\n[3] cited 全击中时不变相对 score 顺序');
const r3 = rerankSourcesByCitation(sources, [3, 7, 12, 26]);
eq(r3.map(s => s.chunkIndex), [3, 7, 12, 26], '全 cited 按 score');

console.log('\n[4] 空输入');
eq(rerankSourcesByCitation([], [1]), [], '空 sources');
eq(rerankSourcesByCitation(null, [1]), [], 'null sources');

console.log('\n[5] citedChunks 非数组');
const r5 = rerankSourcesByCitation(sources, null);
eq(r5.map(s => s.chunkIndex), [3, 7, 12, 26], '退化为 score 排序');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
