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
  // Remove excessive whitespace
  let cleaned = text.replace(/\s+/g, ' ');

  // Fix common PDF parsing issues
  cleaned = cleaned.replace(/([。！？])\s*([。！？])/g, '$1$2');
  cleaned = cleaned.replace(/\n\s*\n/g, '\n\n');

  // Remove page numbers and headers/footers (common patterns)
  cleaned = cleaned.replace(/Page\s*\d+\s*(of\s*\d+)?/gi, '');
  cleaned = cleaned.replace(/^\s*\d+\s*$/gm, '');

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
      const sentences = trimmed.split(/(?<=[。！？.!?])\s+/);
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

module.exports = {
  parsePDF,
  preprocessText,
  splitTextIntoChunks,
  getPDFInfo,
};