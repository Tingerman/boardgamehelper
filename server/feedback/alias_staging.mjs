// Alias staging：alias 自进化机制的候选池存储层
//
// 设计：
//   - 单文件 jsonl，复用 server/metrics/n6.jsonl 的同步 append 模式
//   - 单进程下 fs.appendFileSync 是原子的，零并发问题
//   - 不引入数据库，方便面试讲"零基础设施成本"
//
// 记录类型：
//   - candidate: { type:'candidate', ts, source, gameKey, gameZhName, candidate, userQuery, extra }
//   - promoted:  { type:'promoted',  ts, gameKey, candidate }     ← 升级标记
//
// API：
//   - recordCandidate({ source, gameKey, gameZhName, candidate, userQuery, extra })
//   - aggregateStaging() → [{ gameKey, candidate, count, distinctSources, samples, alreadyPromoted }]
//   - markPromoted(gameKey, candidate)

import fs from 'node:fs';
import path from 'node:path';

const STAGING_PATH = path.resolve(process.cwd(), 'server/feedback/alias_staging.jsonl');

function ensureDir() {
  fs.mkdirSync(path.dirname(STAGING_PATH), { recursive: true });
}

function normalize(s) {
  return (s || '').trim().toLowerCase();
}

export function recordCandidate({ source, gameKey, gameZhName, candidate, userQuery, extra }) {
  if (!source || !gameKey || !candidate) return false;
  const cleaned = normalize(candidate);
  if (cleaned.length < 2) return false;
  try {
    ensureDir();
    const line = JSON.stringify({
      type: 'candidate',
      ts: Date.now(),
      source,
      gameKey,
      gameZhName: gameZhName || null,
      candidate: cleaned,
      userQuery: userQuery || null,
      extra: extra || null,
    }) + '\n';
    fs.appendFileSync(STAGING_PATH, line);
    return true;
  } catch (err) {
    console.warn('[alias_staging] recordCandidate failed:', err.message);
    return false;
  }
}

function readAll() {
  try {
    if (!fs.existsSync(STAGING_PATH)) return [];
    const raw = fs.readFileSync(STAGING_PATH, 'utf-8');
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch (_) {}
    }
    return out;
  } catch (err) {
    console.warn('[alias_staging] read failed:', err.message);
    return [];
  }
}

export function aggregateStaging() {
  const records = readAll();
  const promoted = new Set(); // `${gameKey}::${candidate}`
  const map = new Map(); // key -> { gameKey, candidate, count, sources:Set, samples:[] }
  for (const r of records) {
    if (r.type === 'promoted') {
      promoted.add(`${r.gameKey}::${normalize(r.candidate)}`);
      continue;
    }
    if (r.type !== 'candidate') continue;
    if (!r.gameKey || !r.candidate) continue;
    const cand = normalize(r.candidate);
    const key = `${r.gameKey}::${cand}`;
    if (!map.has(key)) {
      map.set(key, {
        gameKey: r.gameKey,
        gameZhName: r.gameZhName || null,
        candidate: cand,
        count: 0,
        sources: new Set(),
        samples: [],
      });
    }
    const item = map.get(key);
    item.count += 1;
    if (r.source) item.sources.add(r.source);
    if (item.samples.length < 3 && r.userQuery) item.samples.push(r.userQuery);
  }
  const out = [];
  for (const [key, item] of map.entries()) {
    out.push({
      gameKey: item.gameKey,
      gameZhName: item.gameZhName,
      candidate: item.candidate,
      count: item.count,
      distinctSources: item.sources.size,
      samples: item.samples,
      alreadyPromoted: promoted.has(key),
    });
  }
  return out;
}

export function markPromoted(gameKey, candidate) {
  if (!gameKey || !candidate) return false;
  try {
    ensureDir();
    const line = JSON.stringify({
      type: 'promoted',
      ts: Date.now(),
      gameKey,
      candidate: normalize(candidate),
    }) + '\n';
    fs.appendFileSync(STAGING_PATH, line);
    return true;
  } catch (err) {
    console.warn('[alias_staging] markPromoted failed:', err.message);
    return false;
  }
}

export function _stagingPathForTest() { return STAGING_PATH; }
