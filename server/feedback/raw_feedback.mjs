// 用户 N5 拒答反馈的原始收集层
//
// 设计原则：采集端零判断、零分类
//   - 用户填的字符串可能是官方名 / 民间别名 / 库外游戏 / 错字 / 噪声，全部入库
//   - 分类逻辑放离线脚本（review_cli.mjs）
//
// 单进程下 fs.appendFileSync 原子安全，沿用 alias_staging 同模式

import fs from 'node:fs';
import path from 'node:path';

const RAW_PATH = path.resolve(process.cwd(), 'server/feedback/raw_feedback.jsonl');

function ensureDir() {
  fs.mkdirSync(path.dirname(RAW_PATH), { recursive: true });
}

export function recordRawFeedback({ userQuery, userInput }) {
  if (!userQuery || !userInput) return false;
  try {
    ensureDir();
    const line = JSON.stringify({
      ts: Date.now(),
      userQuery: String(userQuery).trim(),
      userInput: String(userInput).trim(),
      reviewed: false,
    }) + '\n';
    fs.appendFileSync(RAW_PATH, line);
    return true;
  } catch (err) {
    console.warn('[raw_feedback] record failed:', err.message);
    return false;
  }
}

export function readAllRawFeedback() {
  try {
    if (!fs.existsSync(RAW_PATH)) return [];
    const raw = fs.readFileSync(RAW_PATH, 'utf-8');
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch (_) {}
    }
    return out;
  } catch (err) {
    console.warn('[raw_feedback] read failed:', err.message);
    return [];
  }
}

export function _rawPathForTest() { return RAW_PATH; }
