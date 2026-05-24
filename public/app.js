// State
let books = [];
let selectedBookIds = new Set();
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

// Op Log panel
const opLogPanel = document.getElementById('opLogPanel');
const opLogBody = document.getElementById('opLogBody');
const opLogClearBtn = document.getElementById('opLogClear');
const opLogToggleBtn = document.getElementById('opLogToggle');

const OP_LOG_LABELS = {
  scrape: '抓取中',
  scraped: '抓取完成',
  catalog_hit: '目录命中',
  ingest_done: '入库完成',
  image_ingest_start: '图片入库',
  image_ingest_done: '图片完成',
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function appendOpLog(payload) {
  if (!opLogPanel) return;
  opLogPanel.hidden = false;
  const t = new Date();
  const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  const type = payload.type || 'log';
  const label = OP_LOG_LABELS[type] || type;
  const game = payload.game ? `「${escapeHtml(payload.game)}」` : '';
  const url = payload.url
    ? `<a class="op-log-url" href="${escapeHtml(payload.url)}" target="_blank" rel="noopener">${escapeHtml(payload.url)}</a>`
    : '';
  let extra = '';
  if (type === 'scraped' && payload.imageCount != null) extra = `（${payload.imageCount} 张图）`;
  else if (type === 'ingest_done' && payload.chunks != null) extra = `（${payload.chunks} 段）`;
  else if (type === 'image_ingest_done' && payload.chunks != null) extra = `（${payload.chunks} 段）`;
  else if (type === 'catalog_hit') extra = payload.inDb ? '（已入库）' : '（待入库）';

  const item = document.createElement('div');
  item.className = 'op-log-item';
  item.innerHTML = `
    <span class="op-log-time">${time}</span>
    <span class="op-log-tag ${escapeHtml(type)}">${escapeHtml(label)}</span>
    <span class="op-log-msg">${game}${escapeHtml(extra)}</span>
    ${url ? `<div>${url}</div>` : ''}
  `;
  opLogBody.appendChild(item);
  opLogBody.scrollTop = opLogBody.scrollHeight;
}

if (opLogClearBtn) {
  opLogClearBtn.addEventListener('click', () => { opLogBody.innerHTML = ''; });
}
if (opLogToggleBtn) {
  opLogToggleBtn.addEventListener('click', () => {
    const collapsed = opLogPanel.classList.toggle('collapsed');
    opLogToggleBtn.textContent = collapsed ? '+' : '−';
  });
}

// Modal Elements
const uploadBtn = document.getElementById('uploadBtn');
const uploadModal = document.getElementById('uploadModal');
const closeModal = document.getElementById('closeModal');
const cancelUpload = document.getElementById('cancelUpload');
const confirmUpload = document.getElementById('confirmUpload');
const pdfInput = document.getElementById('pdfInput');
const imageInput = document.getElementById('imageInput');
const urlInput = document.getElementById('urlInput');
const bookNameInput = document.getElementById('bookNameInput');
const zhNameInput = document.getElementById('zhNameInput');
const enNameInput = document.getElementById('enNameInput');
const summaryInput = document.getElementById('summaryInput');
const uploadProgress = document.getElementById('uploadProgress');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');

// 当前 source tab：pdf | image | url
let currentSource = 'pdf';

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

  const sourceLabels = { pdf: 'PDF', image: '图片', bilibili: 'B站' };
  bookListEl.innerHTML = books.map(book => {
    const src = book.source || 'pdf';
    const label = sourceLabels[src] || src;
    const checked = selectedBookIds.has(book.id) ? 'checked' : '';
    return `
    <div class="book-item ${selectedBookIds.has(book.id) ? 'active' : ''}"
         data-id="${book.id}">
      <input type="checkbox" class="book-checkbox" data-id="${book.id}" ${checked} />
      <div class="book-info">
        <h4>${escapeHtml(book.name)} <span class="book-source-tag ${escapeHtml(src)}">${escapeHtml(label)}</span></h4>
        <p>${book.chunkCount} 个段落</p>
      </div>
      <button class="book-delete" data-id="${book.id}" title="删除">×</button>
    </div>
  `;
  }).join('');

  // 行点击 / checkbox 都切换选中
  document.querySelectorAll('.book-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('book-delete')) return;
      const id = item.dataset.id;
      if (selectedBookIds.has(id)) selectedBookIds.delete(id);
      else selectedBookIds.add(id);
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
        if (selectedBookIds.has(id)) selectedBookIds.delete(id);
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

  // Source tabs 切换
  document.querySelectorAll('.source-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const src = tab.dataset.source;
      currentSource = src;
      document.querySelectorAll('.source-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.source === src);
      });
      document.querySelectorAll('.source-panel').forEach(p => {
        p.hidden = p.dataset.source !== src;
      });
    });
  });

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
  if (imageInput) imageInput.value = '';
  if (urlInput) urlInput.value = '';
  bookNameInput.value = '';
  if (zhNameInput) zhNameInput.value = '';
  if (enNameInput) enNameInput.value = '';
  if (summaryInput) summaryInput.value = '';
  uploadProgress.style.display = 'none';
}

function getManualMetaFields() {
  return {
    zhName: (zhNameInput && zhNameInput.value || '').trim(),
    enName: (enNameInput && enNameInput.value || '').trim(),
    summary: (summaryInput && summaryInput.value || '').trim(),
  };
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
    const translated = await translateText(text, 'en', { bookId: Array.from(selectedBookIds)[0] || null });
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
    // 默认走 SSE，兼容 ingest 进度上报
    let data = await querySse(question, Array.from(selectedBookIds));

    // L2 中断：弹窗等用户决策，再走 /api/resume 续跑
    if (data._interrupt) {
      const choice = await showL2InterruptDialog(data._interrupt);
      resultsEl.innerHTML = `<div class="results-content loading">${choice.accept ? '正在抓取所选源...' : '继续生成答案...'}</div>`;
      data = await resumeQuerySse(data._interrupt.threadId, choice.accept, choice.dynIdStrs);
      if (data._interrupt) {
        throw new Error('graph 二次中断（不应发生）');
      }
      if (data._sessionExpired) {
        throw new Error('会话已过期，请重新提问');
      }
      // resume 后可能涉及 ingest，刷新 books 列表
      await loadBooks();
    }

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

    // 命中标识徽章
    let badge = '';
    if (data.matchedBy) {
      const labelMap = {
        alias_exact: '硬匹配',
        llm_intro: 'LLM 兜底',
        user_specified: '用户指定',
      };
      const lbl = labelMap[data.matchedBy] || data.matchedBy;
      const conf = data.matchConfidence != null ? ` ${(data.matchConfidence * 100).toFixed(0)}%` : '';
      badge = `<div class="match-badge" style="font-size:12px;color:#666;margin-bottom:6px">命中方式：${lbl}${conf}</div>`;
    }

    resultsEl.innerHTML = badge + `<div class="results-content">${answer || '（无答案）'}</div>`;

    // N5 拒答（greeting / off_topic）后弹"alias 反馈"面板，让用户告诉系统真正想查的游戏名
    if (data.intent === 'greeting' || data.intent === 'off_topic') {
      renderAliasFeedback(question);
    }

    if (data.sources && data.sources.length > 0) {
      sourcesList.innerHTML = data.sources.map((source, idx) => {
        // chunk 级 imageUrls：retrieve 已按 imageIndices 反查精准切片
        const imgs = Array.isArray(source.imageUrls) ? source.imageUrls : [];
        const thumbs = imgs.length > 0
          ? `<div class="source-thumbs">${imgs.slice(0, 6).map(u => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></a>`).join('')}</div>`
          : '';
        const citedBadge = source.cited
          ? '<span class="source-cited-badge" title="LLM 答案显式引用了此 chunk">已引用</span>'
          : '';
        return `
        <div class="source-item${source.cited ? ' source-cited' : ''}" data-idx="${idx}">
          <h4>${escapeHtml(source.bookName)}${citedBadge}</h4>
          <p class="source-content">${escapeHtml(source.content)}</p>
          ${thumbs}
          <div class="source-actions">
            <button class="btn btn-sm source-translate-btn" data-action="translate">译为中文</button>
          </div>
          <div class="source-translation" style="display: none;"></div>
        </div>
      `;
      }).join('');
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

/**
 * SSE 查询：解析 event-stream 流，渲染 ingest 进度，最终返回 answer payload 或 interrupt payload
 */
async function querySse(question, bookIds) {
  const threadId = (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await fetch('/api/query', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ question, bookIds, threadId }),
  });
  if (!response.ok) throw new Error('查询失败 HTTP ' + response.status);
  return await readSseStream(response);
}

async function resumeQuerySse(threadId, accept, dynIdStrs) {
  const response = await fetch('/api/resume', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ threadId, accept, dynIdStrs }),
  });
  if (!response.ok) throw new Error('Resume 失败 HTTP ' + response.status);
  return await readSseStream(response);
}

async function readSseStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let answerPayload = null;
  let interruptPayload = null;
  let routeInfo = null;

  function renderProgress(stage, percent, current, total) {
    const stageMap = { scrape: '抓取规则书', ocr: '识别图片文字', metadata: '提取元信息', embed: '建立索引' };
    const lbl = stageMap[stage] || stage;
    const game = routeInfo ? `「${routeInfo.game}」` : '';
    const detail = current && total ? ` ${current}/${total}` : '';
    resultsEl.innerHTML = `
      <div class="results-content loading">
        ${game} ${lbl}${detail}
        <div style="margin-top:8px;height:6px;background:#eee;border-radius:3px;overflow:hidden">
          <div style="width:${percent || 0}%;height:100%;background:#1890ff;transition:width .3s"></div>
        </div>
      </div>`;
  }

  function handleEvent(event, data) {
    let payload = {};
    try { payload = JSON.parse(data); } catch (_) {}
    switch (event) {
      case 'route':
        routeInfo = payload;
        resultsEl.innerHTML = `<div class="results-content loading">命中目录${payload.matchedBy === 'llm_intro' ? '（LLM 兜底）' : ''}：「${payload.game}」，开始抓取入库...</div>`;
        break;
      case 'ingest_progress':
        renderProgress(payload.stage, payload.percent, payload.current, payload.total);
        break;
      case 'ingest_done':
        resultsEl.innerHTML = `<div class="results-content loading">入库完成（${payload.chunks} 段，${(payload.durationMs / 1000).toFixed(1)}s），开始检索回答...</div>`;
        break;
      case 'op_log':
        appendOpLog(payload);
        break;
      case 'answer':
        answerPayload = payload;
        break;
      case 'interrupt':
        interruptPayload = payload;
        break;
      case 'suggest_l2':
        // 走 interrupt 路径时，suggest_l2 在 interrupt 之前 emit；此处仅做日志
        break;
      case 'error':
        console.warn('SSE error event:', payload);
        if (payload.code === 'session_expired') {
          interruptPayload = null;
          answerPayload = { _sessionExpired: true };
        }
        break;
      case 'done':
        break;
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop();
    for (const block of blocks) {
      if (!block.trim()) continue;
      const lines = block.split('\n');
      let event = 'message', data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      handleEvent(event, data);
    }
  }

  if (interruptPayload) {
    return { _interrupt: interruptPayload };
  }
  if (!answerPayload) {
    throw new Error('未收到 answer 事件');
  }
  return answerPayload;
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

// Handle upload — 根据 currentSource 分发
async function handleUpload() {
  const meta = getManualMetaFields();
  const bookName = bookNameInput.value.trim();

  try {
    if (currentSource === 'pdf') {
      const file = pdfInput.files[0];
      if (!file) { alert('请选择 PDF 文件'); return; }
      await uploadPdf(file, bookName, meta);
    } else if (currentSource === 'image') {
      const files = imageInput.files;
      if (!files || files.length === 0) { alert('请选择至少一张图片'); return; }
      await uploadImages(Array.from(files), bookName, meta);
    } else if (currentSource === 'url') {
      const url = urlInput.value.trim();
      if (!url) { alert('请粘贴 B站 opus URL'); return; }
      await uploadUrl(url, meta);
    }

    await loadBooks();
    setTimeout(closeUploadModal, 500);
  } catch (err) {
    alert('上传失败：' + err.message);
    uploadProgress.style.display = 'none';
  }
}

// PDF：保留旧的 JSON 一次性返回
async function uploadPdf(file, bookName, meta) {
  uploadProgress.style.display = 'block';
  progressText.textContent = '上传中...';
  progressFill.style.width = '30%';

  const formData = new FormData();
  formData.append('pdf', file);
  formData.append('name', bookName || file.name.replace('.pdf', ''));
  if (meta.zhName) formData.append('zhName', meta.zhName);
  if (meta.enName) formData.append('enName', meta.enName);
  if (meta.summary) formData.append('summary', meta.summary);

  progressText.textContent = '解析 PDF...';
  progressFill.style.width = '50%';
  const response = await fetch('/api/ingest', { method: 'POST', body: formData });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
  progressFill.style.width = '100%';
  progressText.textContent = '完成！';
}

// 图片：FormData + SSE 流式进度
async function uploadImages(files, bookName, meta) {
  const formData = new FormData();
  for (const f of files) formData.append('images', f);
  if (bookName) formData.append('name', bookName);
  if (meta.zhName) formData.append('zhName', meta.zhName);
  if (meta.enName) formData.append('enName', meta.enName);
  if (meta.summary) formData.append('summary', meta.summary);

  await runSseUpload('/api/ingest/image', { method: 'POST', body: formData });
}

// URL：JSON + SSE
async function uploadUrl(url, meta) {
  const body = { url, ...meta };
  await runSseUpload('/api/ingest/url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// 共用 SSE 处理器
async function runSseUpload(endpoint, fetchOpts) {
  uploadProgress.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = '准备中...';

  const response = await fetch(endpoint, fetchOpts);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let lastError = null;
  let done = false;

  const stageMap = { scrape: '抓取页面', ocr: '识别图片文字', metadata: '提取元信息', embed: '建立索引' };

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop();
    for (const block of blocks) {
      if (!block.trim()) continue;
      let event = 'message', data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      let payload = {};
      try { payload = JSON.parse(data); } catch (_) {}

      if (event === 'ingest_progress') {
        const lbl = stageMap[payload.stage] || payload.stage;
        const detail = payload.current && payload.total ? ` ${payload.current}/${payload.total}` : '';
        progressText.textContent = `${lbl}${detail}`;
        progressFill.style.width = (payload.percent || 0) + '%';
      } else if (event === 'ingest_done') {
        progressFill.style.width = '100%';
        progressText.textContent = payload.skipped
          ? '已存在，跳过'
          : `完成（${payload.chunks} 段，${(payload.durationMs / 1000).toFixed(1)}s）`;
        done = true;
      } else if (event === 'error') {
        lastError = payload;
      } else if (event === 'op_log') {
        appendOpLog(payload);
      }
    }
  }
  if (lastError) {
    throw new Error(lastError.message || lastError.code || 'ingest 失败');
  }
}

// Start
init();

// ===== L2 中断对话框 =====
// 后端 N8 调 interrupt() 后，前端拿到 candidates，弹窗让用户多选
// 用户选完调 /api/resume 续跑同一个 thread_id 的图执行
function showL2InterruptDialog(interruptPayload) {
  return new Promise((resolve) => {
    const candidates = interruptPayload.candidates || [];
    if (candidates.length === 0) {
      resolve({ accept: false, dynIdStrs: [] });
      return;
    }

    // 构造 modal
    const overlay = document.createElement('div');
    overlay.className = 'modal show';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:8px;padding:20px;max-width:560px;width:90%;max-height:80vh;overflow-y:auto;';
    const items = candidates.map((c, i) => `
      <label style="display:flex;align-items:flex-start;padding:8px;border-bottom:1px solid #eee;cursor:pointer;">
        <input type="checkbox" class="l2-cand-cb" data-id="${escapeHtml(c.dynIdStr)}" checked style="margin-right:8px;margin-top:4px;" />
        <div style="flex:1">
          <div><strong>${escapeHtml(c.gameZhName || c.gameEnName || c.bookName)}</strong></div>
          <div style="font-size:12px;color:#888;word-break:break-all;">${escapeHtml(c.url)}</div>
        </div>
      </label>
    `).join('');
    box.innerHTML = `
      <h3 style="margin:0 0 12px 0;">已选源信息不全</h3>
      <p style="color:#666;margin-bottom:12px;">检测到同游戏在 B站 还有 ${candidates.length} 个未入库源。勾选要补抓的来源，确认后会自动重检索。</p>
      <div style="border:1px solid #eee;border-radius:6px;margin-bottom:16px;">${items}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn" id="l2-skip">跳过（保留当前答案）</button>
        <button class="btn btn-primary" id="l2-confirm">确认抓取</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = () => document.body.removeChild(overlay);
    box.querySelector('#l2-skip').onclick = () => {
      cleanup();
      resolve({ accept: false, dynIdStrs: [] });
    };
    box.querySelector('#l2-confirm').onclick = () => {
      const checked = Array.from(box.querySelectorAll('.l2-cand-cb'))
        .filter(cb => cb.checked).map(cb => cb.dataset.id);
      cleanup();
      resolve({ accept: checked.length > 0, dynIdStrs: checked });
    };
  });
}

/**
 * N5 拒答后渲染"alias 反馈"面板：
 *   用户输入想查的游戏名 → POST /api/feedback/alias → staging
 *   离线蒸馏后会成为该桌游的 alias
 */
function renderAliasFeedback(userQuery) {
  // 同一答案区只挂一次
  if (document.getElementById('alias-feedback-box')) return;
  const box = document.createElement('div');
  box.id = 'alias-feedback-box';
  box.style.cssText = 'margin-top:12px;padding:10px 12px;border:1px dashed #d9d9d9;border-radius:6px;background:#fafafa;font-size:13px;';
  box.innerHTML = `
    <div style="margin-bottom:8px;color:#666;">没找到合适的回答？告诉我你想查的桌游叫什么（官方名 / 民间译名 / 英文名都行）：</div>
    <div style="display:flex;gap:6px;">
      <input id="alias-feedback-input" type="text" placeholder="例如：历史巨轮 / Through the Ages / 卡坦"
        style="flex:1;padding:6px 8px;border:1px solid #ddd;border-radius:4px;" />
      <button class="btn btn-sm" id="alias-feedback-submit">提交</button>
      <button class="btn btn-sm" id="alias-feedback-skip">跳过</button>
    </div>
    <div id="alias-feedback-status" style="margin-top:6px;font-size:12px;color:#888;"></div>
  `;
  resultsEl.appendChild(box);

  const inputEl = box.querySelector('#alias-feedback-input');
  const statusEl = box.querySelector('#alias-feedback-status');
  const submitBtn = box.querySelector('#alias-feedback-submit');

  box.querySelector('#alias-feedback-skip').onclick = () => box.remove();
  submitBtn.onclick = async () => {
    const gameZhName = (inputEl.value || '').trim();
    if (!gameZhName) {
      statusEl.textContent = '请输入游戏名';
      statusEl.style.color = '#ff4d4f';
      return;
    }
    submitBtn.disabled = true;
    statusEl.style.color = '#888';
    statusEl.textContent = '提交中...';
    try {
      const resp = await fetch('/api/feedback/alias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userQuery, gameZhName }),
      });
      const json = await resp.json().catch(() => ({}));
      if (resp.ok && json.ok) {
        statusEl.style.color = '#52c41a';
        statusEl.textContent = '已收到反馈，会在离线 review 中分类（别名 / 待入库）';
        setTimeout(() => box.remove(), 2000);
      } else {
        statusEl.style.color = '#ff4d4f';
        statusEl.textContent = json.error || '提交失败';
        submitBtn.disabled = false;
      }
    } catch (err) {
      statusEl.style.color = '#ff4d4f';
      statusEl.textContent = '网络错误：' + err.message;
      submitBtn.disabled = false;
    }
  };
}