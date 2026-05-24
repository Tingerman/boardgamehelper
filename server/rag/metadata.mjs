// rag 层 metadata 抽取
//
// 提供两种入口：
//   - extractBookMetadata(headText, hint): 从文档头抽取 zhName + enName + summary（PDF 上传/迁移用）
//   - extractSummary(headText): 仅抽 summary（B 站 catalog 已有 zh/en，只补 summary 时用）
//
// 设计点：
//   - 调用同 rag.client（zhipu glm-4-flash）作为"小模型"，T=0，maxTokens=200，2s 超时
//   - JSON 解析失败优雅降级为 fallback 值，不抛错
//   - 显式 timeout，防止 LLM 卡死阻塞 ingest

const DEFAULT_TIMEOUT_MS = 8000;

function extractJSON(raw) {
  if (!raw) return null;
  // 去掉常见 markdown 围栏
  const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
  // 尝试整体解析
  try { return JSON.parse(cleaned); } catch (_) {}
  // 兜底：抽第一个 {...}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
  }
  return null;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('LLM_TIMEOUT')), ms)),
  ]);
}

/**
 * 从文档头抽取完整 metadata。
 * @param {Function} chatFn - rag.client.chat(messages, opts) => Promise<string>
 * @param {string} headText - 文档头 ~2000 字
 * @param {{fallbackZhName?: string, timeoutMs?: number}} hint
 * @returns {Promise<{zhName: string|null, enName: string|null, summary: string}>}
 */
export async function extractBookMetadata(chatFn, headText, hint = {}) {
  const timeoutMs = hint.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fallback = {
    zhName: hint.fallbackZhName ?? null,
    enName: null,
    summary: '',
  };

  if (!headText || !headText.trim()) return fallback;

  const prompt = `从下面这段桌游规则书的开头文本里抽取以下三项：
1. 中文名（zhName）
2. 英文名（enName）
3. 一句话简介（summary，50字以内，描述游戏机制/主题/玩法，不要照抄原文）

任何抽不到的字段返回 null（summary 抽不到返回空字符串）。严格输出 JSON，不要解释、不要 markdown 代码块：
{"zhName": "...", "enName": "...", "summary": "..."}

文本：
${headText}`;

  let raw;
  try {
    raw = await withTimeout(
      chatFn(
        [{ role: 'user', content: prompt }],
        { temperature: 0, maxTokens: 200 }
      ),
      timeoutMs
    );
  } catch (err) {
    console.warn('[metadata] extract failed:', err.message);
    return fallback;
  }

  const json = extractJSON(raw);
  if (!json) {
    console.warn('[metadata] JSON parse failed, raw =', JSON.stringify(raw));
    return fallback;
  }

  return {
    zhName: typeof json.zhName === 'string' && json.zhName.trim() ? json.zhName.trim() : fallback.zhName,
    enName: typeof json.enName === 'string' && json.enName.trim() ? json.enName.trim() : null,
    summary: typeof json.summary === 'string' ? json.summary.trim() : '',
  };
}

/**
 * 仅抽取 summary（B 站 catalog 已有 zh/en 的场景）
 */
export async function extractSummary(chatFn, headText, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!headText || !headText.trim()) return '';

  const prompt = `用一句话（50字以内）概括下面这本桌游规则书介绍的游戏机制、主题或玩法。直接输出概要正文，不要任何前缀、引号、解释。

文本：
${headText}`;

  try {
    const raw = await withTimeout(
      chatFn(
        [{ role: 'user', content: prompt }],
        { temperature: 0, maxTokens: 120 }
      ),
      timeoutMs
    );
    return (raw || '').trim().replace(/^["“「]|["”」]$/g, '');
  } catch (err) {
    console.warn('[metadata] extractSummary failed:', err.message);
    return '';
  }
}
