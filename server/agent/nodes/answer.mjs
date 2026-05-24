// N3 answer
//
// 基于 N2 检索来的 context 生成答案。
// 要求 LLM 输出严格 JSON：{ answer: string, citedChunks: number[] }
// citedChunks 表示答案真实引用的 chunk 编号（context 中的 [chunk_N]），
// 后续节点据此重排 sources（让"真正贡献答案的源"排在前面）。
import { getDeps } from '../deps.mjs';

const SYSTEM_PROMPT = [
  '你是桌游规则问答助手。',
  '上下文每段以 [chunk_N] 编号开头。请严格基于这些上下文用中文简洁、准确地回答用户问题。',
  '若上下文没有答案，answer 字段填"资料中未提及"，citedChunks 留空数组。',
  '',
  '【输出格式 - 必须严格遵守】只输出 JSON，不要任何解释、不要 markdown 代码块包裹：',
  '{"answer":"你的回答","citedChunks":[3,7]}',
  '其中 citedChunks 是你在生成 answer 时实际引用过的 chunk 编号数组（取自 [chunk_N] 中的 N），允许为空。',
].join('\n');

/**
 * 解析 LLM 输出。容错：
 *  - 去掉 ```json ... ``` 包裹
 *  - 找首个 { 和最后一个 }
 *  - JSON 失败 → 退化（answer = 原文，citedChunks = []）
 *  - citedChunks 越界 / 非数字过滤掉
 */
export function parseAnswerJson(raw, validChunkIndices = null) {
  if (typeof raw !== 'string') return { answer: String(raw || ''), citedChunks: [] };
  let s = raw.trim();
  // 去 markdown 代码块
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // 提取首个 JSON 对象
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { answer: raw.trim(), citedChunks: [] };
  }
  const slice = s.slice(start, end + 1);
  let obj;
  try { obj = JSON.parse(slice); } catch {
    return { answer: raw.trim(), citedChunks: [] };
  }
  const answer = typeof obj.answer === 'string' ? obj.answer : raw.trim();
  let cited = Array.isArray(obj.citedChunks) ? obj.citedChunks : [];
  cited = cited
    .map(n => Number(n))
    .filter(n => Number.isInteger(n) && n >= 0);
  if (validChunkIndices) {
    const valid = new Set(validChunkIndices);
    cited = cited.filter(n => valid.has(n));
  }
  // 去重
  cited = Array.from(new Set(cited));
  return { answer, citedChunks: cited };
}

export async function answerNode(state) {
  const { rag } = getDeps();
  const { question, context, retryCount, mergedHits } = state;

  const userContent = `规则书上下文：\n${context || '（无相关上下文）'}\n\n问题：${question}` +
    (retryCount > 0
      ? `\n\n（这是第 ${retryCount + 1} 次尝试，请确保答案中的每一个事实都能在上文找到对应依据，不要编造。）`
      : '');

  let raw;
  try {
    raw = await rag.client.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      { temperature: 0.3, maxTokens: 1024 }
    );
  } catch (err) {
    console.error('[N3] LLM call failed:', err.message);
    return {
      answer: `【调用 LLM 失败】检索到的相关内容：\n\n${context}`,
      citedChunks: [],
    };
  }

  const validIdx = (mergedHits || []).map(h => h.metadata.chunkIndex);
  const { answer, citedChunks } = parseAnswerJson(raw, validIdx);
  return { answer, citedChunks };
}
