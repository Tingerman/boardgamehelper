// N6 catalog matcher（双层）
//
// Layer 1: alias 硬匹配
//   - 池子来源：rag.books（已入库 PDF + 已入库 bili-*）+ catalog 未 ingested 条目
//   - 大小写归一 + 长度降序，最长优先
//   - O(n) 包含匹配
//
// Layer 2: 小模型 LLM 基于 summary 语义匹配
//   - 触发条件：Layer 1 miss AND 候选池非空
//   - prompt: 列出候选 (zhName + enName + summary)，让 LLM 输出 {index, confidence, reason}
//   - confidence < 阈值 视同 miss
//
// 设计点：
//   - alias index 启动时构建一次，每次 ingest 完成调 rebuildAliasIndex 增量重建
//   - matcher 不持有 rag 引用，所有数据通过 setMatcherSources 注入（便于测试）

const DEFAULT_LLM_TIMEOUT_MS = 4000;
const DEFAULT_CONFIDENCE_THRESHOLD = Number(process.env.N6_LLM_CONFIDENCE_THRESHOLD || 0.7);
// L2 兜底用更强的模型（默认 glm-4-air），glm-4-flash 在域外问题上幻觉严重
const DEFAULT_L2_MODEL = process.env.N6_LLM_MODEL || 'glm-4-air';

// 注入点
let _ragRef = null;
let _aliasIndex = []; // [{ alias, entry, kind: 'in_db'|'catalog_only' }]

/** 由外部（catalog/cache 或 server/index.js）调用 */
export function setMatcherSources(rag) {
  _ragRef = rag;
  rebuildAliasIndex();
}

/**
 * 增量重建 alias index。
 * 每次 ingest 完成、book 删除、catalog 加载完都应调用。
 */
export function rebuildAliasIndex() {
  const idx = [];
  const cacheRef = globalThis.__catalogCacheRef;
  const aliasesExtra = (cacheRef && typeof cacheRef.getAliasesExtraMap === 'function')
    ? cacheRef.getAliasesExtraMap()
    : {};
  // 1. rag.books 的 zhName / enName / displayName
  if (_ragRef && typeof _ragRef.getBooks === 'function') {
    for (const b of _ragRef.getBooks()) {
      const meta = typeof _ragRef.getBookMeta === 'function' ? _ragRef.getBookMeta(b.id) : null;
      const entry = {
        kind: 'in_db',
        bookId: b.id,
        source: (meta && meta.source) || b.source || 'pdf',
        zhName: (meta && meta.zhName) || b.zhName || null,
        enName: (meta && meta.enName) || b.enName || null,
        summary: (meta && meta.summary) || b.summary || '',
        displayName: (meta && meta.displayName) || b.name,
      };
      pushAlias(idx, entry.zhName, entry, 'in_db');
      pushAlias(idx, entry.enName, entry, 'in_db');
      // displayName 也参与 alias，但优先级低（不去重时长度排序自然解决）
      if (entry.displayName && entry.displayName !== entry.zhName) {
        pushAlias(idx, entry.displayName, entry, 'in_db');
      }
      // aliases_extra 增量
      const k = gameKeyOf(entry.zhName, entry.enName);
      if (k && Array.isArray(aliasesExtra[k])) {
        for (const a of aliasesExtra[k]) pushAlias(idx, a, entry, 'in_db');
      }
    }
  }
  // 2. catalog 未 ingested 条目
  try {
    // 动态拿 catalog（避免循环依赖）
    const cache = globalThis.__catalogCacheRef;
    if (cache && typeof cache.getCatalog === 'function') {
      for (const e of cache.getCatalog()) {
        if (e.ingested) continue;
        const entry = {
          kind: 'catalog_only',
          dynIdStr: e.dynIdStr,
          articleId: e.articleId,
          fullTitle: e.fullTitle,
          zhName: e.zhName,
          enName: e.enName,
          summary: e.summary,
        };
        pushAlias(idx, entry.zhName, entry, 'catalog_only');
        pushAlias(idx, entry.enName, entry, 'catalog_only');
        // aliases 字段（来自 setCatalog 注入的 aliases_extra）
        if (Array.isArray(e.aliases)) {
          for (const a of e.aliases) pushAlias(idx, a, entry, 'catalog_only');
        }
      }
    }
  } catch (err) {
    console.warn('[matcher] catalog ref unavailable:', err.message);
  }
  // 长度降序，最长优先
  idx.sort((a, b) => b.alias.length - a.alias.length);
  _aliasIndex = idx;
}

function pushAlias(idx, raw, entry, kind) {
  if (!raw || typeof raw !== 'string') return;
  const alias = raw.trim().toLowerCase();
  if (!alias) return;
  idx.push({ alias, entry, kind });
}

/**
 * Layer 1：硬匹配
 * @returns {{entry: object, kind: string} | null}
 */
export function matchByAlias(question) {
  if (!question) return null;
  const q = question.toLowerCase();
  for (const item of _aliasIndex) {
    if (q.includes(item.alias)) return { entry: item.entry, kind: item.kind };
  }
  return null;
}

/**
 * 构建 Layer 2 候选池：所有有 summary 的 entry。
 * 同时合并 in_db + catalog_only。
 */
export function buildCandidatePool() {
  const seen = new Set();
  const pool = [];
  for (const item of _aliasIndex) {
    const key = item.entry.kind === 'in_db'
      ? `db:${item.entry.bookId}`
      : `cat:${item.entry.dynIdStr}`;
    if (seen.has(key)) continue;
    if (!item.entry.summary && !item.entry.zhName) continue;
    seen.add(key);
    pool.push(item.entry);
  }
  return pool;
}

/**
 * Layer 2：小模型 LLM 基于 summary 语义匹配
 * @param {Function} chatFn  rag.client.chat
 * @param {string} question
 * @param {Array} candidates
 * @param {{timeoutMs?: number, threshold?: number, model?: string}} opts
 * @returns {Promise<{entry, confidence, reason}|null>}
 */
export async function matchByLlmIntro(chatFn, question, candidates, opts = {}) {
  if (!candidates || candidates.length === 0) return null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const threshold = opts.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const model = opts.model ?? DEFAULT_L2_MODEL;

  const numbered = candidates.map((c, i) => {
    const zh = c.zhName || '(无)';
    const en = c.enName || '(无)';
    const sum = c.summary || '(无简介)';
    return `${i + 1}. ${zh} (${en})：${sum}`;
  }).join('\n');

  // few-shot 反例 + 要求输出 picked_zh_name/picked_en_name 用于一致性校验
  const prompt = `任务：从候选桌游列表里挑出最匹配用户问题指向的那一本。
如果用户问的桌游名字完全不在候选列表中（看 zhName 和 enName 字段，子串不算），必须返回 index=null。
不要凭语义近似强行匹配。不要编造索引位置。

输出字段说明：
- index: 1~N 的整数；查不到必须用 null
- picked_zh_name / picked_en_name: 把所选 candidate 的 zhName 和 enName 原样抄回（用于自检），index=null 时此两字段也用 null
- confidence: 0~1，对所选项是否真的就是用户问的那本书的把握
- reason: 一句话说明
- key_tokens: 字符串数组，从用户问题里抽出最多 3 个你认为决定性的实词（中文桌游别名 / 关键词），用于回流学习；index=null 时也要输出（提取实词，留作离线分析）

反例：
用户问"三国杀几个人玩" → 候选里没有"三国杀"或"Sanguosha" → 返回 {"index":null,"picked_zh_name":null,"picked_en_name":null,"confidence":0,"reason":"候选列表中无三国杀","key_tokens":["三国杀"]}
用户问"催化剂卡牌效果" → 候选里没有"催化剂"或"Catalyst" → 返回 index=null
用户问"卡坦岛多少分" → 候选里有 1.卡坦岛(Catan) → 返回 {"index":1,"picked_zh_name":"卡坦岛","picked_en_name":"Catan","confidence":0.95,"reason":"问题明确指向卡坦岛","key_tokens":["卡坦岛"]}

用户问题：${question}

候选桌游列表：
${numbered}

严格输出 JSON，不要解释、不要 markdown 代码块：
{"index": <1-${candidates.length} 的整数 或 null>, "picked_zh_name": "<候选的 zhName 原样 或 null>", "picked_en_name": "<候选的 enName 原样 或 null>", "confidence": 0~1, "reason": "...", "key_tokens": ["...", "..."]}`;

  let raw;
  try {
    raw = await Promise.race([
      chatFn([{ role: 'user', content: prompt }], { temperature: 0, maxTokens: 240, model }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('LLM_TIMEOUT')), timeoutMs)),
    ]);
  } catch (err) {
    console.warn('[matcher] Layer 2 LLM failed:', err.message);
    return null;
  }

  const json = parseJson(raw);
  if (!json) return null;
  const idx = json.index;
  const conf = typeof json.confidence === 'number' ? json.confidence : 0;
  const keyTokens = Array.isArray(json.key_tokens)
    ? json.key_tokens.filter(t => typeof t === 'string' && t.trim().length >= 2).map(t => t.trim())
    : [];
  if (idx === null || idx === undefined) {
    console.log(`[matcher] L2 returned null: q="${question}" reason="${json.reason || ''}" model=${model}`);
    return null;
  }
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 1 || i > candidates.length) return null;

  // 一致性校验：LLM 返回的 picked_zh/en_name 必须和 candidates[i-1] 的 zhName/enName 对得上
  // 任一字段不匹配 → 视为幻觉，丢弃
  const cand = candidates[i - 1];
  const norm = (s) => (s || '').trim().toLowerCase();
  const pickedZh = norm(json.picked_zh_name);
  const pickedEn = norm(json.picked_en_name);
  const candZh = norm(cand.zhName);
  const candEn = norm(cand.enName);
  // 至少一个有值的字段对得上才算通过；两个都无意义（空 vs 空）算通过
  const zhOk = !pickedZh || !candZh ? true : pickedZh === candZh;
  const enOk = !pickedEn || !candEn ? true : pickedEn === candEn;
  // 但如果 LLM 给的 picked 和 cand 的字段都空，说明它没填或乱填 → 也判失败
  const hasAnyMatch = (pickedZh && pickedZh === candZh) || (pickedEn && pickedEn === candEn);
  if (!zhOk || !enOk || !hasAnyMatch) {
    console.warn(`[matcher] L2 hallucination guard: idx=${i} cand="${cand.zhName}/${cand.enName}" llm_picked="${json.picked_zh_name}/${json.picked_en_name}" → drop`);
    return null;
  }

  if (conf < threshold) {
    // 命中但 confidence 不达标：返回 null 但保留信息给埋点
    console.log(`[matcher] L2 below_threshold: q="${question}" picked="${cand.zhName}" conf=${conf} reason="${json.reason || ''}"`);
    return { entry: null, confidence: conf, reason: json.reason || '', belowThreshold: true, picked: cand, keyTokens };
  }
  console.log(`[matcher] L2 hit: q="${question}" picked="${cand.zhName}" conf=${conf} model=${model} reason="${json.reason || ''}"`);
  return { entry: cand, confidence: conf, reason: json.reason || '', keyTokens };
}

function parseJson(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/```json\s*|\s*```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
  }
  return null;
}

// 测试 / 内省入口
export function _getAliasIndex() { return _aliasIndex; }
export function _setAliasIndex(idx) { _aliasIndex = idx; }

/**
 * 把 zhName / enName 归一化作为 gameKey，用于聚合同一桌游的多个源。
 */
function gameKeyOf(zhName, enName) {
  const zh = (zhName || '').trim().toLowerCase();
  const en = (enName || '').trim().toLowerCase();
  return zh || en || null;
}

/**
 * 给定一组 bookIds，反查每本书对应的"桌游"，并把同一桌游下全部 catalog B站条目聚合返回。
 *
 * 用途：N8 catalog_probe 在 N4 retry 用尽后，反查"用户没选中的、且未 ingest 的"B站候选源。
 *
 * @param {string[]} bookIds
 * @param {{rag: any}} deps  rag 提供 getBookMeta / books.has；catalog 通过 globalThis.__catalogCacheRef 拿
 * @returns {Array<{
 *   gameKey: string,
 *   zhName: string|null,
 *   enName: string|null,
 *   bilibiliEntries: Array<{
 *     dynIdStr: string,
 *     articleId: number|null,
 *     fullTitle: string|null,
 *     ingested: boolean,
 *   }>
 * }>}
 */
export function findGamesByBookIds(bookIds, { rag } = {}) {
  if (!Array.isArray(bookIds) || bookIds.length === 0) return [];
  const cacheRef = globalThis.__catalogCacheRef;
  const catalog = cacheRef && typeof cacheRef.getCatalog === 'function'
    ? cacheRef.getCatalog()
    : [];
  if (catalog.length === 0) return [];

  // 1. 收集 seed gameKey 列表（来自 bookIds）
  const seedKeys = new Set();
  for (const bookId of bookIds) {
    if (typeof bookId !== 'string') continue;
    if (bookId.startsWith('bili-')) {
      const dynIdStr = bookId.slice(5);
      const e = catalog.find(x => x.dynIdStr === dynIdStr);
      if (e) {
        const k = gameKeyOf(e.zhName, e.enName);
        if (k) seedKeys.add(k);
      }
    } else {
      const meta = rag && typeof rag.getBookMeta === 'function' ? rag.getBookMeta(bookId) : null;
      if (!meta) continue;
      const k = gameKeyOf(meta.zhName, meta.enName);
      if (k) seedKeys.add(k);
    }
  }
  if (seedKeys.size === 0) return [];

  // 2. 把 catalog 按 gameKey 聚合，过滤出 seed 命中的游戏
  const games = new Map();  // gameKey → { gameKey, zhName, enName, bilibiliEntries: [] }
  for (const e of catalog) {
    const k = gameKeyOf(e.zhName, e.enName);
    if (!k || !seedKeys.has(k)) continue;
    if (!games.has(k)) {
      games.set(k, {
        gameKey: k,
        zhName: e.zhName || null,
        enName: e.enName || null,
        bilibiliEntries: [],
      });
    }
    games.get(k).bilibiliEntries.push({
      dynIdStr: e.dynIdStr,
      articleId: e.articleId || null,
      fullTitle: e.fullTitle || null,
      ingested: !!e.ingested,
    });
  }
  return Array.from(games.values());
}

/**
 * 把 candidate alias 注册到 gameKey 对应桌游：
 *   1. 写 aliases_extra.json（持久化）
 *   2. 同步内存 catalog entry.aliases
 *   3. 触发 rebuildAliasIndex（让 matchByAlias 立即生效）
 */
export function appendAlias(gameKey, alias) {
  if (!gameKey || !alias || typeof alias !== 'string') return false;
  const cleaned = alias.trim().toLowerCase();
  if (cleaned.length < 2) return false;

  const cacheRef = globalThis.__catalogCacheRef;
  if (!cacheRef || typeof cacheRef.getAliasesExtraMap !== 'function') return false;

  const map = cacheRef.getAliasesExtraMap();
  const arr = Array.isArray(map[gameKey]) ? map[gameKey] : [];
  if (arr.includes(cleaned)) return false;
  const next = { ...map, [gameKey]: [...arr, cleaned] };
  cacheRef.saveAliasesExtra(next);

  if (typeof cacheRef.getCatalog === 'function') {
    for (const e of cacheRef.getCatalog()) {
      const k = gameKeyOf(e.zhName, e.enName);
      if (k === gameKey) {
        if (!Array.isArray(e.aliases)) e.aliases = [];
        if (!e.aliases.includes(cleaned)) e.aliases.push(cleaned);
      }
    }
  }
  rebuildAliasIndex();
  return true;
}

/**
 * 反查游戏：用户输入正式名（zhName / enName / displayName / fullTitle）→ 找到 gameKey。
 * 用于 /api/feedback/alias：用户填写的游戏名先反查，找不到 → 提示该游戏未收录。
 */
export function findGameByName(name) {
  if (!name || typeof name !== 'string') return null;
  const target = name.trim().toLowerCase();
  if (!target) return null;

  if (_ragRef && typeof _ragRef.getBooks === 'function') {
    for (const b of _ragRef.getBooks()) {
      const meta = typeof _ragRef.getBookMeta === 'function' ? _ragRef.getBookMeta(b.id) : null;
      const zh = ((meta && meta.zhName) || b.zhName || '').trim().toLowerCase();
      const en = ((meta && meta.enName) || b.enName || '').trim().toLowerCase();
      const dn = ((meta && meta.displayName) || b.name || '').trim().toLowerCase();
      if (zh === target || en === target || dn === target) {
        const zhName = (meta && meta.zhName) || b.zhName || null;
        const enName = (meta && meta.enName) || b.enName || null;
        const k = gameKeyOf(zhName, enName);
        if (k) return { gameKey: k, zhName, enName };
      }
    }
  }
  const cacheRef = globalThis.__catalogCacheRef;
  if (cacheRef && typeof cacheRef.getCatalog === 'function') {
    for (const e of cacheRef.getCatalog()) {
      const zh = (e.zhName || '').trim().toLowerCase();
      const en = (e.enName || '').trim().toLowerCase();
      const ft = (e.fullTitle || '').trim().toLowerCase();
      if (zh === target || en === target || ft === target) {
        const k = gameKeyOf(e.zhName, e.enName);
        if (k) return { gameKey: k, zhName: e.zhName || null, enName: e.enName || null };
      }
    }
  }
  return null;
}

/** 给定 entry 返回 gameKey（导出给 catalog node 用） */
export function gameKeyForEntry(entry) {
  if (!entry) return null;
  return gameKeyOf(entry.zhName, entry.enName);
}

export { gameKeyOf };
