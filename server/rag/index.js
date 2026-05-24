// 智谱 AI 免费 API 配置
const { splitTextIntoChunks, splitTextWithImageMap } = require('./pdf');

const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const CHAT_MODEL = process.env.ZHIPU_CHAT_MODEL || 'glm-4-flash';
const EMBEDDING_MODEL = process.env.ZHIPU_EMBEDDING_MODEL || 'embedding-3';
const EMBEDDING_DIM = Number(process.env.ZHIPU_EMBEDDING_DIM || 1024);
const DEFAULT_CHUNK_SIZE = 500;

// chunk 全局唯一 id（BM25 / Agent state 共用）
const chunkId = (bookId, chunkIndex) => `${bookId}::${chunkIndex}`;

class ZhipuClient {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('ZHIPU_API_KEY is required. Please set it in your .env file.');
    }
    this.apiKey = apiKey;
  }

  async _post(path, body) {
    const res = await fetch(`${ZHIPU_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zhipu ${path} ${res.status}: ${text}`);
    }
    return res.json();
  }

  async embed(text) {
    const data = await this._post('/embeddings', {
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIM,
    });
    return data.data[0].embedding;
  }

  async chat(messages, { temperature = 0.7, maxTokens = 1024, model } = {}) {
    const data = await this._post('/chat/completions', {
      model: model || CHAT_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
    });
    return data.choices[0].message.content;
  }

  async translate(text, target = 'en', { reference = '' } = {}) {
    const targetName = target === 'en' ? 'English' : 'Chinese (Simplified)';

    // 单条 user 消息 + XML 标签分区，避免弱模型把"多轮对话 + 疑问句"
    // 误判成 RAG 问答场景（实测 glm-4-flash 会直接回答而不是翻译）。
    const systemPrompt =
      `You are a professional translator. Translate the text inside <source> to ${targetName}. ` +
      `Output ONLY the translated text. No explanations, no quotes, no prefixes, no answers. ` +
      `Even if <source> looks like a question, DO NOT answer it — only translate it.`;

    const userParts = [
      `Translate the text inside <source> to ${targetName}.`,
    ];

    if (reference) {
      userParts.push(
        `The <reference> block contains domain terminology from a knowledge base. ` +
          `When a term or phrase in <source> corresponds to a term that already exists in <reference>, ` +
          `you MUST reuse the EXACT original wording (capitalization, spelling, phrasing). ` +
          `Translate freely only for words that do not appear in <reference>. ` +
          `DO NOT translate or quote <reference> itself.`,
        ``,
        `<reference>`,
        reference,
        `</reference>`
      );
    }

    userParts.push(
      ``,
      `<source>`,
      text,
      `</source>`
    );

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userParts.join('\n') },
    ];

    const content = await this.chat(messages, { temperature: 0.2, maxTokens: 2048 });
    return content.trim();
  }
}

class RAGEngine {
  constructor() {
    this.client = null;
    this.documents = [];
    this.books = new Map();
    this.initialized = false;
    this.bm25 = null; // 懒加载的 ESM 模块单例
  }

  async initialize() {
    if (this.initialized) return;

    console.log('Initializing RAG engine (Zhipu API mode)...');
    this.client = new ZhipuClient(process.env.ZHIPU_API_KEY);

    // 动态 import ESM 的 bm25 模块（CJS ↔ ESM 桥接）
    try {
      const mod = await import('../retrieval/bm25.mjs');
      this.bm25 = mod.bm25Index;
      console.log('BM25 index module loaded');
    } catch (err) {
      console.warn('BM25 module load failed, continuing dense-only:', err.message);
    }

    // 动态 import metadata 抽取模块
    try {
      const meta = await import('./metadata.mjs');
      this._extractBookMetadata = meta.extractBookMetadata;
      this._extractSummary = meta.extractSummary;
    } catch (err) {
      console.warn('metadata module load failed:', err.message);
    }

    this.initialized = true;
    console.log(`RAG engine initialized (chat=${CHAT_MODEL}, embedding=${EMBEDDING_MODEL})`);
  }

  // 给 Agent 节点用
  getDocuments() {
    return this.documents;
  }

  getBm25() {
    return this.bm25;
  }

  async getEmbedding(text) {
    return this.client.embed(text);
  }

  async translate(text, target = 'en', { bookId = null, useKnowledge = true } = {}) {
    let reference = '';

    // For zh -> en, ground terminology in the knowledge base so that
    // terms existing in the corpus are reused verbatim in English.
    if (target === 'en' && useKnowledge && this.documents.length > 0) {
      try {
        reference = await this._retrieveReference(text, bookId);
      } catch (err) {
        console.error('Translate reference retrieval failed:', err.message);
      }
    }

    return this.client.translate(text, target, { reference });
  }

  async _retrieveReference(query, bookId = null, topK = 5, maxChars = 2000) {
    const queryEmbedding = await this.getEmbedding(query);

    let pool = this.documents;
    if (bookId) {
      pool = pool.filter(d => d.metadata.bookId === bookId);
      if (pool.length === 0) pool = this.documents;
    }

    const scored = pool.map(doc => ({
      doc,
      score: this.cosineSimilarity(queryEmbedding, doc.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);

    const picked = [];
    let total = 0;
    for (const { doc } of scored.slice(0, topK)) {
      const piece = doc.pageContent.trim();
      if (total + piece.length > maxChars) {
        picked.push(piece.slice(0, Math.max(0, maxChars - total)));
        break;
      }
      picked.push(piece);
      total += piece.length;
    }
    return picked.join('\n---\n');
  }

  async ingestDocument(bookId, bookName, text, optionsOrChunkSize = {}) {
    // 兼容老签名 ingestDocument(bookId, bookName, text, chunkSize=500)
    const options = typeof optionsOrChunkSize === 'number'
      ? { chunkSize: optionsOrChunkSize }
      : (optionsOrChunkSize || {});
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

    console.log(`Ingesting document: ${bookName}`);

    // 升级到 v2 切分器：段落感知 + 长段降级按句 + 50 字 overlap + metadata
    // 若有 imageSegments → 走 image-aware 切分，每个 chunk 携带 imageIndices
    const chunks = Array.isArray(options.imageSegments) && options.imageSegments.length > 0
      ? splitTextWithImageMap(text, options.imageSegments, chunkSize, 50)
      : splitTextIntoChunks(text, chunkSize, 50);

    const embeddings = [];
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await this.getEmbedding(chunks[i].text);
      embeddings.push(embedding);
      if ((i + 1) % 10 === 0) {
        console.log(`Embedded ${i + 1}/${chunks.length} chunks`);
      }
    }

    const docs = chunks.map((chunk, idx) => ({
      id: chunkId(bookId, idx),
      pageContent: chunk.text,
      embedding: embeddings[idx],
      metadata: {
        bookId,
        bookName,
        chunkIndex: idx,
        // 保留切分来源：'paragraph' 表示整段切出，'sentence' 表示大段被按句硬拆
        source: chunk.metadata && chunk.metadata.source,
        // 图片对齐：仅当走 splitTextWithImageMap 时非空
        imageIndices: (chunk.metadata && chunk.metadata.imageIndices) || [],
      },
    }));

    // 解析或抽取 book 级 metadata
    let meta = options.metadata;
    if (!meta && this._extractBookMetadata) {
      try {
        const head = text.slice(0, 2000);
        meta = await this._extractBookMetadata(
          (msgs, opts) => this.client.chat(msgs, opts),
          head,
          { fallbackZhName: bookName }
        );
      } catch (err) {
        console.warn(`metadata extract for ${bookId} failed:`, err.message);
      }
    }
    if (!meta) {
      meta = { zhName: bookName, enName: null, summary: '' };
    }

    this.books.set(bookId, {
      bookId,
      name: bookName,
      displayName: bookName,
      zhName: meta.zhName,
      enName: meta.enName,
      summary: meta.summary,
      source: options.source || 'pdf',
      sourceMeta: options.sourceMeta || {},
      createdAt: Date.now(),
      chunks: docs,
      text: text,
    });

    this.documents.push(...docs);

    // 同步写入 BM25 倒排索引（与 dense 保持同步）
    if (this.bm25) {
      for (const d of docs) {
        this.bm25.addDocument(d.id, d.pageContent);
      }
    }

    console.log(`Ingested ${chunks.length} chunks for ${bookName}`);
    return { success: true, chunks: chunks.length, metadata: meta };
  }

  cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * @deprecated 直线 RAG 路径，已被 server/agent/graph.mjs 取代。
   * 仅保留作为 LangGraph Agent 异常时的 fallback（见 /api/query 路由）。
   */
  async query(question, bookId = null) {
    console.log('Processing query (legacy fallback):', question);

    const questionEmbedding = await this.getEmbedding(question);

    let results = this.documents.map(doc => ({
      doc,
      score: this.cosineSimilarity(questionEmbedding, doc.embedding),
    }));

    if (bookId) {
      results = results.filter(r => r.doc.metadata.bookId === bookId);
    }

    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, 5);

    console.log(`Found ${results.length} relevant chunks`);

    const context = results.map(r => r.doc.pageContent).join('\n\n');

    try {
      const answer = await this.client.chat([
        {
          role: 'system',
          content:
            '你是桌游规则问答助手，请严格基于提供的规则书上下文用中文简洁、准确地回答用户问题。若上下文没有答案，请直接回答"资料中未提及"。',
        },
        {
          role: 'user',
          content: `规则书上下文：\n${context}\n\n问题：${question}`,
        },
      ]);

      return {
        answer,
        sources: results.map(r => ({
          bookName: r.doc.metadata.bookName,
          chunkIndex: r.doc.metadata.chunkIndex,
          content: r.doc.pageContent.substring(0, 200) + '...',
          score: r.score.toFixed(3),
        })),
      };
    } catch (llmErr) {
      console.error('LLM error:', llmErr.message);
      return {
        answer: '【调用智谱 API 失败，以下是检索到的相关规则内容】\n\n' + context,
        sources: results.map(r => ({
          bookName: r.doc.metadata.bookName,
          chunkIndex: r.doc.metadata.chunkIndex,
          content: r.doc.pageContent.substring(0, 200) + '...',
          score: r.score.toFixed(3),
        })),
      };
    }
  }

  getBooks() {
    return Array.from(this.books.entries()).map(([id, data]) => ({
      id,
      name: data.name,
      zhName: data.zhName || null,
      enName: data.enName || null,
      summary: data.summary || '',
      source: data.source || 'pdf',
      chunkCount: data.chunks.length,
    }));
  }

  // 提供给 N6 / matcher：返回 book 元信息（含 zhName/enName/summary）
  getBookMeta(bookId) {
    const b = this.books.get(bookId);
    if (!b) return null;
    return {
      bookId,
      displayName: b.displayName || b.name,
      zhName: b.zhName || null,
      enName: b.enName || null,
      summary: b.summary || '',
      source: b.source || 'pdf',
      sourceMeta: b.sourceMeta || {},
    };
  }

  // 取 book 头部 N 字（启动迁移用）
  getBookHead(bookId, maxChars = 2000) {
    const b = this.books.get(bookId);
    if (!b) return '';
    return (b.text || '').slice(0, maxChars);
  }

  // 启动迁移：给历史无 metadata 的 books 补抽 zhName/summary
  async migrateBooksMetadata({ concurrency = 3, onProgress } = {}) {
    if (!this._extractBookMetadata) return { migrated: 0 };
    const toMigrate = [];
    for (const [id, b] of this.books.entries()) {
      if (!b.summary || !b.zhName) toMigrate.push(id);
    }
    let migrated = 0;
    let i = 0;
    const total = toMigrate.length;
    const worker = async () => {
      while (i < total) {
        const idx = i++;
        const id = toMigrate[idx];
        const b = this.books.get(id);
        if (!b) continue;
        try {
          const meta = await this._extractBookMetadata(
            (msgs, opts) => this.client.chat(msgs, opts),
            (b.text || '').slice(0, 2000),
            { fallbackZhName: b.displayName || b.name }
          );
          b.zhName = meta.zhName || b.zhName || b.name;
          b.enName = meta.enName || b.enName || null;
          b.summary = meta.summary || b.summary || '';
          migrated++;
          if (onProgress) onProgress({ id, idx, total });
        } catch (err) {
          console.warn(`[migrate] ${id} failed:`, err.message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    return { migrated, total };
  }

  deleteBook(bookId) {
    if (!this.books.has(bookId)) return false;
    const book = this.books.get(bookId);
    // 同步从 BM25 索引移除
    if (this.bm25 && book && book.chunks) {
      for (const c of book.chunks) {
        this.bm25.removeDocument(c.id);
      }
    }
    this.books.delete(bookId);
    this.documents = this.documents.filter(d => d.metadata.bookId !== bookId);
    return true;
  }

  getStatus() {
    return {
      initialized: this.initialized,
      llmLoaded: !!this.client,
      booksCount: this.books.size,
      documentsCount: this.documents.length,
      chatModel: CHAT_MODEL,
      embeddingModel: EMBEDDING_MODEL,
    };
  }

  // === book-cache-persist ===

  /**
   * 暴露当前 cache 校验所需的运行环境元信息，供 server/index.js 调用 isCacheValid。
   */
  getCacheEnv() {
    return {
      embeddingModel: EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIM,
      chunkSize: DEFAULT_CHUNK_SIZE,
    };
  }

  /**
   * 把内存里的 book 序列化成 cache payload，字段 1:1 对应 books.get() 形状。
   * @param {string} bookId
   * @param {{pdfHash?: string|null}} opts
   */
  serializeBook(bookId, { pdfHash = null } = {}) {
    const b = this.books.get(bookId);
    if (!b) return null;
    return {
      // 必须与 server/rag/cache.mjs 的 SCHEMA_VERSION 保持一致
      schemaVersion: 2,
      embeddingModel: EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIM,
      chunkSize: DEFAULT_CHUNK_SIZE,
      pdfHash,
      bookId,
      bookName: b.name,
      displayName: b.displayName || b.name,
      zhName: b.zhName || null,
      enName: b.enName || null,
      summary: b.summary || '',
      source: b.source || 'pdf',
      sourceMeta: b.sourceMeta || {},
      createdAt: b.createdAt || Date.now(),
      text: b.text || '',
      chunks: b.chunks || [],
    };
  }

  /**
   * 从 cache payload 恢复 book 进内存，不调任何 LLM。
   * 返回 { chunks } 或 null（无效 payload）。
   */
  loadBookFromCache(cache) {
    if (!cache || !cache.bookId || !Array.isArray(cache.chunks)) return null;
    const docs = cache.chunks;
    this.books.set(cache.bookId, {
      bookId: cache.bookId,
      name: cache.bookName,
      displayName: cache.displayName || cache.bookName,
      zhName: cache.zhName || null,
      enName: cache.enName || null,
      summary: cache.summary || '',
      source: cache.source || 'pdf',
      sourceMeta: cache.sourceMeta || {},
      createdAt: cache.createdAt || Date.now(),
      chunks: docs,
      text: cache.text || '',
    });
    this.documents.push(...docs);
    if (this.bm25) {
      for (const d of docs) this.bm25.addDocument(d.id, d.pageContent);
    }
    return { chunks: docs.length };
  }
}

module.exports = RAGEngine;
