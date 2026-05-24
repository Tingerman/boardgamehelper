// N1 detect_intent
//
// 用 LLM 三分类用户输入意图，决定后续路由：
//   - rag        → 走 N2 hybrid_retrieve
//   - off_topic  → 走 N5 refuse（拒答）
//   - greeting   → 走 N5 refuse（闲聊回应）
//
// 设计点：
//  - **alias 硬前置**：question 命中任何已知 alias（catalog 全表 + aliases_extra）
//     → 强制 intent='rag' 直接绕过 LLM。理由：LLM 通用语料对中文桌游术语有偏见
//     （如"历史巨轮"+"腐败"会被联想为政治），alias 表是更可靠的信号源。
//  - 不带 history（无状态分类，避免会话漂移影响判断）
//  - JSON 输出 + T=0 + maxTokens=30，纯结构化短回复
//  - 解析失败降级为 'rag'（保守策略，宁可多答不要误拒）
import { getDeps } from '../deps.mjs';
import { matchByAlias } from '../../catalog/matcher.mjs';

const SYSTEM_PROMPT = `你是一个意图分类器。根据用户输入判断意图，仅输出一个 JSON 对象，不要解释、不要 markdown 代码块：
{"intent": "rag" | "off_topic" | "greeting"}

分类规则：
- rag: 询问桌游规则、玩法、计分、卡牌效果、游戏机制等
- greeting: 问候语、自我介绍请求、闲聊（如"你好"、"你是谁"、"在吗"）
- off_topic: 跟桌游完全无关的话题（如天气、股票、数学题、编程问题）`;

function parseIntent(raw) {
  if (!raw) return null;
  // 容错：去掉可能的 markdown 围栏
  const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (['rag', 'off_topic', 'greeting'].includes(obj.intent)) return obj.intent;
  } catch (_) {
    // fallthrough
  }
  // 二次降级：从原文里抓关键词
  const m = cleaned.match(/"intent"\s*:\s*"(rag|off_topic|greeting)"/);
  if (m) return m[1];
  return null;
}

export async function detectIntentNode(state) {
  // 硬前置：question 命中已知 alias → 强制 rag，绕过 LLM 偏见
  // alias index 在 catalog 启动时已构建（含 aliases_extra.json），子串匹配 ~10us
  try {
    const hit = matchByAlias(state.question);
    if (hit) {
      console.log(`[N1] alias short-circuit → rag (matched "${hit.entry?.zhName || hit.entry?.enName}")`);
      return { intent: 'rag' };
    }
  } catch (err) {
    // 不让 alias 路径异常影响主链路，继续走 LLM
    console.warn('[N1] alias prefix check failed, fallthrough to LLM:', err.message);
  }

  const { rag } = getDeps();

  let raw;
  try {
    raw = await rag.client.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: state.question },
      ],
      { temperature: 0, maxTokens: 30 }
    );
  } catch (err) {
    console.warn('[N1] LLM call failed, fallback to rag:', err.message);
    return { intent: 'rag' };
  }

  const intent = parseIntent(raw);
  if (!intent) {
    console.warn('[N1] intent parse failed, raw =', JSON.stringify(raw), '→ fallback to rag');
    return { intent: 'rag' };
  }
  return { intent };
}
