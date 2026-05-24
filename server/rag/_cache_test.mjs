// cache 模块单测
// 运行：node server/rag/_cache_test.mjs

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { sha256File, loadCache, isCacheValid, writeCache, deleteCache, SCHEMA_VERSION } from './cache.mjs';

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n    expect:', expected, '\n    actual:', actual); }
}
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-test-'));

const baseExpected = {
  embeddingModel: 'embedding-3',
  embeddingDim: 1024,
  chunkSize: 500,
  pdfHash: 'sha256:abc',
};

const samplePayload = {
  schemaVersion: SCHEMA_VERSION,
  embeddingModel: 'embedding-3',
  embeddingDim: 1024,
  chunkSize: 500,
  pdfHash: 'sha256:abc',
  bookId: 'book-1',
  bookName: 'Test',
  displayName: 'Test',
  zhName: '测试',
  enName: 'Test',
  summary: '一段简介',
  source: 'pdf',
  sourceMeta: {},
  createdAt: 1700000000,
  text: 'hello world',
  chunks: [
    { id: 'book-1::0', pageContent: 'hello', embedding: [0.1, 0.2], metadata: { bookId: 'book-1', chunkIndex: 0 } },
  ],
};

// 1. writeCache + loadCache 往返
{
  const p = path.join(tmpRoot, 'roundtrip.cache.json');
  await writeCache(p, samplePayload);
  const back = await loadCache(p);
  eq(back, samplePayload, 'writeCache + loadCache roundtrip');
}

// 2. loadCache ENOENT → null
{
  const r = await loadCache(path.join(tmpRoot, 'not-exist.json'));
  eq(r, null, 'loadCache ENOENT returns null');
}

// 3. loadCache 损坏 JSON → null
{
  const p = path.join(tmpRoot, 'bad.json');
  await fs.writeFile(p, 'not-json{', 'utf8');
  const r = await loadCache(p);
  eq(r, null, 'loadCache broken JSON returns null');
}

// 4. isCacheValid 命中
{
  assert(isCacheValid(samplePayload, baseExpected), 'isCacheValid happy path');
}

// 5. isCacheValid null 输入
{
  assert(!isCacheValid(null, baseExpected), 'isCacheValid null cache');
}

// 6. isCacheValid schemaVersion 不匹配
{
  const c = { ...samplePayload, schemaVersion: 999 };
  assert(!isCacheValid(c, baseExpected), 'isCacheValid schema mismatch');
}

// 7. isCacheValid embeddingModel 不匹配
{
  const c = { ...samplePayload, embeddingModel: 'other-model' };
  assert(!isCacheValid(c, baseExpected), 'isCacheValid embeddingModel mismatch');
}

// 8. isCacheValid embeddingDim 不匹配
{
  const c = { ...samplePayload, embeddingDim: 768 };
  assert(!isCacheValid(c, baseExpected), 'isCacheValid embeddingDim mismatch');
}

// 9. isCacheValid chunkSize 不匹配
{
  const c = { ...samplePayload, chunkSize: 800 };
  assert(!isCacheValid(c, baseExpected), 'isCacheValid chunkSize mismatch');
}

// 10. isCacheValid pdfHash 不匹配
{
  const c = { ...samplePayload, pdfHash: 'sha256:other' };
  assert(!isCacheValid(c, baseExpected), 'isCacheValid pdfHash mismatch');
}

// 11. isCacheValid pdfHash=null（B 站源）跳过 hash 校验
{
  const c = { ...samplePayload, pdfHash: null };
  const exp = { ...baseExpected, pdfHash: null };
  assert(isCacheValid(c, exp), 'isCacheValid skips hash when expected.pdfHash=null');
}

// 12. 原子写：rename 不留 .tmp 残留
{
  const p = path.join(tmpRoot, 'atomic.cache.json');
  await writeCache(p, samplePayload);
  let tmpExists = false;
  try { await fs.stat(p + '.tmp'); tmpExists = true; } catch (_) {}
  assert(!tmpExists, 'atomic write leaves no .tmp residue');
  const back = await loadCache(p);
  eq(back.bookId, 'book-1', 'atomic write content correct');
}

// 13. deleteCache 文件存在
{
  const p = path.join(tmpRoot, 'to-del.cache.json');
  await writeCache(p, samplePayload);
  await deleteCache(p);
  const r = await loadCache(p);
  eq(r, null, 'deleteCache removes file');
}

// 14. deleteCache 文件不存在不抛
{
  await deleteCache(path.join(tmpRoot, 'never-existed.json'));
  assert(true, 'deleteCache ENOENT silent');
}

// 15. sha256File 稳定
{
  const p = path.join(tmpRoot, 'hash.bin');
  await fs.writeFile(p, 'hello');
  const h1 = await sha256File(p);
  const h2 = await sha256File(p);
  eq(h1, h2, 'sha256File deterministic');
  assert(h1.startsWith('sha256:'), 'sha256File prefix');
}

// 16. sha256File 内容变化 → hash 变化
{
  const p1 = path.join(tmpRoot, 'h1.bin');
  const p2 = path.join(tmpRoot, 'h2.bin');
  await fs.writeFile(p1, 'aaa');
  await fs.writeFile(p2, 'bbb');
  const h1 = await sha256File(p1);
  const h2 = await sha256File(p2);
  assert(h1 !== h2, 'sha256File differs on different content');
}

// 17. v1 cache 被 v2 拒绝（升级保护）
{
  const v1Cache = { ...samplePayload, schemaVersion: 1 };
  assert(!isCacheValid(v1Cache, baseExpected), 'v1 cache rejected by v2');
}

// 18. v2 cache round-trip 保留 imageIndices 字段
{
  const p = path.join(tmpRoot, 'imgidx.cache.json');
  const payloadWithImgIdx = {
    ...samplePayload,
    chunks: [{
      id: 'book-1::0',
      pageContent: 'p1',
      embedding: [0.1, 0.2],
      metadata: { bookId: 'book-1', chunkIndex: 0, imageIndices: [3, 5] },
    }],
  };
  await writeCache(p, payloadWithImgIdx);
  const back = await loadCache(p);
  assert(
    JSON.stringify(back.chunks[0].metadata.imageIndices) === '[3,5]',
    'imageIndices preserved through cache round-trip'
  );
}

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
