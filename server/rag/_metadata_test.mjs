// metadata 抽取单测（mock chatFn）
//
// 运行：node server/rag/_metadata_test.mjs
import { extractBookMetadata, extractSummary } from './metadata.mjs';

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n    expect:', expected, '\n    actual:', actual); }
}

// 1. 正常返回
{
  const chat = async () => '{"zhName":"卡坦岛","enName":"Catan","summary":"骰子换资源的德式策略游戏"}';
  const r = await extractBookMetadata(chat, 'foo bar');
  eq(r, { zhName: '卡坦岛', enName: 'Catan', summary: '骰子换资源的德式策略游戏' }, 'normal JSON');
}

// 2. markdown 围栏
{
  const chat = async () => '```json\n{"zhName":"a","enName":"b","summary":"c"}\n```';
  const r = await extractBookMetadata(chat, 'x');
  eq(r.zhName, 'a', 'markdown fence parse');
}

// 3. JSON 解析失败 → fallback
{
  const chat = async () => 'not json at all';
  const r = await extractBookMetadata(chat, 'x', { fallbackZhName: 'fb' });
  eq(r, { zhName: 'fb', enName: null, summary: '' }, 'parse failure fallback');
}

// 4. LLM 抛错 → fallback
{
  const chat = async () => { throw new Error('boom'); };
  const r = await extractBookMetadata(chat, 'x', { fallbackZhName: 'fb' });
  eq(r, { zhName: 'fb', enName: null, summary: '' }, 'LLM error fallback');
}

// 5. 超时 → fallback
{
  const chat = () => new Promise(r => setTimeout(() => r('{}'), 200));
  const r = await extractBookMetadata(chat, 'x', { fallbackZhName: 'fb', timeoutMs: 50 });
  eq(r.zhName, 'fb', 'timeout fallback');
}

// 6. 空文本短路
{
  const chat = async () => { throw new Error('should not call'); };
  const r = await extractBookMetadata(chat, '', { fallbackZhName: 'fb' });
  eq(r, { zhName: 'fb', enName: null, summary: '' }, 'empty headText short-circuit');
}

// 7. 字段空字符串视作 null
{
  const chat = async () => '{"zhName":"  ","enName":"","summary":""}';
  const r = await extractBookMetadata(chat, 'x', { fallbackZhName: 'fb' });
  eq(r, { zhName: 'fb', enName: null, summary: '' }, 'empty fields treated as null');
}

// 8. extractSummary 正常
{
  const chat = async () => '一句话简介';
  const r = await extractSummary(chat, 'x');
  eq(r, '一句话简介', 'extractSummary normal');
}

// 9. extractSummary 引号去除
{
  const chat = async () => '"带引号的简介"';
  const r = await extractSummary(chat, 'x');
  eq(r, '带引号的简介', 'extractSummary strips quotes');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
