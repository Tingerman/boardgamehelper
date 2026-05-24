// Alias 蒸馏：周期性把 staging 候选升级到 aliases_extra.json
//
// 升级条件：
//   - count >= minCount        (出现次数阈值；demo 默认 3)
//   - distinctSources >= minDistinctSources (来源多样性；demo 默认 1，避免单用户测试卡死)
//   - alreadyPromoted === false
//   - 跨命中检测：candidate 在 staging 里只关联到 1 个 gameKey；多个游戏共享 → SKIP
//
// 升级动作：
//   1. matcher.appendAlias(gameKey, candidate) → 写 aliases_extra.json + rebuildAliasIndex
//   2. staging.markPromoted(gameKey, candidate) → 写 promoted 标记，下次跳过
//
// 命令行入口：见 promote_cli.mjs

import { aggregateStaging, markPromoted } from './alias_staging.mjs';

/**
 * 检查 candidate 在 staging 里关联了多少个不同 gameKey。
 * 通用术语（如"骰子"）会同时被多个游戏命中，应该 SKIP 避免被绑死到一个游戏。
 */
function checkCrossHit(candidate, agg) {
  const games = new Set();
  for (const item of agg) {
    if (item.candidate === candidate) games.add(item.gameKey);
  }
  return Array.from(games);
}

export async function promoteCycle({
  minCount = 3,
  minDistinctSources = 1,
  dryRun = false,
} = {}) {
  const agg = aggregateStaging();
  const promoted = [];
  const skipped = [];

  // 动态拿 matcher（避免在 ESM 顶部 import 时模块还没初始化的边界 case）
  const matcher = await import('../catalog/matcher.mjs');

  for (const item of agg) {
    if (item.alreadyPromoted) continue;
    if (item.count < minCount) {
      skipped.push({ ...item, reason: `count<${minCount}` });
      continue;
    }
    if (item.distinctSources < minDistinctSources) {
      skipped.push({ ...item, reason: `distinctSources<${minDistinctSources}` });
      continue;
    }
    const conflictGames = checkCrossHit(item.candidate, agg);
    if (conflictGames.length > 1) {
      skipped.push({ ...item, reason: `cross_hit:${conflictGames.join(',')}` });
      continue;
    }
    if (dryRun) {
      promoted.push({ ...item, dryRun: true });
      continue;
    }
    const ok = matcher.appendAlias(item.gameKey, item.candidate);
    if (ok) {
      markPromoted(item.gameKey, item.candidate);
      promoted.push(item);
    } else {
      skipped.push({ ...item, reason: 'appendAlias_failed_or_dup' });
    }
  }

  return { promoted, skipped };
}

// 测试入口
export { checkCrossHit };
