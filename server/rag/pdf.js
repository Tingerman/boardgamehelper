const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

/**
 * Parse PDF file and extract text
 * @param {string} pdfPath - Path to PDF file
 * @returns {Promise<{text: string, info: object}>}
 */
async function parsePDF(pdfPath) {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }

  const dataBuffer = fs.readFileSync(pdfPath);
  const data = await pdf(dataBuffer);

  return {
    text: data.text,
    info: data.info,
    pages: data.numpages,
  };
}

/**
 * Preprocess extracted text to clean it up
 * @param {string} text - Raw text from PDF
 * @returns {string} - Cleaned text
 */
function preprocessText(text) {
  // 1) 统一换行符（Windows / 老 Mac → \n）
  let cleaned = text.replace(/\r\n?/g, '\n');

  // 2) 先做"基于行"的清理 —— 必须在折叠空白之前，否则 /m 行锚点就失效
  //    去 "Page 3 of 20" 这类页眉页脚
  cleaned = cleaned.replace(/Page\s*\d+\s*(of\s*\d+)?/gi, '');
  //    去孤立数字行（纯页码）
  cleaned = cleaned.replace(/^\s*\d+\s*$/gm, '');

  // 3) 只折叠"行内"连续空白，保留换行符 \n —— 段落边界活下来
  cleaned = cleaned.replace(/[ \t\f\v]+/g, ' ');

  // 4) 每行去首尾空格
  cleaned = cleaned.split('\n').map((l) => l.trim()).join('\n');

  // 5) 归一化段落边界：3 个以上连续换行 → 2 个；单个换行保留（行内换行）
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 6) 修 PDF 常见的标点间插空格（如 "。 ！" → "。！"）
  cleaned = cleaned.replace(/([。！？])\s*([。！？])/g, '$1$2');

  return cleaned.trim();
}

/**
 * Split text into meaningful chunks
 * @param {string} text - Preprocessed text
 * @param {number} chunkSize - Maximum size per chunk
 * @param {number} overlap - Overlap between chunks
 * @returns {Array<{text: string, metadata: object}>}
 */
function splitTextIntoChunks(text, chunkSize = 500, overlap = 50) {
  // First split by paragraphs
  const paragraphs = text.split(/\n\n+/);

  const chunks = [];
  let currentChunk = '';
  let chunkIndex = 0;

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // If single paragraph exceeds chunk size, split further
    if (trimmed.length > chunkSize) {
      // Save current chunk if not empty
      if (currentChunk) {
        chunks.push({
          text: currentChunk.trim(),
          metadata: { index: chunkIndex++, source: 'paragraph' },
        });
        currentChunk = '';
      }

      // Split long paragraph by sentences
      // \s* 而非 \s+：兼容中文标点后无空格的常见情况
      const sentences = trimmed.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
      let tempChunk = '';

      for (const sentence of sentences) {
        if (tempChunk.length + sentence.length > chunkSize) {
          chunks.push({
            text: tempChunk.trim(),
            metadata: { index: chunkIndex++, source: 'sentence' },
          });
          tempChunk = sentence.slice(-overlap) || sentence;
        } else {
          tempChunk += ' ' + sentence;
        }
      }

      currentChunk = tempChunk;
    } else if (currentChunk.length + trimmed.length > chunkSize) {
      // Current paragraph would exceed chunk size
      chunks.push({
        text: currentChunk.trim(),
        metadata: { index: chunkIndex++, source: 'paragraph' },
      });
      currentChunk = trimmed;
    } else {
      currentChunk += '\n\n' + trimmed;
    }
  }

  // Don't forget the last chunk
  if (currentChunk) {
    chunks.push({
      text: currentChunk.trim(),
      metadata: { index: chunkIndex++, source: 'paragraph' },
    });
  }

  return chunks;
}

/**
 * Get PDF info from file path
 * @param {string} pdfPath - Path to PDF file
 * @returns {Promise<object>}
 */
async function getPDFInfo(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);
  const data = await pdf(dataBuffer);

  return {
    title: data.info?.Title || path.basename(pdfPath, '.pdf'),
    author: data.info?.Author || 'Unknown',
    pages: data.numpages,
    fileSize: fs.statSync(pdfPath).size,
  };
}

/**
 * 带图片对齐的切分器：在 OCR 文本之间插入 sentinel `<<IMG:n>>`，
 * 切完后扫每个 chunk 收集出现过的 imageIndices，并把 sentinel 从内容里清掉。
 *
 * @param {string} prefixText - 不属于任何图片的前置文本（标题、原文文字段等），可空
 * @param {Array<{imageIndex:number, text:string}>} segments
 * @param {number} chunkSize
 * @param {number} overlap
 * @returns {Array<{text:string, metadata:{index, source, imageIndices:number[]}}>}
 */
function splitTextWithImageMap(prefixText, segments, chunkSize = 500, overlap = 50) {
  const sentinel = (i) => `<<IMG:${i}>>`;

  const parts = [];
  if (prefixText && prefixText.trim()) parts.push(prefixText.trim());
  for (const seg of segments || []) {
    parts.push(sentinel(seg.imageIndex));
    if (seg.text && seg.text.trim()) parts.push(seg.text);
  }
  const composite = parts.join('\n\n');

  const rawChunks = splitTextIntoChunks(composite, chunkSize, overlap);

  return rawChunks.map((c) => {
    const found = new Set();
    const re = /<<IMG:(\d+)>>/g;
    let m;
    while ((m = re.exec(c.text)) !== null) {
      found.add(Number(m[1]));
    }
    const cleaned = c.text
      .replace(/<<IMG:\d+>>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
    return {
      text: cleaned,
      metadata: {
        ...c.metadata,
        imageIndices: Array.from(found).sort((a, b) => a - b),
      },
    };
  }).filter(c => c.text.length > 0);
}

module.exports = {
  parsePDF,
  preprocessText,
  splitTextIntoChunks,
  splitTextWithImageMap,
  getPDFInfo,
};