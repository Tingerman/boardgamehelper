// B 站合集 catalog 加载
//
// 来源：https://api.bilibili.com/x/article/list/web/articles?id={collectionId}
// header 必须带 UA + Referer，否则返回 -352 限流。
//
// 输出：[{ dynIdStr, articleId, fullTitle, zhName, enName, summary, ingested:false }]
//
// 启动失败时返回空数组并打 warning，不阻塞服务。

const TITLE_RE = /^BGA桌游规则：(.+?)（(.+?)）$/;
const TITLE_RE_HALF = /^BGA桌游规则：(.+?)\((.+?)\)$/; // 兜底半角括号

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
};

function parseTitle(fullTitle) {
  if (!fullTitle) return { zhName: null, enName: null };
  const m = fullTitle.match(TITLE_RE) || fullTitle.match(TITLE_RE_HALF);
  if (!m) return { zhName: fullTitle, enName: null };
  return { zhName: m[1].trim(), enName: m[2].trim() };
}

/**
 * 拉取并解析 B 站合集
 * @param {string|number} collectionId
 * @returns {Promise<Array>}
 */
export async function fetchCatalog(collectionId) {
  if (!collectionId) {
    console.warn('[catalog] BILI_COLLECTION_ID 未配置，跳过加载');
    return [];
  }
  const url = `https://api.bilibili.com/x/article/list/web/articles?id=${collectionId}&web_location=333.1400`;
  let json;
  try {
    const res = await fetch(url, { headers: DEFAULT_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (err) {
    console.warn('[catalog] fetch failed, feature degraded:', err.message);
    return [];
  }
  if (!json || json.code !== 0 || !json.data || !Array.isArray(json.data.articles)) {
    console.warn('[catalog] unexpected response shape:', json && json.code, json && json.message);
    return [];
  }
  const entries = [];
  for (const a of json.data.articles) {
    if (!a) continue;
    const title = a.title || '';
    const { zhName, enName } = parseTitle(title);
    entries.push({
      dynIdStr: String(a.opus_id || a.dyn_id_str || a.id || ''),
      articleId: a.id || null,
      fullTitle: title,
      zhName,
      enName,
      summary: (a.summary || '').trim(),
      ingested: false,
    });
  }
  // 过滤掉解析不出 dynIdStr 的脏条目
  return entries.filter(e => e.dynIdStr);
}

// 导出仅供测试
export const __test__ = { parseTitle };
