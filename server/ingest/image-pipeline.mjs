// 图片上传 → ingest 共享流水线
//
// 被 /api/ingest/image 路由调用。
//
// 流程：
//   1. 串行 OCR 每张图片（保护配额，emit progress 5-70）
//   2. 50% 失败率阈值检查
//   3. metadata：manualMeta 优先，否则交给 rag.ingestDocument 走 LLM 抽取
//   4. embed + 入库（emit 80-95）
//   5. rebuildAliasIndex
//   6. write cache（pdfHash=null）
//   7. emit ingest_done

import path from 'path';
import { paddleOcrFile } from './ocr.mjs';
import { rebuildAliasIndex } from '../catalog/matcher.mjs';
import { writeCache } from '../rag/cache.mjs';

const OCR_FAIL_RATE_THRESHOLD = 0.5;

/**
 * @param {{
 *   bookId: string,
 *   displayName?: string,
 *   imagePaths: string[],
 *   manualMeta?: {zhName, enName, summary}|null,
 *   sseEmit?: Function,
 *   rag: any,
 *   cacheDir?: string|null,
 * }} args
 */
export async function ingestFromImages({
  bookId,
  displayName = null,
  imagePaths,
  manualMeta = null,
  sseEmit = () => {},
  rag,
  cacheDir = null,
}) {
  if (!bookId) {
    sseEmit('error', { code: 'invalid_book_id' });
    return { ok: false, code: 'invalid_book_id' };
  }
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    sseEmit('error', { code: 'no_images' });
    return { ok: false, code: 'no_images' };
  }

  if (rag.books && rag.books.has(bookId)) {
    sseEmit('ingest_done', { bookId, chunks: 0, durationMs: 0, skipped: true });
    return { ok: true, bookId, chunks: 0, skipped: true };
  }

  const t0 = Date.now();
  try {
    sseEmit('op_log', { type: 'image_ingest_start', bookId, imageCount: imagePaths.length });
    const ocrTexts = [];
    for (let i = 0; i < imagePaths.length; i++) {
      try {
        ocrTexts.push(await paddleOcrFile(imagePaths[i]));
      } catch (err) {
        if (err && /OCR_QUOTA_EXHAUSTED/.test(err.message || '')) {
          sseEmit('error', { code: 'quota_exhausted' });
          throw err;
        }
        console.warn(`[image-pipeline] OCR ${i + 1}/${imagePaths.length} failed:`, err.message, 'path=', imagePaths[i]);
        ocrTexts.push('');
      }
      sseEmit('ingest_progress', {
        stage: 'ocr',
        current: i + 1,
        total: imagePaths.length,
        percent: Math.round(5 + 65 * (i + 1) / imagePaths.length),
      });
    }

    const failRate = ocrTexts.filter(t => !t).length / imagePaths.length;
    if (failRate > OCR_FAIL_RATE_THRESHOLD) {
      throw new Error('OCR_FAIL_RATE_EXCEEDED');
    }

    sseEmit('ingest_progress', { stage: 'metadata', percent: 75 });

    sseEmit('ingest_progress', { stage: 'embed', percent: 80 });
    const fullText = ocrTexts.filter(Boolean).join('\n\n');
    if (!fullText.trim()) {
      throw new Error('EMPTY_OCR_RESULT');
    }
    const finalName = (manualMeta && manualMeta.zhName) || displayName || bookId;
    const result = await rag.ingestDocument(bookId, finalName, fullText, {
      metadata: manualMeta || undefined,
      source: 'image',
      sourceMeta: { imageCount: imagePaths.length },
    });

    try { rebuildAliasIndex(); } catch (err) { console.warn('[image-pipeline] rebuildAliasIndex failed:', err.message); }

    if (cacheDir) {
      try {
        const payload = rag.serializeBook(bookId, { pdfHash: null });
        if (payload) {
          await writeCache(path.join(cacheDir, `${bookId}.cache.json`), payload);
        }
      } catch (cacheErr) {
        console.warn('[image-pipeline] cache write failed:', cacheErr.message);
      }
    }

    const durationMs = Date.now() - t0;
    sseEmit('op_log', { type: 'image_ingest_done', bookId, chunks: result.chunks, durationMs });
    sseEmit('ingest_done', { bookId, chunks: result.chunks, durationMs });
    return { ok: true, bookId, chunks: result.chunks, durationMs };
  } catch (err) {
    console.warn('[image-pipeline] failed:', err.message);
    sseEmit('error', { code: 'ingest_failed', message: err.message });
    return { ok: false, code: 'ingest_failed', message: err.message };
  }
}
