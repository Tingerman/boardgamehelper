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
      <h4>${book.name}</h4>
      <p>${book.chunkCount} 个段落</p>
    </div>
  `).join('');

  // Add click handlers
  document.querySelectorAll('.book-item').forEach(item => {
    item.addEventListener('click', () => {
      selectedBookId = item.dataset.id;
      renderBookList();
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

    // Display answer
    resultsEl.innerHTML = `<div class="results-content">${data.answer}</div>`;

    // Display sources
    if (data.sources && data.sources.length > 0) {
      sourcesList.innerHTML = data.sources.map(source => `
        <div class="source-item">
          <h4>${source.bookName}</h4>
          <p>${source.content}</p>
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