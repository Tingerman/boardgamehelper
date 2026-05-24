// 轻量 BM25 索引（中英文混排）
//
// 公式：
//   IDF(t)  = ln( (N - df + 0.5) / (df + 0.5) + 1 )
//   tf'(t,d) = tf * (k1 + 1) / (tf + k1 * (1 - b + b * |d| / avgdl))
//   score(d, q) = Σ_t IDF(t) * tf'(t, d)
//
// 分词策略：
//   - ASCII 字母数字串：按 \W 切，统一小写（[a-z0-9]+）
//   - CJK 字符（\u4e00-\u9fff）：每个字符自成一 token
//   - 二者并存以兼容混排（如 "Through the Ages 第二轮"）
//
// 不引入外部依赖。增量 addDocument，启动时 ingestDocument 末尾调一次。

const K1 = 1.5;
const B = 0.75;

/** 分词：英文按词，中文按字 */
function tokenize(text) {
  if (!text) return [];
  const tokens = [];
  const re = /([a-z0-9]+)|([\u4e00-\u9fff])/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) tokens.push(m[1].toLowerCase());
    else if (m[2]) tokens.push(m[2]);
  }
  return tokens;
}

class BM25Index {
  constructor() {
    /** @type {Map<string, {tokens: string[], len: number, tf: Map<string, number>}>} */
    this.docs = new Map();
    /** @type {Map<string, number>} 倒排：term -> 出现该 term 的 doc 数 */
    this.df = new Map();
    this.totalLen = 0;
  }

  ready() {
    return this.docs.size > 0;
  }

  size() {
    return this.docs.size;
  }

  /**
   * 添加文档到索引
   * @param {string} id
   * @param {string} text
   */
  addDocument(id, text) {
    if (this.docs.has(id)) return; // 幂等
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(id, { tokens, len: tokens.length, tf });
    this.totalLen += tokens.length;
    // df 累计：每个 unique term +1
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  /**
   * 删除文档（保持与 rag.deleteBook 同步）
   */
  removeDocument(id) {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.totalLen -= doc.len;
    for (const t of doc.tf.keys()) {
      const cur = this.df.get(t) ?? 0;
      if (cur <= 1) this.df.delete(t);
      else this.df.set(t, cur - 1);
    }
    this.docs.delete(id);
  }

  /** 平均文档长度 */
  _avgdl() {
    return this.docs.size === 0 ? 0 : this.totalLen / this.docs.size;
  }

  /** 单 term 在单 doc 上的 BM25 分量 */
  _termScore(term, doc, avgdl, N) {
    const df = this.df.get(term);
    if (!df) return 0;
    const tf = doc.tf.get(term);
    if (!tf) return 0;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    const denom = tf + K1 * (1 - B + (B * doc.len) / (avgdl || 1));
    return idf * (tf * (K1 + 1)) / denom;
  }

  /**
   * 检索
   * @param {string} query
   * @param {number} topK
   * @returns {{id: string, score: number}[]}
   */
  search(query, topK = 10) {
    const qTokens = [...new Set(tokenize(query))]; // 去重，单 query 同一 term 只贡献一次
    if (qTokens.length === 0 || this.docs.size === 0) return [];

    const N = this.docs.size;
    const avgdl = this._avgdl();
    const scored = [];

    for (const [id, doc] of this.docs) {
      let s = 0;
      for (const t of qTokens) s += this._termScore(t, doc, avgdl, N);
      if (s > 0) scored.push({ id, score: s });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

// 单例：全应用共享一份索引
export const bm25Index = new BM25Index();

// 也导出 class 用于测试
export { BM25Index, tokenize };
