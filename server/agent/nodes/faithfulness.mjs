// N4 faithfulness（LLM-as-Judge）
//
// 判断 answer 是否完全被 context 支撑：
//   - supported   → END
//   - partial / unsupported → 跳回 N3 重答（retryCount + 1）
//   - retryCount >= 2 → 强制 END，避免无限循环
//
// 这是图独有的能力（反向边 + 累加 reducer），LCEL 撞墙场景之一。
import { END } from '@langchain/langgraph';
import { getDeps } from '../deps.mjs';

const MAX_RETRY = 2;

const SYSTEM_PROMPT = `你是答案校验器。判断 answer 中的每个事实点是否都能在 context 找到依据。
仅输出一个 JSON 对象，不要解释、不要 markdown 代码块：
{"verdict": "supported" | "partial" | "unsupported", "reason": "简短理由"}

判定规则：
- supported: 所有事实点都能在 context 找到对应依据
- partial: 有部分事实点没有依据（混了点编的）
- unsupported: 大部分内容是编造或与 context 矛盾`;

function parseVerdict(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (['supported', 'partial', 'unsupported'].includes(obj.verdict)) return obj.verdict;
  } catch (_) {
    // fallthrough
  }
  const m = cleaned.match(/"verdict"\s*:\s*"(supported|partial|unsupported)"/);
  return m ? m[1] : null;
}

export async function faithfulnessNode(state) {
  const { rag } = getDeps();
  const { answer, context } = state;

  // 上下文为空时无法校验，直接放行
  if (!context || !answer) {
    return { faithfulness: 'supported' };
  }

  let raw;
  try {
    raw = await rag.client.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `<context>\n${context}\n</context>\n\n<answer>\n${answer}\n</answer>`,
        },
      ],
      { temperature: 0, maxTokens: 100 }
    );
  } catch (err) {
    console.warn('[N4] judge LLM call failed, fallback to supported:', err.message);
    return { faithfulness: 'supported' };
  }

  const verdict = parseVerdict(raw) ?? 'supported';
  if (verdict !== 'supported') {
    console.log(`[N4] verdict=${verdict}, retryCount=${state.retryCount}`);
  }
  return { faithfulness: verdict };
}

/**
 * 路由函数：决定从 N4 出来去哪
 * 设计：信任「用户决策」优先于「模型自纠正」
 * - supported               → END
 * - 第一次没 supported（还没走过 L2） → 'catalog_probe'（N8 直接问用户要不要抓新源）
 * - 已走过 L2 但还没 supported & retryCount 没用完 → 'retry'（兜底再答一次）
 * - retryCount 用完           → END（不再二次进 N8）
 */
export function routeAfterFaithfulness(state) {
  if (state.faithfulness === 'supported') return END;
  // 第一次 partial/unsupported → 直接升级到用户决策
  if (state.l2Resumed !== true) {
    console.log('[N4] not supported, route to catalog_probe (N8) — first try');
    return 'catalog_probe';
  }
  // 已经吃过新源还不 supported → retry 兜底
  if ((state.retryCount ?? 0) < MAX_RETRY) {
    return 'retry';
  }
  // retry 也用完 → 收口
  console.log('[N4] retry limit reached after L2, give up');
  return END;
}

/**
 * 重试节点：仅作为 retryCount 累加点。LangGraph 不支持节点直接 self-loop
 * 写 reducer 增量；用一个独立 incrementRetry 节点保留显式 trace。
 */
export function incrementRetryNode(_state) {
  return { retryCount: 1 };
}
