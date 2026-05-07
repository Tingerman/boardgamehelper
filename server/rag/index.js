// 智谱 AI 免费 API 配置
const { splitTextIntoChunks } = require('./pdf');

const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const CHAT_MODEL = process.env.ZHIPU_CHAT_MODEL || 'glm-4-flash';
const EMBEDDING_MODEL = process.env.ZHIPU_EMBEDDING_MODEL || 'embedding-3';
const EMBEDDING_DIM = Number(process.env.ZHIPU_EMBEDDING_DIM || 1024);

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

  async chat(messages, { temperature = 0.7, maxTokens = 1024 } = {}) {
    const data = await this._post('/chat/completions', {
      model: CHAT_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
    });
    return data.choices[0].message.content;
  }

  async translate(text, target = 'en', { reference = '' } = {}) {
    const targetName = target === 'en' ? 'English' : 'Chinese (Simplified)';

    const messages = [
      {
        role: 'system',
        content:
          `You are a professional translator. Translate the user's text to ${targetName}. ` +
          `Output ONLY the translation, with no explanations, no quotes, no prefixes.` +
          (reference
            ? ` You are given REFERENCE MATERIAL from a domain knowledge base. ` +
              `When a term or phrase in the source text corresponds to a term that ALREADY EXISTS in the reference material, ` +
              `you MUST reuse the EXACT original wording (capitalization, spelling, and phrasing) from the reference material ` +
              `instead of producing a new translation. Only translate freely for words that do not appear in the reference. ` +
              `Do NOT quote or mention the reference material itself in the output.`
            : ''),
      },
    ];

    if (reference) {
      messages.push({
        role: 'user',
        content: `REFERENCE MATERIAL (for terminology only, do not translate this):\n"""\n${reference}\n"""`,
      });
      messages.push({
        role: 'assistant',
        content: 'Understood. I will reuse exact terms from the reference when applicable.',
      });
    }

    messages.push({ role: 'user', content: text });

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
  }

  async initialize() {
    if (this.initialized) return;

    console.log('Initializing RAG engine (Zhipu API mode)...');
    this.client = new ZhipuClient(process.env.ZHIPU_API_KEY);
    this.initialized = true;
    console.log(`RAG engine initialized (chat=${CHAT_MODEL}, embedding=${EMBEDDING_MODEL})`);
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

  async ingestDocument(bookId, bookName, text, chunkSize = 500) {
    console.log(`Ingesting document: ${bookName}`);

    // 升级到 v2 切分器：段落感知 + 长段降级按句 + 50 字 overlap + metadata
    const chunks = splitTextIntoChunks(text, chunkSize, 50);

    const embeddings = [];
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await this.getEmbedding(chunks[i].text);
      embeddings.push(embedding);
      if ((i + 1) % 10 === 0) {
        console.log(`Embedded ${i + 1}/${chunks.length} chunks`);
      }
    }

    const docs = chunks.map((chunk, idx) => ({
      pageContent: chunk.text,
      embedding: embeddings[idx],
      metadata: {
        bookId,
        bookName,
        chunkIndex: idx,
        // 保留切分来源：'paragraph' 表示整段切出，'sentence' 表示大段被按句硬拆
        source: chunk.metadata && chunk.metadata.source,
      },
    }));

    this.books.set(bookId, {
      name: bookName,
      chunks: docs,
      text: text,
    });

    this.documents.push(...docs);

    console.log(`Ingested ${chunks.length} chunks for ${bookName}`);
    return { success: true, chunks: chunks.length };
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

  async query(question, bookId = null) {
    console.log('Processing query:', question);

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
      chunkCount: data.chunks.length,
    }));
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
}

module.exports = RAGEngine;
