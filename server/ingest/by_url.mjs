// 按 URL ingest 一篇 B站 opus（可复用入口）
//
// 提供给：
//   - /api/ingest/url 路由
//   - N8 catalog_probe resume 路径（用户接受 L2 升级时批量抓候选）
//
// 入参：
//   - url: 完整 B站动态/opus URL，必须能解析出 dynIdStr
//   - rag: ragService 单例
//   - cacheDir: 缓存目录
//   - sseEmit: 进度上报 hook（可选）
//   - manualMeta: 用户手填的 zhName/enName/summary（可选）
//
// 返回：
//   { ok: true, bookId } —— 成功
//   { ok: false, error: { code, message } } —— 失败，不抛
import { collectManualMeta } from './manual-meta.mjs';
import { ingestFromBilibiliOpus } from './bilibili-pipeline.mjs';

const URL_RE = /(?:t\.bilibili\.com\/|opus\/)(\d+)/;

export async function ingestBilibiliByUrl({ url, rag, cacheDir, sseEmit, manualMeta }) {
  if (!url || typeof url !== 'string') {
    return { ok: false, error: { code: 'invalid_url', message: 'url required' } };
  }
  const m = url.match(URL_RE);
  if (!m) {
    return { ok: false, error: { code: 'invalid_url', message: 'cannot parse dynIdStr' } };
  }
  const dynIdStr = m[1];
  try {
    const result = await ingestFromBilibiliOpus({
      dynIdStr,
      manualMeta: manualMeta || collectManualMeta({}),
      sseEmit: sseEmit || (() => {}),
      rag,
      cacheDir,
    });
    if (result && result.bookId) {
      return { ok: true, bookId: result.bookId };
    }
    return { ok: true, bookId: `bili-${dynIdStr}` };
  } catch (err) {
    return { ok: false, error: { code: 'ingest_failed', message: err.message } };
  }
}
