// bilibili-pipeline 单测
// 运行：node server/ingest/_bilibili_pipeline_test.mjs
//
// 由于 bilibili-pipeline 直接 import scrapeOpus/paddleOcr，无法注入 mock。
// 本测试只覆盖「不需要进 scrape 路径」的分支：
//   1. 缺 dynIdStr → invalid_dyn_id
//   2. 已 ingest 短路 → emit ingest_done(skipped)
//   3. inflight 锁：同一 dynIdStr 第二次调用立即返回 already_ingesting
//   4. inflight 完成后释放（finally）

import { ingestFromBilibiliOpus, inflightSet } from './bilibili-pipeline.mjs';

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}
function eq(a, b, name) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n    expect:', b, '\n    actual:', a); }
}

function makeRag({ hasBook = false } = {}) {
  return {
    books: { has: (id) => hasBook && id === 'bili-12345' },
    async ingestDocument() { return { chunks: 1 }; },
    serializeBook() { return null; },
  };
}
function captureSse() {
  const events = [];
  return { events, emit: (t, d) => events.push({ type: t, data: d }) };
}

// ---------- 1. 缺 dynIdStr ----------
{
  console.log('\n[1] 缺 dynIdStr → invalid_dyn_id');
  const rag = makeRag();
  const sse = captureSse();
  const r = await ingestFromBilibiliOpus({ dynIdStr: '', rag, sseEmit: sse.emit });
  eq(r.code, 'invalid_dyn_id', '返回 invalid_dyn_id');
  assert(sse.events.some(e => e.type === 'error' && e.data.code === 'invalid_dyn_id'), 'emit error');
}

// ---------- 2. 已 ingest 短路 ----------
{
  console.log('\n[2] 已 ingest → 短路');
  const rag = makeRag({ hasBook: true });
  const sse = captureSse();
  const r = await ingestFromBilibiliOpus({ dynIdStr: '12345', rag, sseEmit: sse.emit });
  assert(r.ok && r.skipped, '返回 skipped:true');
  assert(sse.events.some(e => e.type === 'ingest_done' && e.data.skipped), 'emit ingest_done(skipped)');
  eq(inflightSet.has('12345'), false, 'inflight 不残留（短路路径未加锁）');
}

// ---------- 3. inflight 锁 ----------
{
  console.log('\n[3] inflight 锁：手动注入');
  inflightSet.add('99999');
  const rag = makeRag();
  const sse = captureSse();
  const r = await ingestFromBilibiliOpus({ dynIdStr: '99999', rag, sseEmit: sse.emit });
  eq(r.code, 'already_ingesting', '返回 already_ingesting');
  inflightSet.delete('99999');
}

// ---------- 4. inflight 失败后会释放 ----------
{
  console.log('\n[4] scrape 失败后 inflight 释放');
  // dynIdStr 不存在，scrapeOpus 会失败 / 抛错（也可能因为网络）
  // 不论失败原因，关键是 finally 释放
  const rag = makeRag();
  const sse = captureSse();
  await ingestFromBilibiliOpus({ dynIdStr: 'invalid-test-id-xyz', rag, sseEmit: sse.emit });
  eq(inflightSet.has('invalid-test-id-xyz'), false, 'finally 释放 inflight');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
