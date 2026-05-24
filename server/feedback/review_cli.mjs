#!/usr/bin/env node
// 离线反馈分类脚本
//
// 读 raw_feedback.jsonl 每条 (userQuery, userInput)，
// 对 userInput 做 catalog 模糊匹配 + 可选 LLM 校验，
// 三档输出：
//   1. high_alias        userInput 高度疑似某 catalog 游戏的别名 → 建议补 alias
//   2. high_ingest_wanted userInput 和任何已收录游戏都不相关  → 建议入 ingest 队列
//   3. need_review        中间地带，人工看 userQuery 上下文判
//
// 不自动落盘 aliases_extra.json，只输出建议。
// 升级动作由人工执行：
//   - alias 候选：手动改 server/data/aliases_extra.json
//   - ingest 候选：去 B 站/找 PDF 后 /api/ingest
//
// 用法：
//   node server/feedback/review_cli.mjs [--use-llm]

import { readAllRawFeedback } from './raw_feedback.mjs';

function parseArgs(argv) {
  return { useLlm: argv.includes('--use-llm') };
}

async function bootstrapCatalog() {
  const cache = await import('../catalog/cache.mjs');
  globalThis.__catalogCacheRef = cache;
  cache.loadAliasesExtra();
  try {
    const bili = await import('../catalog/bilibili.mjs');
    const collectionId = process.env.BILI_COLLECTION_ID;
    const entries = await bili.fetchCatalog(collectionId);
    cache.setCatalog(entries);
    console.log(`[review_cli] catalog loaded: ${entries.length} entries`);
  } catch (err) {
    console.warn('[review_cli] catalog load failed:', err.message);
    cache.setCatalog([]);
  }
}

/**
 * 编辑距离（Levenshtein），用于短字符串近似度
 */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * 给定 userInput，在 catalog 全表挖 top-K 候选。
 * 候选词来源：每个 entry 的 zhName/enName/fullTitle/aliases
 * 评分：子串匹配（任一方向）= 1.0；否则 1 - editDist / max(len)
 */
function fuzzyMatch(userInput, catalog, topK = 3) {
  const q = userInput.trim().toLowerCase();
  if (!q) return [];
  const candidates = [];
  for (const e of catalog) {
    const names = [e.zhName, e.enName, e.fullTitle, ...(e.aliases || [])].filter(Boolean);
    let best = { score: 0, matchedName: null };
    for (const n of names) {
      const cn = String(n).trim().toLowerCase();
      if (!cn) continue;
      let score = 0;
      if (cn.includes(q) || q.includes(cn)) {
        score = 1.0;
      } else {
        const dist = editDistance(q, cn);
        const maxLen = Math.max(q.length, cn.length);
        score = maxLen === 0 ? 0 : 1 - dist / maxLen;
      }
      if (score > best.score) best = { score, matchedName: n };
    }
    if (best.score > 0) {
      candidates.push({
        entry: e, score: best.score, matchedName: best.matchedName,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topK);
}

/**
 * 三档分类阈值：
 *   score >= 0.85 → high_alias
 *   score < 0.4   → high_ingest_wanted
 *   其他          → need_review
 */
function classify(topMatches) {
  if (topMatches.length === 0) return 'high_ingest_wanted';
  const top = topMatches[0].score;
  if (top >= 0.85) return 'high_alias';
  if (top < 0.4) return 'high_ingest_wanted';
  return 'need_review';
}

/**
 * 可选：用 LLM 二次校验中置信度档（当前留 hook，调用方传 chatFn 即可启用）
 */
async function llmVerify(chatFn, userInput, userQuery, candidates) {
  if (!chatFn || candidates.length === 0) return null;
  const numbered = candidates.map((c, i) =>
    `${i + 1}. ${c.entry.zhName || ''} (${c.entry.enName || ''})`).join('\n');
  const prompt = `用户在问"${userQuery}"，他把想查的游戏称作"${userInput}"。

下列哪个候选最可能就是用户说的那个游戏？或者都不是（说明该游戏未收录）？

${numbered}

严格输出 JSON，无 markdown：
{"index": <1-${candidates.length} 或 null>, "confidence": 0~1, "reason": "..."}`;
  try {
    const raw = await chatFn([{ role: 'user', content: prompt }], { temperature: 0, maxTokens: 200 });
    const cleaned = String(raw).replace(/```json\s*|\s*```/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (err) {
    console.warn('[review_cli] LLM verify failed:', err.message);
    return null;
  }
}

async function main() {
  const opt = parseArgs(process.argv);
  await bootstrapCatalog();

  const cache = await import('../catalog/cache.mjs');
  const catalog = cache.getCatalog();
  const records = readAllRawFeedback().filter(r => !r.reviewed);
  console.log(`\n[review_cli] ${records.length} unreviewed feedback record(s), catalog size=${catalog.length}\n`);

  let chatFn = null;
  if (opt.useLlm) {
    try {
      // 复用 RAG client，用法和 N6 L2 一致
      const RAGEngine = (await import('../rag/index.js')).default || (await import('../rag/index.js'));
      // 简化：仅初始化 client 不 ingest
      // 实际复用要改成从 server 导出，这里 demo 阶段先打 hook 留位
      console.log('[review_cli] --use-llm 暂未接入，先用 fuzzy 分档');
    } catch (_) {}
  }

  const buckets = { high_alias: [], high_ingest_wanted: [], need_review: [] };
  for (const r of records) {
    const top = fuzzyMatch(r.userInput, catalog, 3);
    let bucket = classify(top);

    let llmJudge = null;
    if (chatFn && bucket === 'need_review') {
      llmJudge = await llmVerify(chatFn, r.userInput, r.userQuery, top);
      if (llmJudge && typeof llmJudge.confidence === 'number') {
        if (llmJudge.index && llmJudge.confidence >= 0.7) bucket = 'high_alias';
        else if (llmJudge.index === null && llmJudge.confidence >= 0.7) bucket = 'high_ingest_wanted';
      }
    }
    buckets[bucket].push({ record: r, top, llmJudge });
  }

  // 输出
  console.log('=== high_alias (建议补 alias) ===');
  for (const it of buckets.high_alias) {
    const pick = it.top[0];
    console.log(`  query="${it.record.userQuery}"`);
    console.log(`    用户填="${it.record.userInput}"  match→"${pick.matchedName}" (score=${pick.score.toFixed(2)})`);
    console.log(`    建议：在 aliases_extra.json["${(pick.entry.zhName || pick.entry.enName || '').toLowerCase()}"] 加入 "${it.record.userInput.toLowerCase()}"`);
  }
  console.log(`\n=== high_ingest_wanted (建议补数据源) ===`);
  for (const it of buckets.high_ingest_wanted) {
    console.log(`  query="${it.record.userQuery}"`);
    console.log(`    用户填="${it.record.userInput}"  → 库内无相似游戏，去 B 站/找 PDF 补 ingest`);
  }
  console.log(`\n=== need_review (人工确认) ===`);
  for (const it of buckets.need_review) {
    console.log(`  query="${it.record.userQuery}"`);
    console.log(`    用户填="${it.record.userInput}"`);
    for (const c of it.top) {
      console.log(`      候选: ${c.entry.zhName || ''} (${c.entry.enName || ''}) score=${c.score.toFixed(2)}`);
    }
  }
  console.log(`\n[review_cli] summary: alias=${buckets.high_alias.length} ingest=${buckets.high_ingest_wanted.length} review=${buckets.need_review.length}`);
}

main().catch(err => {
  console.error('[review_cli] fatal:', err);
  process.exit(1);
});
