// N3 answerNode parseAnswerJson 单测
// node server/agent/nodes/_answer_test.mjs
import { parseAnswerJson } from './answer.mjs';

let pass = 0, fail = 0;
function eq(a, b, name) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n    expect:', b, '\n    actual:', a); }
}

console.log('\n[1] 合法 JSON');
eq(parseAnswerJson('{"answer":"A","citedChunks":[3,7]}'),
  { answer: 'A', citedChunks: [3, 7] }, '直接解析');

console.log('\n[2] markdown 代码块包裹');
eq(parseAnswerJson('```json\n{"answer":"hi","citedChunks":[1]}\n```'),
  { answer: 'hi', citedChunks: [1] }, '剥离 ```json');
eq(parseAnswerJson('```\n{"answer":"hi","citedChunks":[]}\n```'),
  { answer: 'hi', citedChunks: [] }, '剥离 ```');

console.log('\n[3] 前后带垃圾文本');
eq(parseAnswerJson('好的：{"answer":"答","citedChunks":[2]} 完毕。'),
  { answer: '答', citedChunks: [2] }, '夹杂解释文本');

console.log('\n[4] 非 JSON 退化');
eq(parseAnswerJson('就这样直接说答案'),
  { answer: '就这样直接说答案', citedChunks: [] }, '无 JSON 退化为纯文本 answer');

console.log('\n[5] JSON 但字段缺失');
eq(parseAnswerJson('{"foo":"bar"}'),
  { answer: '{"foo":"bar"}', citedChunks: [] }, 'answer 缺失 → 退化');

console.log('\n[6] citedChunks 类型/越界过滤');
eq(parseAnswerJson('{"answer":"A","citedChunks":[1,"x",-3,2.5,5]}', [1, 5]),
  { answer: 'A', citedChunks: [1, 5] }, '过滤非整数与越界');
eq(parseAnswerJson('{"answer":"A","citedChunks":[1,1,2]}', [1, 2]),
  { answer: 'A', citedChunks: [1, 2] }, '去重');

console.log('\n[7] citedChunks 不是数组');
eq(parseAnswerJson('{"answer":"A","citedChunks":"none"}'),
  { answer: 'A', citedChunks: [] }, '非数组退化为空');

console.log('\n[8] 空输入');
eq(parseAnswerJson(''),
  { answer: '', citedChunks: [] }, '空字符串');
eq(parseAnswerJson(null),
  { answer: '', citedChunks: [] }, 'null');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
