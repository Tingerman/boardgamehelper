// State
let books = [];
let selectedBookId = null;
let isLoading = false;

// DOM Elements
const statusEl = document.getElementById('status');
const statusDot = statusEl.querySelector('.status-dot');
const statusText = statusEl.querySelector('.status-text');
const bookListEl = document.getElementById('bookList');
const queryInput = document.getElementById('queryInput');
const queryBtn = document.getElementById('queryBtn');
const resultsEl = document.getElementById('results');
const sourcesSection = document.getElementById('sourcesSection');
const sourcesList = document.getElementById('sourcesList');

// Modal Elements
const uploadBtn = document.getElementById('uploadBtn');
const uploadModal = document.getElementById('uploadModal');
const closeModal = document.getElementById('closeModal');
const cancelUpload = document.getElementById('cancelUpload');
const confirmUpload = document.getElementById('confirmUpload');
const pdfInput = document.getElementById('pdfInput');
const bookNameInput = document.getElementById('bookNameInput');
const uploadProgress = document.getElementById('uploadProgress');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');

// Translation elements
const translateInputBtn = document.getElementById('translateInputBtn');
const translateAnswerChk = document.getElementById('translateAnswerChk');

// Initialize
async function init() {
  await checkStatus();
  await loadBooks();
  setupEventListeners();
}

// Check system status
async function checkStatus() {
  try {
    const status = await fetch('/api/status').then(r => r.json());

    if (status.initialized) {
      statusDot.classList.add('ready');
      statusText.textContent = status.llmLoaded ? '就绪' : '模型加载中...';
    } else {
      statusDot.classList.add('error');
      statusText.textContent = '初始化失败';
    }
  } catch (err) {
    statusDot.classList.add('error');
    statusText.textContent = '连接失败';
  }
}

// Load books
async function loadBooks() {
  try {
    books = await fetch('/api/books').then(r => r.json());
    renderBookList();
  } catch (err) {
    console.error('Failed to load books:', err);
  }
}

// Render book list
function renderBookList() {
  if (books.length === 0) {
    bookListEl.innerHTML = '<div class="empty-state">暂无规则书</div>';
    return;
  }

  bookListEl.innerHTML = books.map(book => `
    <div class="book-item ${book.id === selectedBookId ? 'active' : ''}"
         data-id="${book.id}">
      <div class="book-info">
        <h4>${book.name}</h4>
        <p>${book.chunkCount} 个段落</p>
      </div>
      <button class="book-delete" data-id="${book.id}" title="删除">×</button>
    </div>
  `).join('');

  // Add click handlers
  document.querySelectorAll('.book-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // 点到删除按钮就不切换选中
      if (e.target.classList.contains('book-delete')) return;
      selectedBookId = item.dataset.id;
      renderBookList();
    });
  });

  // 删除按钮
  document.querySelectorAll('.book-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const book = books.find(b => b.id === id);
      if (!confirm(`确定删除「${book ? book.name : id}」？此操作不可恢复。`)) return;
      try {
        const res = await fetch(`/api/books/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        if (selectedBookId === id) selectedBookId = null;
        await loadBooks();
      } catch (err) {
        alert('删除失败：' + err.message);
      }
    });
  });
}

// Setup event listeners
function setupEventListeners() {
  // Query
  queryBtn.addEventListener('click', handleQuery);
  queryInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleQuery();
  });

  // Modal
  uploadBtn.addEventListener('click', () => uploadModal.classList.add('show'));
  closeModal.addEventListener('click', closeUploadModal);
  cancelUpload.addEventListener('click', closeUploadModal);
  confirmUpload.addEventListener('click', handleUpload);

  // Translate input (zh -> en)
  translateInputBtn.addEventListener('click', handleTranslateInput);

  // Translate a single source (delegated)
  sourcesList.addEventListener('click', (e) => {
    const btn = e.target.closest('.source-translate-btn');
    if (btn) handleTranslateSource(btn);
  });

  // Close modal on outside click
  uploadModal.addEventListener('click', (e) => {
    if (e.target === uploadModal) closeUploadModal();
  });
}

// Close upload modal
function closeUploadModal() {
  uploadModal.classList.remove('show');
  pdfInput.value = '';
  bookNameInput.value = '';
  uploadProgress.style.display = 'none';
}

// Translate a piece of text via backend API
async function translateText(text, target, extra = {}) {
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target, ...extra }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || '翻译失败');
  }
  const data = await response.json();
  return data.translated;
}

// Translate current input (zh -> en) and fill back
async function handleTranslateInput() {
  const text = queryInput.value.trim();
  if (!text || isLoading) return;

  const originalLabel = translateInputBtn.textContent;
  translateInputBtn.disabled = true;
  translateInputBtn.textContent = '翻译中...';
  try {
    const translated = await translateText(text, 'en', { bookId: selectedBookId });
    queryInput.value = translated;
  } catch (err) {
    alert('翻译失败：' + err.message);
  } finally {
    translateInputBtn.disabled = false;
    translateInputBtn.textContent = originalLabel;
  }
}

// Handle query
async function handleQuery() {
  const question = queryInput.value.trim();
  if (!question || isLoading) return;

  isLoading = true;
  queryBtn.disabled = true;
  resultsEl.innerHTML = '<div class="results-content loading">思考中...</div>';
  sourcesSection.style.display = 'none';

  try {
    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        bookId: selectedBookId,
      }),
    });

    if (!response.ok) {
      throw new Error('查询失败');
    }

    const data = await response.json();

    // Optionally translate answer to Chinese
    let answer = data.answer;
    if (translateAnswerChk.checked && answer) {
      try {
        resultsEl.innerHTML = '<div class="results-content loading">翻译答案中...</div>';
        answer = await translateText(answer, 'zh');
      } catch (err) {
        console.error('Answer translation failed:', err);
      }
    }

    // Display answer
    resultsEl.innerHTML = `<div class="results-content">${answer}</div>`;

    // Display sources
    if (data.sources && data.sources.length > 0) {
      sourcesList.innerHTML = data.sources.map((source, idx) => `
        <div class="source-item" data-idx="${idx}">
          <h4>${source.bookName}</h4>
          <p class="source-content">${source.content}</p>
          <div class="source-actions">
            <button class="btn btn-sm source-translate-btn" data-action="translate">译为中文</button>
          </div>
          <div class="source-translation" style="display: none;"></div>
        </div>
      `).join('');
      sourcesSection.style.display = 'block';
    }
  } catch (err) {
    resultsEl.innerHTML = `<div class="results-content" style="color: #ff4d4f;">
      错误：${err.message}
    </div>`;
  } finally {
    isLoading = false;
    queryBtn.disabled = false;
  }
}

// Translate a single source's original text to Chinese, toggle show/hide
async function handleTranslateSource(btn) {
  const item = btn.closest('.source-item');
  if (!item) return;
  const contentEl = item.querySelector('.source-content');
  const translationEl = item.querySelector('.source-translation');
  if (!contentEl || !translationEl) return;

  // Toggle hide if already translated and currently shown
  if (translationEl.dataset.translated === '1') {
    const shown = translationEl.style.display !== 'none';
    translationEl.style.display = shown ? 'none' : 'block';
    btn.textContent = shown ? '译为中文' : '隐藏译文';
    return;
  }

  const original = contentEl.textContent || '';
  if (!original.trim()) return;

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = '翻译中...';
  try {
    const translated = await translateText(original, 'zh');
    translationEl.textContent = translated;
    translationEl.dataset.translated = '1';
    translationEl.style.display = 'block';
    btn.textContent = '隐藏译文';
  } catch (err) {
    translationEl.textContent = '翻译失败：' + err.message;
    translationEl.style.display = 'block';
    translationEl.style.color = '#ff4d4f';
    btn.textContent = originalLabel;
  } finally {
    btn.disabled = false;
  }
}

// Handle upload
async function handleUpload() {
  const file = pdfInput.files[0];
  if (!file) {
    alert('请选择 PDF 文件');
    return;
  }

  const bookName = bookNameInput.value.trim() || file.name.replace('.pdf', '');

  uploadProgress.style.display = 'block';
  progressText.textContent = '上传中...';
  progressFill.style.width = '30%';

  const formData = new FormData();
  formData.append('pdf', file);
  formData.append('name', bookName);

  try {
    progressText.textContent = '解析 PDF...';
    progressFill.style.width = '50%';

    const response = await fetch('/api/ingest', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error('上传失败');
    }

    progressText.textContent = '构建索引...';
    progressFill.style.width = '80%';

    const data = await response.json();

    progressFill.style.width = '100%';
    progressText.textContent = '完成！';

    // Reload books
    await loadBooks();

    setTimeout(() => {
      closeUploadModal();
    }, 500);
  } catch (err) {
    alert('上传失败：' + err.message);
    uploadProgress.style.display = 'none';
  }
}

// Start
init();