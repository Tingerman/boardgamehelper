// N8 catalog_probe
//
// 触发条件：N4 faithfulness 在 retryCount 用尽后仍 != 'supported'
// 职责（双相）：
//   Phase 1（暂停前）：
//     1. 反查当前 bookIds 对应桌游下的 B站 catalog 候选源
//     2. 排除"已在 bookIds 内"/"已 ingest"
//     3. 无候选 → return（routeAfterCatalogProbe → END，保留 partial）
//     4. 有候选 → emit SSE 'suggest_l2' 然后 interrupt({candidates})，graph 暂停
//
//   Phase 2（resume 后）：
//     1. 收到 resume payload { accept, dynIdStrs }
//     2. accept=false 或 dynIdStrs 空 → return l2Resumed=false（routeAfterCatalogProbe → END）
//     3. accept=true → 串行调 ingestBilibiliByUrl 抓所有选中候选
//     4. 至少一条成功 → bookIds 扩展 + l2Resumed=true（→ N2 重检索）
//     5. 全部失败 → emit error，按 skip 处理
//
// 设计点：纯逻辑（除 ingest IO），无 LLM；用 LangGraph interrupt() 真中断。

import { interrupt } from '@langchain/langgraph';
import { getDeps } from '../deps.mjs';
import { findGamesByBookIds } from '../../catalog/matcher.mjs';

export async function catalogProbeNode(state, config) {
  const { bookIds = [], faithfulness = null } = state;
  const sseEmit = config?.configurable?.sseEmit ?? (() => {});
  const cacheDir = config?.configurable?.cacheDir;

  const { rag } = getDeps();
  const games = findGamesByBookIds(bookIds, { rag });

  const selectedSet = new Set(bookIds);
  const candidates = [];
  for (const g of games) {
    for (const e of g.bilibiliEntries) {
      if (!e.dynIdStr) continue;
      const candidateBookId = `bili-${e.dynIdStr}`;
      if (selectedSet.has(candidateBookId)) continue;
      if (rag && rag.books && rag.books.has && rag.books.has(candidateBookId)) continue;
      if (e.ingested) continue;

      candidates.push({
        gameZhName: g.zhName,
        gameEnName: g.enName,
        bookName: e.fullTitle || g.zhName || g.enName || '',
        dynIdStr: e.dynIdStr,
        articleId: e.articleId,
        url: `https://t.bilibili.com/${e.dynIdStr}`,
      });
    }
  }

  // 无候选 → 静默收口（无意义打扰用户）
  if (candidates.length === 0) {
    return { l2Candidates: [], l2Resumed: false };
  }

  // emit + interrupt（LangGraph 暂停，等 Command({resume}) 续跑）
  sseEmit('suggest_l2', {
    reason: faithfulness || 'unsupported',
    candidates,
  });
  const choice = interrupt({
    reason: faithfulness || 'unsupported',
    candidates,
  });

  // ===== resume 后逻辑 =====
  const accept = choice && choice.accept === true;
  const dynIdStrs = Array.isArray(choice && choice.dynIdStrs) ? choice.dynIdStrs : [];

  if (!accept || dynIdStrs.length === 0) {
    return { l2Candidates: candidates, l2Resumed: false };
  }

  // 用户接受：批量抓取选中的候选（允许 deps 注入 mock，便于测试）
  const deps = getDeps();
  const ingestBilibiliByUrl = deps.ingestBilibiliByUrl
    || (await import('../../ingest/by_url.mjs')).ingestBilibiliByUrl;
  const selectedCandidates = candidates.filter(c => dynIdStrs.includes(c.dynIdStr));
  const newBookIds = [];
  for (const c of selectedCandidates) {
    const r = await ingestBilibiliByUrl({
      url: c.url, rag, cacheDir, sseEmit,
    });
    if (r.ok) {
      newBookIds.push(r.bookId);
    } else {
      sseEmit('error', { code: 'l2_ingest_failed', message: r.error.message, url: c.url });
    }
  }

  if (newBookIds.length === 0) {
    return { l2Candidates: candidates, l2Resumed: false };
  }

  return {
    l2Candidates: candidates,
    bookIds: [...bookIds, ...newBookIds],
    l2Resumed: true,
  };
}
