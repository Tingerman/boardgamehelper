require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const RAGEngine = require('./rag/index');
const pdfParser = require('./rag/pdf');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize RAG engine
const rag = new RAGEngine();

// Configure multer for file uploads
const upload = multer({
  dest: path.join(__dirname, '../data/temp'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

// Ensure directories exist
const dataDir = path.join(__dirname, '../data');
const tempDir = path.join(dataDir, 'temp');
const booksDir = path.join(dataDir, 'books');

[dataDir, tempDir, booksDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Initialize RAG on startup
async function initRAG() {
  try {
    await rag.initialize();
    console.log('RAG engine initialized');

    // Check for existing PDFs in data/books
    const files = fs.readdirSync(booksDir).filter(f => f.endsWith('.pdf'));

    for (const file of files) {
      try {
        const pdfPath = path.join(booksDir, file);
        const bookId = path.basename(file, '.pdf');

        console.log(`Processing existing PDF: ${file}`);
        const { text } = await pdfParser.parsePDF(pdfPath);
        const cleanedText = pdfParser.preprocessText(text);

        await rag.ingestDocument(
          bookId,
          path.basename(file, '.pdf'),
          cleanedText
        );
        console.log(`Ingested: ${file}`);
      } catch (err) {
        console.error(`Error processing ${file}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Failed to initialize RAG:', err);
  }
}

initRAG();

// API Routes

// Get system status
app.get('/api/status', async (req, res) => {
  try {
    const status = rag.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get list of ingested books
app.get('/api/books', async (req, res) => {
  try {
    const books = rag.getBooks();
    res.json(books);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ingest a new PDF
app.post('/api/ingest', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const bookName = req.body.name || path.basename(req.file.originalname, '.pdf');
    const bookId = req.body.id || path.basename(req.file.originalname, '.pdf');

    // Move file to books directory
    const destPath = path.join(booksDir, `${bookId}.pdf`);
    fs.renameSync(req.file.path, destPath);

    // Parse PDF
    const { text, pages } = await pdfParser.parsePDF(destPath);
    const cleanedText = pdfParser.preprocessText(text);

    // Ingest into RAG
    const result = await rag.ingestDocument(bookId, bookName, cleanedText);

    res.json({
      success: true,
      bookId,
      bookName,
      pages,
      chunks: result.chunks,
    });
  } catch (err) {
    console.error('Ingest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Query the RAG system
app.post('/api/query', async (req, res) => {
  try {
    const { question, bookId } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    // Stream response
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');

    const result = await rag.query(question, bookId);

    res.json(result);
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Translate text
app.post('/api/translate', async (req, res) => {
  try {
    const { text, target, bookId } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }
    const t = target === 'zh' ? 'zh' : 'en';
    const translated = await rag.translate(text, t, { bookId: bookId || null });
    res.json({ translated });
  } catch (err) {
    console.error('Translate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a book
app.delete('/api/books/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // 1. 内存：从向量库和 books Map 里移除
    const removed = rag.deleteBook(id);
    if (!removed) {
      return res.status(404).json({ error: 'Book not found' });
    }

    // 2. 磁盘：把 data/books/ 下的 PDF 也删掉，否则下次 initRAG 会重新 ingest
    const pdfPath = path.join(booksDir, `${id}.pdf`);
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});