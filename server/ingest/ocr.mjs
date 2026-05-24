// 百度 OCR 客户端
//
// 接口：https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic
// access_token：通过 API_KEY + SECRET_KEY 走 /oauth/2.0/token 换，缓存 30 天。
//
// paddleOcr(imgUrl) 返回字符串（拼接 words_result[].words）。
// 单次失败重试 1 次；配额耗尽 throw 'OCR_QUOTA_EXHAUSTED'。

const TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const OCR_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

let _token = null;
let _tokenExpireAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_token && now < _tokenExpireAt) return _token;
  const apiKey = process.env.BAIDU_OCR_API_KEY;
  const secretKey = process.env.BAIDU_OCR_SECRET_KEY;
  if (!apiKey || !secretKey) throw new Error('OCR_KEY_MISSING');

  const url = `${TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error(`OCR_TOKEN_HTTP_${res.status}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('OCR_TOKEN_INVALID');
  _token = json.access_token;
  _tokenExpireAt = now + TOKEN_TTL_MS;
  return _token;
}

async function fetchAsBase64(imgUrl) {
  const res = await fetch(imgUrl, {
    headers: { Referer: 'https://www.bilibili.com/' },
  });
  if (!res.ok) throw new Error(`IMG_HTTP_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

async function ocrOnce(imgBase64) {
  const token = await getAccessToken();
  const body = new URLSearchParams({ image: imgBase64 });
  const res = await fetch(`${OCR_URL}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`OCR_HTTP_${res.status}`);
  const json = await res.json();
  // 配额耗尽错误码
  if (json.error_code === 17 || json.error_code === 18 || json.error_code === 19) {
    throw new Error('OCR_QUOTA_EXHAUSTED');
  }
  if (json.error_code) {
    throw new Error(`OCR_ERR_${json.error_code}_${json.error_msg || ''}`);
  }
  if (!Array.isArray(json.words_result)) return '';
  return json.words_result.map(w => w.words || '').filter(Boolean).join('\n');
}

export async function paddleOcr(imgUrl) {
  if (!imgUrl) return '';
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const b64 = await fetchAsBase64(imgUrl);
      return await ocrOnce(b64);
    } catch (err) {
      lastErr = err;
      // 配额耗尽不重试
      if (err && err.message && err.message.startsWith('OCR_QUOTA_EXHAUSTED')) throw err;
    }
  }
  throw lastErr;
}

/**
 * 从本地文件 OCR（用户上传图片走这条）
 */
export async function paddleOcrFile(filePath) {
  if (!filePath) return '';
  const fs = await import('fs/promises');
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const buf = await fs.readFile(filePath);
      const b64 = buf.toString('base64');
      return await ocrOnce(b64);
    } catch (err) {
      lastErr = err;
      if (err && err.message && err.message.startsWith('OCR_QUOTA_EXHAUSTED')) throw err;
    }
  }
  throw lastErr;
}

export function _resetTokenCacheForTest() {
  _token = null;
  _tokenExpireAt = 0;
}
