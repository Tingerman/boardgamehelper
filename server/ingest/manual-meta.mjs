// 路由层共享：从 req.body 提取用户手动填写的 metadata
//
// 三字段（zhName/enName/summary）"全有或全无"语义：
//   - 用户填了任何一个 → 返回 {zhName, enName, summary}（未填字段保持空字符串）
//   - 用户三个都没填 → 返回 null（让 pipeline 走 LLM 抽取）
//
// 这样可以让用户保留显式控制，避免 LLM 与用户输入混合产生不一致。

function trim(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export function collectManualMeta(body) {
  if (!body || typeof body !== 'object') return null;
  const zhName = trim(body.zhName);
  const enName = trim(body.enName);
  const summary = trim(body.summary);
  if (!zhName && !enName && !summary) return null;
  return { zhName, enName, summary };
}
