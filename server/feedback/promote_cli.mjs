#!/usr/bin/env node
// Alias 蒸馏命令行入口
//
// 用法：
//   node server/feedback/promote_cli.mjs [--dry-run] [--min-count=N] [--min-sources=N]
//
// 注意：本脚本不启 HTTP 服务，但需要 catalog cache + matcher 已初始化。
// 因此先模拟 server/index.js 的 catalog 初始化（拉 B 站合集 + setCatalog）。
// 仅做 catalog（不需要 rag/books），matcher 的 _ragRef 留空，appendAlias 通过 catalog cache 落盘。

import { promoteCycle } from './alias_promoter.mjs';

function parseArgs(argv) {
  const opt = { dryRun: false, minCount: 3, minDistinctSources: 1 };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') opt.dryRun = true;
    else if (a.startsWith('--min-count=')) opt.minCount = parseInt(a.slice('--min-count='.length), 10) || 3;
    else if (a.startsWith('--min-sources=')) opt.minDistinctSources = parseInt(a.slice('--min-sources='.length), 10) || 1;
  }
  return opt;
}

async function bootstrapCatalog() {
  const cache = await import('../catalog/cache.mjs');
  globalThis.__catalogCacheRef = cache;
  // 加载 aliases_extra.json
  cache.loadAliasesExtra();
  // 拉 B 站 catalog 让 findGameByName / appendAlias 能找到 game entry
  try {
    const bili = await import('../catalog/bilibili.mjs');
    const collectionId = process.env.BILI_COLLECTION_ID;
    const entries = await bili.fetchCatalog(collectionId);
    cache.setCatalog(entries);
    console.log(`[promote_cli] catalog loaded: ${entries.length} entries`);
  } catch (err) {
    console.warn('[promote_cli] catalog load failed (continuing with empty catalog):', err.message);
    cache.setCatalog([]);
  }
  const matcher = await import('../catalog/matcher.mjs');
  matcher.setMatcherSources(null); // 仅 catalog，不依赖 rag
}

async function main() {
  const opt = parseArgs(process.argv);
  console.log('[promote_cli] options:', opt);
  await bootstrapCatalog();
  const { promoted, skipped } = await promoteCycle(opt);

  console.log(`\n=== Promoted (${promoted.length}) ===`);
  for (const p of promoted) {
    console.log(`  ${p.gameKey.padEnd(30)} ← "${p.candidate}"  (count=${p.count}, sources=${p.distinctSources})${p.dryRun ? ' [DRY-RUN]' : ''}`);
  }
  console.log(`\n=== Skipped (${skipped.length}) ===`);
  for (const s of skipped) {
    console.log(`  ${s.gameKey.padEnd(30)} ← "${s.candidate}"  reason=${s.reason}`);
  }
}

main().catch(err => {
  console.error('[promote_cli] fatal:', err);
  process.exit(1);
});
