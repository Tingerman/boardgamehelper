// 智谱 AI 免费 API 配置
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

  async ingestDocument(bookId, bookName, text, chunkSize = 500) {
    console.log(`Ingesting document: ${bookName}`);

    const chunks = this.splitIntoChunks(text, chunkSize);

    const embeddings = [];
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await this.getEmbedding(chunks[i]);
      embeddings.push(embedding);
      if ((i + 1) % 10 === 0) {
        console.log(`Embedded ${i + 1}/${chunks.length} chunks`);
      }
    }

    const docs = chunks.map((chunk, idx) => ({
      pageContent: chunk,
      embedding: embeddings[idx],
      metadata: {
        bookId,
        bookName,
        chunkIndex: idx,
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

  splitIntoChunks(text, chunkSize) {
    const sentences = text.split(/(?<=[。！？.!?])\s+/);
    const chunks = [];
    let currentChunk = '';

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > chunkSize) {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += ' ' + sentence;
      }
    }

    if (currentChunk) chunks.push(currentChunk.trim());

    return chunks;
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
