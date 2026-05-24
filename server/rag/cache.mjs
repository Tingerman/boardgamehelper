// 书本缓存读写模块
//
// 设计目标：把 RAGEngine 内存里的 book + chunks + embeddings 落盘，
// 启动时校验 schema/model/dim/hash 一致后直接反序列化进内存，
// 跳过完整 ingest pipeline。
//
// 关键约定：
//   - 每本书一个文件 data/cache/{bookId}.cache.json
//   - 写入用 .tmp + rename 原子语义
//   - 读取异常（ENOENT / JSON 损坏）静默 → null，由调用方 treat as miss
//   - 失效任一字段不匹配 → 返回 false，调用方走完整 ingest

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import crypto from 'crypto';
import path from 'path';

export const SCHEMA_VERSION = 2;

/**
 * 流式 sha256，避免把整个 PDF 读进内存
 */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = createReadStream(filePath);
    s.on('data', c => h.update(c));
    s.on('end', () => resolve('sha256:' + h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * 读取并 JSON.parse cache 文件。
 * 文件不存在或解析失败一律返回 null（视为 miss）。
 */
export async function loadCache(cachePath) {
  let raw;
  try {
    raw = await fs.readFile(cachePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.warn('[cache] read failed:', cachePath, err.message);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[cache] JSON parse failed:', cachePath, err.message);
    return null;
  }
}

/**
 * 校验 cache 是否与当前运行环境兼容。
 * @param {object|null} cache
 * @param {{embeddingModel:string, embeddingDim:number, chunkSize:number, pdfHash:string|null}} expected
 */
export function isCacheValid(cache, expected) {
  if (!cache) return false;
  if (cache.schemaVersion !== SCHEMA_VERSION) return false;
  if (cache.embeddingModel !== expected.embeddingModel) return false;
  if (cache.embeddingDim !== expected.embeddingDim) return false;
  if (cache.chunkSize !== expected.chunkSize) return false;
  // pdfHash 仅对 source=pdf 有值；非 pdf source（B 站）传 null 即跳过
  if (expected.pdfHash != null && cache.pdfHash !== expected.pdfHash) return false;
  return true;
}

/**
 * 原子写：先写到 .tmp 再 rename。
 */
export async function writeCache(cachePath, payload) {
  const tmp = cachePath + '.tmp';
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
  await fs.rename(tmp, cachePath);
}

/**
 * 删除 cache 文件，不存在视为成功。
 */
export async function deleteCache(cachePath) {
  try {
    await fs.unlink(cachePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[cache] delete failed:', cachePath, err.message);
    }
  }
}
