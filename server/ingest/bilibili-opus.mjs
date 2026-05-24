// B 站 opus 页面爬取
//
// URL: https://www.bilibili.com/opus/{dynIdStr}/
// 数据藏在 <script>window.__INITIAL_STATE__ = {...};</script>，正则抠出。
//
// 输出：{ title, texts: string[], images: string[] }
//
// schema 变化时 throw 'OPUS_SCHEMA_CHANGED'。

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const STATE_RE = /window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?})\s*;\s*\(function/;
const STATE_RE_FALLBACK = /window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?});/;

export async function scrapeOpus(dynIdStr) {
  if (!dynIdStr) throw new Error('dynIdStr required');
  const url = `https://www.bilibili.com/opus/${dynIdStr}/`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`OPUS_HTTP_${res.status}`);
  const html = await res.text();

  const m = html.match(STATE_RE) || html.match(STATE_RE_FALLBACK);
  if (!m) throw new Error('OPUS_SCHEMA_CHANGED');

  let state;
  try {
    state = JSON.parse(m[1]);
  } catch (err) {
    throw new Error('OPUS_JSON_PARSE_FAILED');
  }

  const detail = state && state.detail;
  if (!detail) throw new Error('OPUS_SCHEMA_CHANGED');

  const title = (detail.basic && detail.basic.title) || '';

  // 段落在 detail.modules[*].module_content.paragraphs
  const paragraphs = [];
  if (Array.isArray(detail.modules)) {
    for (const mod of detail.modules) {
      const ps = mod && mod.module_content && mod.module_content.paragraphs;
      if (Array.isArray(ps)) paragraphs.push(...ps);
    }
  }
  if (paragraphs.length === 0) throw new Error('OPUS_SCHEMA_CHANGED');

  const texts = [];
  const images = [];
  for (const p of paragraphs) {
    if (!p) continue;
    if (p.para_type === 1 && p.text) {
      // 富文本 nodes
      if (Array.isArray(p.text.nodes)) {
        const seg = p.text.nodes.map(n => (n && n.word && n.word.words) || '').filter(Boolean).join('');
        if (seg) texts.push(seg);
      } else if (typeof p.text.text === 'string') {
        texts.push(p.text.text);
      }
    } else if (p.para_type === 2 && p.pic && Array.isArray(p.pic.pics)) {
      for (const img of p.pic.pics) {
        if (img && img.url) images.push(img.url);
      }
    }
  }

  return { title, texts, images };
}
