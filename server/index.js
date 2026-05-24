require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const RAGEngine = require('./rag/index');
const pdfParser = require('./rag/pdf');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize RAG engine
const rag = new RAGEngine();

// Lazy-loaded LangGraph agent (ESM module, dynamic import in CJS)
let agentMod = null;
async function loadAgent() {
  if (agentMod) return agentMod.invokeAgent;
  const depsMod = await import('./agent/deps.mjs');
  agentMod = await import('./agent/graph.mjs');
  depsMod.setDeps({ rag, cacheDir });
  console.log('LangGraph agent loaded');
  return agentMod.invokeAgent;
}
async function loadResumeAgent() {
  if (!agentMod) await loadAgent();
  return agentMod.resumeAgent;
}

// Catalog + matcher 初始化
async function initCatalogAndMatcher() {
  try {
    const bili = await import('./catalog/bilibili.mjs');
    const cache = await import('./catalog/cache.mjs');
    const matcher = await import('./catalog/matcher.mjs');

    // 让 matcher 能拿到 catalog cache（避免循环 import）
    globalThis.__catalogCacheRef = cache;

    const collectionId = process.env.BILI_COLLECTION_ID;
    const entries = await bili.fetchCatalog(collectionId);
    cache.setCatalog(entries);
    const reconciled = cache.reconcileIngestedFromRag(rag);
    console.log(`Loaded ${entries.length} games from Bilibili catalog (${reconciled} already ingested)`);

    matcher.setMatcherSources(rag);
    console.log(`Matcher alias index built: ${matcher._getAliasIndex().length} aliases`);
  } catch (err) {
    console.warn('Catalog/matcher init failed, feature degraded:', err.message);
  }
}

// Configure multer for file uploads
const upload = multer({
  dest: path.join(__dirname, '../data/temp'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

// Ensure directories exist
const dataDir = path.join(__dirname, '../data');
const tempDir = path.join(dataDir, 'temp');
const booksDir = path.join(dataDir, 'books');
const cacheDir = path.join(dataDir, 'cache');

[dataDir, tempDir, booksDir, cacheDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Lazy-loaded cache module (ESM)
let cacheMod = null;
async function loadCacheMod() {
  if (cacheMod) return cacheMod;
  cacheMod = await import('./rag/cache.mjs');
  return cacheMod;
}

function cachePathFor(bookId) {
  return path.join(cacheDir, `${bookId}.cache.json`);
}

// Initialize RAG on startup
async function initRAG() {
  try {
    await rag.initialize();
    console.log('RAG engine initialized');

    // Check for existing PDFs in data/books
    const files = fs.readdirSync(booksDir).filter(f => f.endsWith('.pdf'));
    const cm = await loadCacheMod();

    for (const file of files) {
      try {
        const pdfPath = path.join(booksDir, file);
        const bookId = path.basename(file, '.pdf');
        const cachePath = cachePathFor(bookId);

        // 1) cache 命中走快路径
        const pdfHash = await cm.sha256File(pdfPath);
        const cached = await cm.loadCache(cachePath);
        const expected = { ...rag.getCacheEnv(), pdfHash };
        if (cm.isCacheValid(cached, expected)) {
          rag.loadBookFromCache(cached);
          console.log(`[cache] hit: ${file} (${cached.chunks.length} chunks)`);
          continue;
        }
        if (cached) {
          console.log(`[cache] invalid: ${file}, full ingest`);
        } else {
          console.log(`[cache] miss: ${file}, full ingest`);
        }

        // 2) cache miss / invalid 走完整 ingest，结束写 cache
        console.log(`Processing existing PDF: ${file}`);
        const { text } = await pdfParser.parsePDF(pdfPath);
        const cleanedText = pdfParser.preprocessText(text);

        await rag.ingestDocument(
          bookId,
          path.basename(file, '.pdf'),
          cleanedText
        );
        console.log(`Ingested: ${file}`);

        try {
          const payload = rag.serializeBook(bookId, { pdfHash });
          if (payload) {
            await cm.writeCache(cachePath, payload);
            console.log(`[cache] wrote: ${file}`);
          }
        } catch (cacheErr) {
          console.warn(`[cache] write failed for ${file}:`, cacheErr.message);
        }
      } catch (err) {
        console.error(`Error processing ${file}:`, err.message);
      }
    }

    // 扫描 bili-* cache，还原历史入库的 B 站桌游书（无源 PDF，pdfHash=null）
    try {
      const cacheFiles = fs.readdirSync(cacheDir).filter(f => f.startsWith('bili-') && f.endsWith('.cache.json'));
      for (const cacheFile of cacheFiles) {
        const cachePath = path.join(cacheDir, cacheFile);
        try {
          const cached = await cm.loadCache(cachePath);
          const expected = { ...rag.getCacheEnv(), pdfHash: null };
          if (cm.isCacheValid(cached, expected)) {
            rag.loadBookFromCache(cached);
            console.log(`[cache] hit bili: ${cached.bookId} (${cached.chunks.length} chunks)`);
          } else {
            const reason = cached && cached.schemaVersion !== cm.SCHEMA_VERSION
              ? `outdated schemaVersion=${cached.schemaVersion}→${cm.SCHEMA_VERSION}`
              : 'invalid';
            console.log(`[cache] ${reason} bili: ${cacheFile}, removing (will re-ingest on next query)`);
            await cm.deleteCache(cachePath);
          }
        } catch (err) {
          console.warn(`[cache] failed to restore bili ${cacheFile}:`, err.message);
        }
      }
    } catch (err) {
      console.warn('[cache] bili scan failed:', err.message);
    }

    // 加载 LangGraph agent（在 PDF ingest 完成后，确保 BM25 索引已就绪）
    await loadAgent();
    if (rag.getBm25()) {
      console.log(`BM25 index ready: ${rag.getBm25().size()} chunks indexed`);
    }

    // 历史 books metadata 迁移（异步，不阻塞 HTTP 起服务）
    if (typeof rag.migrateBooksMetadata === 'function') {
      rag.migrateBooksMetadata({
        concurrency: 3,
        onProgress: ({ id, idx, total }) => {
          console.log(`[migrate] ${idx + 1}/${total} ${id}`);
        },
      }).then(async ({ migrated, total }) => {
        console.log(`Migrated ${migrated || 0}/${total || 0} historical books with metadata`);
        // 触发 matcher alias index 重建
        try {
          const matcher = await import('./catalog/matcher.mjs');
          if (matcher && matcher.rebuildAliasIndex) matcher.rebuildAliasIndex();
        } catch (err) { console.warn('rebuildAliasIndex after migrate failed:', err.message); }
      }).catch(err => console.warn('migrate failed:', err.message));
    }

    // 加载 catalog（B 站合集）+ matcher 数据源注入
    await initCatalogAndMatcher();
  } catch (err) {
    console.error('Failed to initialize RAG:', err);
  }
}

initRAG();

// API Routes

// Get system status
app.get('/api/status', async (req, res) => {
  try {
    const status = rag.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get list of ingested books
app.get('/api/books', async (req, res) => {
  try {
    const books = rag.getBooks();
    res.json(books);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ingest a new PDF
app.post('/api/ingest', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const bookName = req.body.name || path.basename(req.file.originalname, '.pdf');
    const bookId = req.body.id || path.basename(req.file.originalname, '.pdf');

    // Move file to books directory
    const destPath = path.join(booksDir, `${bookId}.pdf`);
    fs.renameSync(req.file.path, destPath);

    // Parse PDF
    const { text, pages } = await pdfParser.parsePDF(destPath);
    const cleanedText = pdfParser.preprocessText(text);

    // 用户手动填的 metadata（zh/en/intro 三字段全有或全无）
    const { collectManualMeta } = await import('./ingest/manual-meta.mjs');
    const manualMeta = collectManualMeta(req.body);

    // Ingest into RAG（manualMeta 优先，否则走 LLM 抽取）
    const result = await rag.ingestDocument(bookId, bookName, cleanedText, {
      metadata: manualMeta || undefined,
      source: 'pdf',
      sourceMeta: { uploadedAt: Date.now(), originalName: req.file.originalname },
    });

    // 写 cache（失败不影响上传响应）
    try {
      const cm = await loadCacheMod();
      const pdfHash = await cm.sha256File(destPath);
      const payload = rag.serializeBook(bookId, { pdfHash });
      if (payload) {
        await cm.writeCache(cachePathFor(bookId), payload);
        console.log(`[cache] wrote: ${bookId}.pdf (uploaded)`);
      }
    } catch (cacheErr) {
      console.warn(`[cache] write failed after upload ${bookId}:`, cacheErr.message);
    }

    // 触发 matcher alias index 重建，让新 PDF 立即进 N6 池
    try {
      const matcher = await import('./catalog/matcher.mjs');
      matcher.rebuildAliasIndex();
    } catch (err) { console.warn('rebuildAliasIndex after upload failed:', err.message); }

    res.json({
      success: true,
      bookId,
      bookName,
      pages,
      chunks: result.chunks,
      metadata: result.metadata,
    });
  } catch (err) {
    console.error('Ingest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 图片上传 → ingest（SSE 流式进度）
// multipart/form-data: images[] (多文件) + 可选 zhName/enName/summary/name
app.post('/api/ingest/image', upload.array('images', 20), async (req, res) => {
  const { collectManualMeta } = await import('./ingest/manual-meta.mjs');
  const { ingestFromImages } = await import('./ingest/image-pipeline.mjs');
  const { createSseResponse } = await import('./ingest/sse.mjs');

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No images uploaded' });
  }

  const manualMeta = collectManualMeta(req.body);
  const displayName = (manualMeta && manualMeta.zhName) || req.body.name || `images-${Date.now()}`;
  const bookId = req.body.id || `img-${Date.now()}`;
  const imagePaths = req.files.map(f => f.path);

  const sse = createSseResponse(res);
  try {
    await ingestFromImages({
      bookId,
      displayName,
      imagePaths,
      manualMeta,
      sseEmit: sse.emit,
      rag,
      cacheDir,
    });
  } catch (err) {
    console.error('Image ingest error:', err);
    sse.emit('error', { code: 'unexpected', message: err.message });
  } finally {
    // 清理临时文件
    for (const p of imagePaths) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
    sse.end();
  }
});

// B 站 opus URL → ingest（SSE 流式进度）
// JSON body: { url, zhName?, enName?, summary? }
app.post('/api/ingest/url', async (req, res) => {
  const { collectManualMeta } = await import('./ingest/manual-meta.mjs');
  const { ingestBilibiliByUrl } = await import('./ingest/by_url.mjs');
  const { createSseResponse } = await import('./ingest/sse.mjs');

  const url = (req.body && req.body.url) ? String(req.body.url).trim() : '';
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  const manualMeta = collectManualMeta(req.body);

  const sse = createSseResponse(res);
  try {
    const r = await ingestBilibiliByUrl({
      url, rag, cacheDir, sseEmit: sse.emit, manualMeta,
    });
    if (!r.ok) {
      sse.emit('error', r.error);
    }
  } catch (err) {
    console.error('URL ingest error:', err);
    sse.emit('error', { code: 'unexpected', message: err.message });
  } finally {
    sse.end();
  }
});

// Query the RAG system (now powered by LangGraph agent)
app.post('/api/query', async (req, res) => {
  try {
    const { question } = req.body;
    // 兼容老调用：bookIds 数组优先；bookId 单值自动包成数组
    const bookIds = Array.isArray(req.body.bookIds)
      ? req.body.bookIds.filter(b => typeof b === 'string' && b)
      : (req.body.bookId ? [req.body.bookId] : []);

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const wantsSse = (req.headers.accept || '').includes('text/event-stream');

    // SSE 模式：流式上报 ingest 进度 + 最终 answer
    if (wantsSse) {
      let sse;
      try {
        const sseMod = await import('./ingest/sse.mjs');
        sse = sseMod.createSseResponse(res);
      } catch (err) {
        console.error('SSE init failed:', err);
        return res.status(500).json({ error: 'sse_init_failed' });
      }

      try {
        const invoke = await loadAgent();
        const threadId = (req.body && typeof req.body.threadId === 'string' && req.body.threadId)
          ? req.body.threadId
          : null;
        const result = await invoke(question, {
          bookIds,
          sseEmit: sse.emit,
          threadId,
        });
        if (result.interrupted) {
          // 中断：把 candidates + threadId 推给前端，等 /api/resume
          sse.emit('interrupt', {
            threadId: result.threadId,
            reason: result.reason,
            candidates: result.candidates,
            partialAnswer: result.partialAnswer,
            partialSources: result.partialSources,
          });
        } else {
          sse.emit('answer', {
            answer: result.answer,
            sources: result.sources || [],
            intent: result.intent,
            faithfulness: result.faithfulness,
            retryCount: result.retryCount,
            catalogStatus: result.catalogStatus,
            matchedBy: result.matchedBy,
            matchConfidence: result.matchConfidence,
            ingestResult: result.ingestResult,
            l2Candidates: result.l2Candidates || [],
          });
          sse.emit('done', {});
        }
      } catch (err) {
        console.error('SSE agent error:', err);
        sse.emit('error', { code: 'agent_error', message: err.message });
      } finally {
        sse.end();
      }
      return;
    }

    // 非 SSE 模式：catalog 命中未入库时不自动 ingest，提示前端切 SSE 重发
    try {
      const invoke = await loadAgent();
      const matcher = await import('./catalog/matcher.mjs');
      if (bookIds.length === 0) {
        const aliasHit = matcher.matchByAlias(question);
        if (aliasHit && aliasHit.entry && aliasHit.entry.kind === 'catalog_only') {
          return res.json({
            status: 'need_ingest',
            game: aliasHit.entry.zhName,
            dynIdStr: aliasHit.entry.dynIdStr,
            hint: 'Use Accept: text/event-stream to trigger ingest with progress streaming.',
          });
        }
      }
      const result = await invoke(question, { bookIds });
      return res.json({
        answer: result.answer,
        sources: result.sources || [],
        intent: result.intent,
        faithfulness: result.faithfulness,
        retryCount: result.retryCount,
        catalogStatus: result.catalogStatus,
        matchedBy: result.matchedBy,
        matchConfidence: result.matchConfidence,
        l2Candidates: result.l2Candidates || [],
      });
    } catch (agentErr) {
      console.error('Agent invocation failed, falling back to legacy rag.query:', agentErr);
      // legacy fallback 仍走单 bookId（rag.query 接口未升级）
      const result = await rag.query(question, bookIds[0] || null);
      return res.json({ ...result, fallback: 'legacy' });
    }
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Resume an interrupted agent run（用户对 N8 suggest_l2 做出选择后续跑）
// SSE-only：续跑会继续推 ingest_progress / answer / done
app.post('/api/resume', async (req, res) => {
  const threadId = req.body && req.body.threadId;
  const accept = !!(req.body && req.body.accept);
  const dynIdStrs = Array.isArray(req.body && req.body.dynIdStrs)
    ? req.body.dynIdStrs.filter(s => typeof s === 'string')
    : [];
  if (!threadId) {
    return res.status(400).json({ error: 'threadId required' });
  }

  let sse;
  try {
    const sseMod = await import('./ingest/sse.mjs');
    sse = sseMod.createSseResponse(res);
  } catch (err) {
    return res.status(500).json({ error: 'sse_init_failed' });
  }

  try {
    const resume = await loadResumeAgent();
    const result = await resume(threadId, { accept, dynIdStrs }, { sseEmit: sse.emit });
    if (result.interrupted) {
      // 不该发生（l2Resumed 已短路 N4）；当成异常处理
      sse.emit('error', { code: 'unexpected_reinterrupt', message: 'graph re-interrupted' });
    } else {
      sse.emit('answer', {
        answer: result.answer,
        sources: result.sources || [],
        intent: result.intent,
        faithfulness: result.faithfulness,
        retryCount: result.retryCount,
        catalogStatus: result.catalogStatus,
        matchedBy: result.matchedBy,
        matchConfidence: result.matchConfidence,
        l2Candidates: result.l2Candidates || [],
        l2Resumed: result.l2Resumed,
      });
      sse.emit('done', {});
    }
  } catch (err) {
    if (err.code === 'session_expired') {
      sse.emit('error', { code: 'session_expired', message: 'thread not found, re-query needed' });
    } else {
      console.error('Resume error:', err);
      sse.emit('error', { code: 'resume_failed', message: err.message });
    }
  } finally {
    sse.end();
  }
});

// Translate text
app.post('/api/translate', async (req, res) => {
  try {
    const { text, target, bookId } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }
    const t = target === 'zh' ? 'zh' : 'en';
    const translated = await rag.translate(text, t, { bookId: bookId || null });
    res.json({ translated });
  } catch (err) {
    console.error('Translate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a book
app.delete('/api/books/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // 1. 内存：从向量库和 books Map 里移除
    const removed = rag.deleteBook(id);
    if (!removed) {
      return res.status(404).json({ error: 'Book not found' });
    }

    // 2. 磁盘：把 data/books/ 下的 PDF 也删掉，否则下次 initRAG 会重新 ingest
    const pdfPath = path.join(booksDir, `${id}.pdf`);
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }

    // 3. 删 cache 文件，避免下次启动反序列化幽灵 book
    try {
      const cm = await loadCacheMod();
      await cm.deleteCache(cachePathFor(id));
    } catch (cacheErr) {
      console.warn(`[cache] delete failed for ${id}:`, cacheErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 用户对 N5 拒答的"原始反馈"：用户填啥就收啥，不在路由里做分类
// 设计：分类放离线（review_cli.mjs：fuzzy match + LLM 校验三档分流）
//   1. 高置信度 alias → 升级 aliases_extra.json
//   2. 高置信度库外 → 进 ingest 优先级队列
//   3. 中置信度 → 人工 review
// 这条路由不假设"用户能填官方名"，因为能填官方名的用户 N1 早就识别成功了
app.post('/api/feedback/alias', async (req, res) => {
  try {
    const userQuery = req.body && typeof req.body.userQuery === 'string' ? req.body.userQuery.trim() : '';
    const userInput = req.body && typeof req.body.gameZhName === 'string' ? req.body.gameZhName.trim() : '';
    if (!userQuery || !userInput) {
      return res.status(400).json({ error: 'userQuery and gameZhName required' });
    }
    const { recordRawFeedback } = await import('./feedback/raw_feedback.mjs');
    recordRawFeedback({ userQuery, userInput });
    res.json({ ok: true });
  } catch (err) {
    console.error('feedback/alias error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});