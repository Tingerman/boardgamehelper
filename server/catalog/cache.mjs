// catalog 内存缓存 + 已入库标记同步
//
// 在内存中以 dynIdStr 为主键存放 catalog 条目，提供：
//   - setCatalog(entries): 启动时注入
//   - getCatalog(): 给 matcher 用（构建 alias index）
//   - markIngested(dynIdStr): N7 完成后标记
//   - reconcileIngestedFromRag(rag): 启动时回扫 rag.books，把已存在的 bili-* book 反向标 ingested
//
// alias 自进化：
//   - aliases_extra.json 是 alias 增量持久层（gameKey -> string[]）
//   - loadAliasesExtra / saveAliasesExtra / getAliasesExtraMap 提供给 matcher 用
//   - setCatalog 启动时把对应 alias 合并进 entry.aliases，向后兼容旧 entry（默认 []）

import fs from 'node:fs';
import path from 'node:path';

const ALIASES_EXTRA_PATH = path.resolve(process.cwd(), 'server/data/aliases_extra.json');

let catalog = []; // entries
const dynIdSet = new Map(); // dynIdStr -> entry
let aliasesExtra = null; // gameKey -> string[]

function gameKeyOf(zhName, enName) {
  const zh = (zhName || '').trim().toLowerCase();
  const en = (enName || '').trim().toLowerCase();
  return zh || en || null;
}

export function loadAliasesExtra() {
  try {
    if (!fs.existsSync(ALIASES_EXTRA_PATH)) {
      aliasesExtra = {};
      return aliasesExtra;
    }
    const raw = fs.readFileSync(ALIASES_EXTRA_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    aliasesExtra = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (err) {
    console.warn('[catalog] aliases_extra.json load failed, using empty map:', err.message);
    aliasesExtra = {};
  }
  return aliasesExtra;
}

export function saveAliasesExtra(map) {
  try {
    fs.mkdirSync(path.dirname(ALIASES_EXTRA_PATH), { recursive: true });
    fs.writeFileSync(ALIASES_EXTRA_PATH, JSON.stringify(map, null, 2) + '\n');
    aliasesExtra = map;
    return true;
  } catch (err) {
    console.warn('[catalog] aliases_extra.json save failed:', err.message);
    return false;
  }
}

export function getAliasesExtraMap() {
  if (aliasesExtra === null) loadAliasesExtra();
  return aliasesExtra;
}

export function setCatalog(entries) {
  if (aliasesExtra === null) loadAliasesExtra();
  catalog = entries.slice().map(e => {
    const key = gameKeyOf(e.zhName, e.enName);
    const extra = (key && aliasesExtra[key]) ? aliasesExtra[key] : [];
    return {
      ...e,
      aliases: Array.isArray(e.aliases) ? [...e.aliases, ...extra] : extra.slice(),
    };
  });
  dynIdSet.clear();
  for (const e of catalog) dynIdSet.set(e.dynIdStr, e);
}

export function getCatalog() {
  return catalog;
}

export function getEntry(dynIdStr) {
  return dynIdSet.get(dynIdStr) || null;
}

export function markIngested(dynIdStr) {
  const e = dynIdSet.get(dynIdStr);
  if (e) e.ingested = true;
}

/**
 * 启动时回扫 rag，把 bili-{dynIdStr} 已入库的标 ingested
 */
export function reconcileIngestedFromRag(rag) {
  if (!rag || typeof rag.getBooks !== 'function') return 0;
  const books = rag.getBooks();
  let n = 0;
  for (const b of books) {
    if (typeof b.id === 'string' && b.id.startsWith('bili-')) {
      const dyn = b.id.slice('bili-'.length);
      const e = dynIdSet.get(dyn);
      if (e) { e.ingested = true; n++; }
    }
  }
  return n;
}

export function _resetForTest() {
  catalog = [];
  dynIdSet.clear();
  aliasesExtra = null;
}
