// B 站 opus → ingest 共享流水线
//
// 既被 N7 节点（自动触发）调用，也被 /api/ingest/url 路由（用户主动粘贴 URL）调用。
//
// 流程：
//   1. inflight 锁（同 dynIdStr 并发保护）
//   2. 已 ingest 短路（rag.books.has(bookId) → 直接 emit ingest_done）
//   3. scrape opus（emit progress 5）
//   4. OCR 串行（emit 5-70）
//   5. metadata：manualMeta 优先，否则用 catalog 携带的或最终落 LLM 抽取
//   6. embed + 入库（emit 80-95）
//   7. markIngested + rebuildAliasIndex
//   8. write cache（pdfHash=null）
//   9. emit ingest_done

import path from 'path';
import { scrapeOpus } from './bilibili-opus.mjs';
import { paddleOcr } from './ocr.mjs';
import { markIngested } from '../catalog/cache.mjs';
import { rebuildAliasIndex } from '../catalog/matcher.mjs';
import { writeCache } from '../rag/cache.mjs';

export const inflightSet = new Set();

const OCR_FAIL_RATE_THRESHOLD = 0.5;

/**
 * @param {{
 *   dynIdStr: string,
 *   manualMeta?: {zhName, enName, summary}|null,
 *   sseEmit?: Function,
 *   rag: any,
 *   cacheDir?: string,
 *   articleId?: number|null,
 *   fullTitle?: string|null,
 *   defaultMeta?: {zhName, enName, summary}|null,  // 来自 catalog entry 的预填值
 * }} args
 */
export async function ingestFromBilibiliOpus({
  dynIdStr,
  manualMeta = null,
  sseEmit = () => {},
  rag,
  cacheDir = null,
  articleId = null,
  fullTitle = null,
  defaultMeta = null,
}) {
  if (!dynIdStr) {
    sseEmit('error', { code: 'invalid_dyn_id' });
    return { ok: false, code: 'invalid_dyn_id' };
  }

  const bookId = `bili-${dynIdStr}`;

  // 已 ingest 短路
  if (rag.books && rag.books.has(bookId)) {
    sseEmit('ingest_done', { bookId, chunks: 0, durationMs: 0, skipped: true });
    return { ok: true, bookId, chunks: 0, skipped: true };
  }

  if (inflightSet.has(dynIdStr)) {
    sseEmit('error', { code: 'already_ingesting', dynIdStr });
    return { ok: false, code: 'already_ingesting' };
  }
  inflightSet.add(dynIdStr);

  const t0 = Date.now();
  try {
    sseEmit('ingest_progress', { stage: 'scrape', percent: 5 });
    const opusUrl = `https://t.bilibili.com/${dynIdStr}`;
    sseEmit('op_log', { type: 'scrape', url: opusUrl, dynIdStr });
    const { title, texts, images } = await scrapeOpus(dynIdStr);
    sseEmit('op_log', { type: 'scraped', url: opusUrl, dynIdStr, title, imageCount: (images || []).length });

    const ocrTexts = [];
    if (images && images.length > 0) {
      for (let i = 0; i < images.length; i++) {
        try {
          ocrTexts.push(await paddleOcr(images[i]));
        } catch (err) {
          if (err && /OCR_QUOTA_EXHAUSTED/.test(err.message || '')) {
            sseEmit('error', { code: 'quota_exhausted' });
            throw err;
          }
          console.warn(`[bili-pipeline] OCR ${i + 1}/${images.length} failed:`, err.message, 'url=', images[i]);
          ocrTexts.push('');
        }
        sseEmit('ingest_progress', {
          stage: 'ocr',
          current: i + 1,
          total: images.length,
          percent: Math.round(5 + 65 * (i + 1) / images.length),
        });
      }
      const failRate = ocrTexts.filter(t => !t).length / images.length;
      if (failRate > OCR_FAIL_RATE_THRESHOLD) {
        throw new Error('OCR_FAIL_RATE_EXCEEDED');
      }
    }

    sseEmit('ingest_progress', { stage: 'metadata', percent: 75 });
    const metadata = manualMeta || defaultMeta || null;

    sseEmit('ingest_progress', { stage: 'embed', percent: 80 });
    // chunk-image 对齐：title + 正文文本作为前缀，每张图的 OCR 文本作为带 imageIndex 的 segment
    const prefixText = [title, ...(texts || [])].filter(Boolean).join('\n\n');
    const imageSegments = (images || []).map((url, i) => ({
      imageIndex: i,
      imageUrl: url,
      text: ocrTexts[i] || '',
    })).filter(seg => seg.text);
    const displayName = (metadata && metadata.zhName) || fullTitle || title || bookId;
    const result = await rag.ingestDocument(bookId, displayName, prefixText, {
      // null/undefined → 让 rag.ingestDocument 走 LLM 抽取
      metadata: metadata || undefined,
      source: 'bilibili',
      sourceMeta: { dynIdStr, articleId, imageUrls: images || [] },
      imageSegments,
    });

    markIngested(dynIdStr);
    try { rebuildAliasIndex(); } catch (err) { console.warn('[bili-pipeline] rebuildAliasIndex failed:', err.message); }

    if (cacheDir) {
      try {
        const payload = rag.serializeBook(bookId, { pdfHash: null });
        if (payload) {
          await writeCache(path.join(cacheDir, `${bookId}.cache.json`), payload);
        }
      } catch (cacheErr) {
        console.warn('[bili-pipeline] cache write failed:', cacheErr.message);
      }
    }

    const durationMs = Date.now() - t0;
    sseEmit('op_log', { type: 'ingest_done', dynIdStr, bookId, chunks: result.chunks, durationMs });
    sseEmit('ingest_done', { bookId, chunks: result.chunks, durationMs });
    return { ok: true, bookId, chunks: result.chunks, durationMs };
  } catch (err) {
    console.warn('[bili-pipeline] failed:', err.message);
    sseEmit('error', { code: 'ingest_failed', message: err.message });
    return { ok: false, code: 'ingest_failed', message: err.message };
  } finally {
    inflightSet.delete(dynIdStr);
  }
}

// 测试入口
export const _inflightSet = inflightSet;
