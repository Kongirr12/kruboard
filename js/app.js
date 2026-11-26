/**
 * ครูบอร์ด (KruBoard) — Frontend Application Controller
 * พัฒนาโดย: ครูก้องนที อุ่นเจริญ
 */
(function () {
  'use strict';

  const API = window.KruBoardAPI;
  const CFG = window.KRUBOARD_CONFIG || {};

  const STATE = {
    settings: {
      systemName: CFG.SYSTEM_NAME || 'ครูบอร์ด',
      schoolName: CFG.SCHOOL_NAME || 'กระดานส่งงานออนไลน์',
      developerName: CFG.DEVELOPER_NAME || 'ครูก้องนที อุ่นเจริญ'
    },
    user: null,
    stats: { totalBoards: 0, totalPosts: 0, pendingPosts: 0, checkedPosts: 0 },
    boards: [],
    homeFilterType: 'all',
    homeSearch: '',

    activeBoard: null,
    activePosts: [],
    activeLayout: 'masonry',
    boardSearch: '',
    boardCategory: 'all',
    boardStatus: 'all',
    boardSort: 'newest',
    boardPasscodes: {},

    pendingAttachment: null,
    selectedCardColor: 'white',
    selectedBoardTheme: 'indigo',
    activeDetailPostId: null,
    likedPosts: loadJsonSet('kruboard_liked_posts'),
    imageDataCache: {}
  };

  const TYPE_LABELS = {
    classroom: 'กระดานห้องเรียน',
    teacher_doc: 'กระดานส่งงานครู',
    general: 'กระดานทั่วไป'
  };

  const STATUS_META = {
    approved: { label: 'เผยแพร่แล้ว', cls: 'st-approved', icon: 'check' },
    checked: { label: 'ตรวจแล้ว', cls: 'st-checked', icon: 'badge-check' },
    pending: { label: 'รออนุมัติ', cls: 'st-pending', icon: 'clock' },
    needs_revision: { label: 'ขอให้แก้ไข', cls: 'st-needs_revision', icon: 'alert-circle' }
  };

  // ============================================================
  // Helpers
  // ============================================================

  function $(id) {
    return document.getElementById(id);
  }

  function escHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function loadJsonSet(key) {
    try {
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
      return new Set();
    }
  }

  function saveJsonSet(key, setObj) {
    try {
      localStorage.setItem(key, JSON.stringify(Array.from(setObj)));
    } catch (e) {}
  }

  function formatThaiDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('th-TH', {
      day: 'numeric',
      month: 'short',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatThaiDateOnly(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatBytes(bytes) {
    const b = Number(bytes || 0);
    if (!b) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function getInitials(name) {
    const clean = String(name || '?').trim();
    return clean ? clean.slice(0, 2) : '?';
  }

  function showToast(message, type) {
    const container = $('toast-container');
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      el.style.transition = 'all 200ms';
      setTimeout(() => el.remove(), 220);
    }, 3400);
  }

  function openModal(id) {
    const el = $(id);
    if (el) {
      el.classList.remove('hidden');
      refreshIcons();
    }
  }

  function closeModal(id) {
    const el = $(id);
    if (el) el.classList.add('hidden');
  }

  function getBoardIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('board')) return params.get('board');
    const m = window.location.hash.match(/^#\/board\/([^/?]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function buildBoardShareUrl(boardId) {
    const url = new URL(window.location.href);
    url.searchParams.set('board', boardId);
    url.hash = '';
    return url.toString();
  }

  function navigateToHome() {
    const url = new URL(window.location.href);
    url.searchParams.delete('board');
    url.hash = '#/';
    window.history.pushState({}, '', url.toString());
    STATE.activeBoard = null;
    STATE.activePosts = [];
    renderCurrentRoute();
  }

  function navigateToBoard(boardId) {
    const url = new URL(window.location.href);
    url.searchParams.set('board', boardId);
    url.hash = '';
    window.history.pushState({}, '', url.toString());
    openBoard(boardId);
  }

  // ============================================================
  // Branding & Header State
  // ============================================================

  function renderBrandingAndAuth() {
    const s = STATE.settings;
    $('nav-system-name').textContent = s.systemName || 'ครูบอร์ด';
    $('nav-school-name').textContent = s.schoolName || 'กระดานส่งงานออนไลน์';
    $('hero-title').textContent = (s.systemName || 'ครูบอร์ด') + ' — ' + (s.schoolName || 'กระดานส่งงานออนไลน์');
    $('footer-system-name').textContent = s.systemName || 'ครูบอร์ด';
    $('footer-developer-name').textContent = s.developerName || 'ครูก้องนที อุ่นเจริญ';
    document.title = (s.systemName || 'ครูบอร์ด') + ' | พัฒนาโดย ' + (s.developerName || 'ครูก้องนที อุ่นเจริญ');

    const demo = API.isDemoMode();
    const connPill = $('connection-pill');
    connPill.className = 'conn-pill ' + (demo ? 'conn-demo' : 'conn-live');
    $('connection-label').textContent = demo ? 'โหมดทดลองใช้' : 'เชื่อมต่อ Sheet แล้ว';
    $('demo-banner').classList.toggle('hidden', !demo);

    const isAdmin = !!STATE.user;
    $('btn-create-board-top').classList.toggle('hidden', !isAdmin);
    $('btn-settings-top').classList.toggle('hidden', !isAdmin && !demo);
    $('btn-hero-create').classList.toggle('hidden', !isAdmin);
    $('btn-hero-login').classList.toggle('hidden', isAdmin);
    $('btn-admin-label').textContent = isAdmin ? 'ออกจากระบบ (' + STATE.user.username + ')' : 'เข้าสู่ระบบครู';
    $('opt-status-pending').classList.toggle('hidden', !isAdmin);

    if (STATE.activeBoard) {
      $('btn-board-edit').classList.toggle('hidden', !isAdmin);
    }
    refreshIcons();
  }

  // ============================================================
  // Data Loading (Stale-While-Revalidate for Instant Paint)
  // ============================================================

  function setSyncIndicator(syncing) {
    const demo = API.isDemoMode();
    if (demo) return;
    $('connection-label').textContent = syncing ? 'กำลังอัปเดต...' : 'เชื่อมต่อ Sheet แล้ว';
  }

  async function initApp(forceSpinner) {
    const cachedInit = !forceSpinner ? API.getCachedSnapshot('init') : null;
    if (cachedInit && cachedInit.ok) {
      STATE.settings = cachedInit.settings || STATE.settings;
      STATE.user = cachedInit.user || null;
      STATE.stats = cachedInit.stats || STATE.stats;
      STATE.boards = cachedInit.boards || [];
      $('global-loader').classList.add('hidden');
      renderBrandingAndAuth();
      renderCurrentRoute(true);
      setSyncIndicator(true);
    } else {
      $('global-loader').classList.remove('hidden');
      $('view-home').classList.add('hidden');
      $('view-board').classList.add('hidden');
    }

    const res = await API.rpc('getPublicInit');
    $('global-loader').classList.add('hidden');
    setSyncIndicator(false);

    if (!res.ok) {
      showToast(res.message || 'ไม่สามารถโหลดข้อมูลได้', 'error');
      renderBrandingAndAuth();
      if (!cachedInit) $('view-home').classList.remove('hidden');
      return;
    }

    API.setCachedSnapshot('init', res);
    STATE.settings = res.settings || STATE.settings;
    STATE.user = res.user || null;
    STATE.stats = res.stats || STATE.stats;
    STATE.boards = res.boards || [];

    renderBrandingAndAuth();
    // ถ้ากำลังอยู่หน้าแรกให้อัปเดตทันที ถ้าอยู่หน้าบอร์ดอยู่แล้ว (จากการพรีโหลด) ไม่ต้องโหลดซ้ำถ้าเพิ่งเปิด
    const boardId = getBoardIdFromUrl();
    if (!boardId) {
      $('btn-home-nav').classList.add('hidden');
      $('view-board').classList.add('hidden');
      $('view-home').classList.remove('hidden');
      renderHome();
    } else if (!cachedInit) {
      openBoard(boardId);
    }
  }

  function renderCurrentRoute(isFromCache) {
    const boardId = getBoardIdFromUrl();
    if (boardId) {
      openBoard(boardId);
    } else {
      $('btn-home-nav').classList.add('hidden');
      $('view-board').classList.add('hidden');
      $('view-home').classList.remove('hidden');
      renderHome();
    }
  }

  // ============================================================
  // View 1: Home / Boards Directory
  // ============================================================

  function renderHome() {
    $('stat-boards').textContent = STATE.stats.totalBoards || 0;
    $('stat-posts').textContent = STATE.stats.totalPosts || 0;
    $('stat-pending').textContent = STATE.stats.pendingPosts || 0;
    $('stat-checked').textContent = STATE.stats.checkedPosts || 0;

    const q = STATE.homeSearch.trim().toLowerCase();
    const filtered = STATE.boards.filter((b) => {
      if (STATE.homeFilterType !== 'all' && b.boardType !== STATE.homeFilterType) return false;
      if (q) {
        const hay = [b.title, b.description, (b.categories || []).join(' ')].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const grid = $('boards-grid');
    const empty = $('boards-empty');

    if (filtered.length === 0) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      refreshIcons();
      return;
    }

    empty.classList.add('hidden');
    grid.innerHTML = filtered.map((b) => {
      const themeCls = 'theme-' + escHtml(b.theme || 'indigo');
      const typeLabel = TYPE_LABELS[b.boardType] || TYPE_LABELS.general;
      const cats = (b.categories || []).slice(0, 4);
      const moreCats = (b.categories || []).length > 4 ? '+' + ((b.categories || []).length - 4) : '';
      const totalPosts = (b.stats && b.stats.total) || 0;
      const pending = (b.stats && b.stats.pending) || 0;

      return `
        <article class="board-card" data-open-board="${escHtml(b.boardId)}">
          <div class="board-card-cover ${themeCls}">
            <span class="badge-glass">${escHtml(typeLabel)}</span>
            <div class="btn-group">
              ${b.hasPasscode ? '<span class="badge-glass" title="มีรหัสผ่าน"><i data-lucide="key-round"></i></span>' : ''}
              ${b.isLocked ? '<span class="badge-glass badge-warn" title="ล็อกกระดาน"><i data-lucide="lock"></i></span>' : ''}
              <button type="button" class="btn btn-glass btn-sm" data-quick-share="${escHtml(b.boardId)}" title="แชร์ QR Code">
                <i data-lucide="qr-code"></i>
              </button>
            </div>
          </div>
          <div class="board-card-body">
            <h3 class="board-card-title">${escHtml(b.title)}</h3>
            <p class="board-card-desc">${escHtml(b.description || 'คลิกเพื่อเปิดดูกระดานและส่งงาน')}</p>
            <div class="tag-list">
              ${cats.map((c) => `<span class="tag-chip">${escHtml(c)}</span>`).join('')}
              ${moreCats ? `<span class="tag-chip">${escHtml(moreCats)}</span>` : ''}
            </div>
          </div>
          <div class="board-card-footer">
            <div class="board-card-stats">
              <span><i data-lucide="file-text"></i> ${totalPosts} งาน</span>
              ${STATE.user && pending > 0 ? `<span style="color:#d97706;font-weight:600;"><i data-lucide="clock"></i> รออนุมัติ ${pending}</span>` : ''}
              ${b.dueDate ? `<span><i data-lucide="calendar"></i> ${escHtml(formatThaiDateOnly(b.dueDate))}</span>` : ''}
            </div>
            <span>เปิดกระดาน →</span>
          </div>
        </article>
      `;
    }).join('');

    refreshIcons();
  }

  // ============================================================
  // View 2: Single Board Workspace
  // ============================================================

  async function openBoard(boardId, explicitPasscode, silentRefresh) {
    const isSameBoard = STATE.activeBoard && STATE.activeBoard.boardId === boardId;
    const passcode = explicitPasscode !== undefined ? explicitPasscode : (STATE.boardPasscodes[boardId] || '');
    const cacheName = 'board_' + boardId;
    const cachedBoard = (!silentRefresh && !passcode) ? API.getCachedSnapshot(cacheName) : null;

    $('view-home').classList.add('hidden');
    $('btn-home-nav').classList.remove('hidden');

    if (cachedBoard && cachedBoard.ok && cachedBoard.board && !cachedBoard.board.hasPasscode) {
      STATE.activeBoard = cachedBoard.board;
      STATE.activePosts = cachedBoard.posts || [];
      if (!isSameBoard) {
        STATE.activeLayout = cachedBoard.board.layout || 'masonry';
        STATE.boardSearch = '';
        STATE.boardCategory = 'all';
        STATE.boardStatus = 'all';
        STATE.boardSort = 'newest';
        $('board-search').value = '';
        $('board-filter-status').value = 'all';
        $('board-sort').value = 'newest';
      }
      $('global-loader').classList.add('hidden');
      $('view-board').classList.remove('hidden');
      renderBoardHeader();
      renderBoardPosts();
      setSyncIndicator(true);
    } else if (!silentRefresh) {
      $('view-board').classList.add('hidden');
      $('global-loader').classList.remove('hidden');
    } else {
      setSyncIndicator(true);
    }

    const res = await API.rpc('getBoardDetail', boardId, passcode);
    $('global-loader').classList.add('hidden');
    setSyncIndicator(false);

    if (!res.ok) {
      if (res.code === 'PASSCODE_REQUIRED') {
        $('view-board').classList.add('hidden');
        $('passcode-board-title').textContent = 'กระดาน: ' + (res.boardTitle || boardId);
        $('input-board-passcode').value = '';
        $('form-passcode').dataset.boardId = boardId;
        openModal('modal-passcode');
        return;
      }
      showToast(res.message || 'ไม่สามารถเปิดกระดานได้', 'error');
      if (!cachedBoard && !silentRefresh) navigateToHome();
      return;
    }

    if (passcode) STATE.boardPasscodes[boardId] = passcode;
    if (res.board && !res.board.hasPasscode) {
      API.setCachedSnapshot(cacheName, res);
    }

    const preserveFilters = isSameBoard || !!cachedBoard || !!silentRefresh;
    STATE.activeBoard = res.board;
    STATE.activePosts = res.posts || [];
    if (!preserveFilters) {
      STATE.activeLayout = res.board.layout || 'masonry';
      STATE.boardSearch = '';
      STATE.boardCategory = 'all';
      STATE.boardStatus = 'all';
      STATE.boardSort = 'newest';
      $('board-search').value = '';
      $('board-filter-status').value = 'all';
      $('board-sort').value = 'newest';
    }

    $('view-board').classList.remove('hidden');
    renderBoardHeader();
    renderBoardPosts();
  }

  function renderBoardHeader() {
    const b = STATE.activeBoard;
    if (!b) return;

    const theme = b.theme || 'indigo';
    $('board-banner').className = 'board-banner theme-' + theme;
    $('board-surface').className = 'board-surface surface-' + theme;

    $('board-type-badge').textContent = TYPE_LABELS[b.boardType] || TYPE_LABELS.general;
    $('board-lock-badge').classList.toggle('hidden', !b.isLocked && b.allowPost);
    if (b.dueDate) {
      $('board-due-text').textContent = 'กำหนดส่ง ' + formatThaiDateOnly(b.dueDate);
      $('board-due-badge').classList.remove('hidden');
    } else {
      $('board-due-badge').classList.add('hidden');
    }

    $('board-title').textContent = b.title;
    $('board-desc').textContent = b.description || '';

    const canPost = !!STATE.user || (!b.isLocked && b.allowPost);
    $('btn-open-composer').classList.toggle('hidden', !canPost);
    $('fab-new-post').classList.toggle('hidden', !canPost);
    $('btn-board-edit').classList.toggle('hidden', !STATE.user);

    // Populate category filter
    const cats = b.categories && b.categories.length ? b.categories : ['ทั่วไป'];
    $('board-filter-category').innerHTML =
      '<option value="all">ทุกหมวด / ทุกกลุ่ม</option>' +
      cats.map((c) => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    $('board-filter-category').value = STATE.boardCategory;

    // Sync view switcher buttons
    document.querySelectorAll('.view-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.layout === STATE.activeLayout);
    });

    refreshIcons();
  }

  function getFilteredPosts() {
    const q = STATE.boardSearch.trim().toLowerCase();
    const list = STATE.activePosts.filter((p) => {
      if (STATE.boardCategory !== 'all' && p.category !== STATE.boardCategory) return false;
      if (STATE.boardStatus !== 'all' && p.status !== STATE.boardStatus) return false;
      if (q) {
        const hay = [p.title, p.content, p.authorName, p.authorCode, p.category, p.teacherFeedback].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return list.sort((a, b) => {
      if (STATE.boardSort === 'newest') {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return String(b.createdAt).localeCompare(String(a.createdAt));
      }
      if (STATE.boardSort === 'oldest') {
        return String(a.createdAt).localeCompare(String(b.createdAt));
      }
      if (STATE.boardSort === 'likes') {
        return (b.likesCount || 0) - (a.likesCount || 0);
      }
      if (STATE.boardSort === 'author') {
        return String(a.authorName || '').localeCompare(String(b.authorName || ''), 'th');
      }
      return 0;
    });
  }

  function renderPostCardHtml(p) {
    const b = STATE.activeBoard;
    const st = STATUS_META[p.status] || STATUS_META.approved;
    const isLiked = STATE.likedPosts.has(p.postId);
    const att = p.attachment;

    let mediaHtml = '';
    if (att && att.isImage) {
      const cached = STATE.imageDataCache[att.fileId];
      const imgSrc = cached || att.url || '';
      mediaHtml = `
        <div class="post-media" data-lightbox-src="${escHtml(imgSrc)}" data-file-id="${escHtml(att.fileId)}">
          <img src="${escHtml(imgSrc)}" alt="${escHtml(att.name)}" loading="lazy"
               data-drive-img="${escHtml(att.fileId)}" />
        </div>
      `;
    } else if (att) {
      mediaHtml = `
        <a class="attachment-chip" href="${escHtml(att.viewUrl || att.url)}" target="_blank" rel="noopener noreferrer" data-stop-card="1">
          <i data-lucide="file-text"></i>
          <span class="chip-text">${escHtml(att.name)}</span>
          <span style="font-size:0.74rem;color:var(--text-soft);">${escHtml(formatBytes(att.size))}</span>
        </a>
      `;
    }

    const linkHtml = p.linkUrl
      ? `
        <a class="link-chip" href="${escHtml(p.linkUrl)}" target="_blank" rel="noopener noreferrer" data-stop-card="1">
          <i data-lucide="external-link"></i>
          <span class="chip-text">${escHtml(p.linkUrl.replace(/^https?:\/\//i, ''))}</span>
        </a>
      `
      : '';

    const feedbackHtml = p.teacherFeedback
      ? `
        <div class="feedback-box">
          <strong>ข้อเสนอแนะจากครู</strong>
          ${escHtml(p.teacherFeedback)}
        </div>
      `
      : '';

    return `
      <article class="post-card card-${escHtml(p.cardColor || 'white')}" data-post-id="${escHtml(p.postId)}">
        <div class="post-top">
          <div class="post-author-row">
            <div class="avatar-circle">${escHtml(getInitials(p.authorName))}</div>
            <div>
              <div class="post-author-name">${escHtml(p.authorName)}</div>
              <div class="post-meta-sub">
                ${p.authorCode ? escHtml(p.authorCode) + ' • ' : ''}${escHtml(formatThaiDateTime(p.createdAt))}
              </div>
            </div>
          </div>
          <span class="tag-chip">${escHtml(p.category || 'ทั่วไป')}</span>
        </div>

        <div class="post-badges">
          ${p.pinned ? '<span class="status-badge st-pin"><i data-lucide="pin"></i> ปักหมุด</span>' : ''}
          ${(b.showScore || p.status !== 'approved') ? `<span class="status-badge ${st.cls}"><i data-lucide="${st.icon}"></i> ${st.label}</span>` : ''}
          ${b.showScore && p.score ? `<span class="status-badge st-score">คะแนน: ${escHtml(p.score)}</span>` : ''}
        </div>

        <h3 class="post-title" data-open-post="${escHtml(p.postId)}">${escHtml(p.title)}</h3>
        ${p.content ? `<p class="post-body">${escHtml(p.content)}</p>` : ''}
        ${mediaHtml}
        ${linkHtml}
        ${feedbackHtml}

        <div class="post-footer">
          <div class="post-actions">
            ${b.allowLike ? `
              <button type="button" class="action-chip ${isLiked ? 'liked' : ''}" data-like-post="${escHtml(p.postId)}">
                <i data-lucide="heart"></i>
                <span>${p.likesCount || 0}</span>
              </button>
            ` : ''}
            <button type="button" class="action-chip" data-open-post="${escHtml(p.postId)}">
              <i data-lucide="message-circle"></i>
              <span>${p.commentsCount || (p.comments ? p.comments.length : 0)}</span>
            </button>
          </div>
          <button type="button" class="action-chip" data-open-post="${escHtml(p.postId)}">
            <span>${STATE.user ? 'ตรวจ / จัดการ' : 'ดูรายละเอียด'}</span>
            <i data-lucide="chevron-right"></i>
          </button>
        </div>
      </article>
    `;
  }

  function renderBoardPosts() {
    const b = STATE.activeBoard;
    if (!b) return;

    const posts = getFilteredPosts();
    $('board-count-badge').textContent = posts.length + ' รายการ';

    const container = $('posts-container');
    const empty = $('posts-empty');

    if (posts.length === 0) {
      container.innerHTML = '';
      empty.classList.remove('hidden');
      refreshIcons();
      return;
    }

    empty.classList.add('hidden');

    if (STATE.activeLayout === 'masonry') {
      container.className = 'posts-masonry';
      container.innerHTML = posts.map(renderPostCardHtml).join('');
    } else if (STATE.activeLayout === 'columns') {
      container.className = 'posts-columns';
      const cats = Array.from(new Set([...(b.categories || []), ...posts.map((p) => p.category || 'ทั่วไป')]));
      container.innerHTML = cats.map((cat) => {
        const colPosts = posts.filter((p) => (p.category || 'ทั่วไป') === cat);
        return `
          <div class="shelf-column">
            <div class="shelf-header">
              <span class="shelf-title">${escHtml(cat)}</span>
              <span class="shelf-count">${colPosts.length}</span>
            </div>
            ${colPosts.length
              ? colPosts.map(renderPostCardHtml).join('')
              : '<div style="text-align:center;padding:24px 8px;color:var(--text-soft);font-size:0.84rem;">ยังไม่มีงานในหมวดนี้</div>'}
          </div>
        `;
      }).join('');
    } else {
      container.className = 'table-wrap';
      container.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>ผู้ส่ง / รหัส</th>
              <th>หมวด / กลุ่ม</th>
              <th>ชื่องาน</th>
              <th>ไฟล์แนบ / ลิงก์</th>
              <th>สถานะ</th>
              <th>คะแนน</th>
              <th>วันที่ส่ง</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            ${posts.map((p) => {
              const st = STATUS_META[p.status] || STATUS_META.approved;
              return `
                <tr>
                  <td>
                    <div style="font-weight:600;">${escHtml(p.authorName)}</div>
                    ${p.authorCode ? `<div style="font-size:0.78rem;color:var(--text-soft);">${escHtml(p.authorCode)}</div>` : ''}
                  </td>
                  <td><span class="tag-chip">${escHtml(p.category || 'ทั่วไป')}</span></td>
                  <td>
                    <a href="javascript:void(0)" data-open-post="${escHtml(p.postId)}" style="font-weight:600;color:var(--primary);">
                      ${p.pinned ? '📌 ' : ''}${escHtml(p.title)}
                    </a>
                  </td>
                  <td>
                    ${p.attachment ? `<a href="${escHtml(p.attachment.viewUrl || p.attachment.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--sky);font-weight:500;">📎 ${escHtml(p.attachment.name)}</a>` : ''}
                    ${p.linkUrl ? `<div><a href="${escHtml(p.linkUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary);font-size:0.82rem;">🔗 เปิดลิงก์</a></div>` : ''}
                    ${!p.attachment && !p.linkUrl ? '<span style="color:var(--text-soft);">-</span>' : ''}
                  </td>
                  <td><span class="status-badge ${st.cls}">${st.label}</span></td>
                  <td><strong>${escHtml(p.score || '-')}</strong></td>
                  <td style="white-space:nowrap;font-size:0.82rem;color:var(--text-soft);">${escHtml(formatThaiDateTime(p.createdAt))}</td>
                  <td>
                    <button type="button" class="btn btn-outline btn-sm" data-open-post="${escHtml(p.postId)}">
                      ${STATE.user ? 'ตรวจงาน' : 'เปิดดู'}
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    }

    attachDriveImageFallbacks(container);
    refreshIcons();
  }

  /**
   * หาก Google Drive thumbnail โหลดไม่ได้ (เช่น โรงเรียนบล็อก public sharing)
   * ให้ดึงภาพแบบ base64 dataURL ผ่าน RPC มาแสดงแทนอัตโนมัติ
   */
  function attachDriveImageFallbacks(rootEl) {
    if (API.isDemoMode()) return;
    rootEl.querySelectorAll('img[data-drive-img]').forEach((img) => {
      img.addEventListener('error', async function onImgErr() {
        img.removeEventListener('error', onImgErr);
        const fileId = img.getAttribute('data-drive-img');
        if (!fileId) return;
        if (STATE.imageDataCache[fileId]) {
          img.src = STATE.imageDataCache[fileId];
          return;
        }
        const res = await API.rpc('getAttachmentDataUrl', fileId);
        if (res.ok && res.dataUrl) {
          STATE.imageDataCache[fileId] = res.dataUrl;
          img.src = res.dataUrl;
          const wrap = img.closest('[data-lightbox-src]');
          if (wrap) wrap.setAttribute('data-lightbox-src', res.dataUrl);
        }
      });
    });
  }

  // ============================================================
  // Post Composer & Upload
  // ============================================================

  function openPostComposer() {
    const b = STATE.activeBoard;
    if (!b) return;
    $('composer-board-sub').textContent = 'กระดาน: ' + b.title;
    $('post-author-name').value = localStorage.getItem('kruboard_last_author') || (STATE.user ? STATE.user.displayName : '');
    $('post-author-code').value = localStorage.getItem('kruboard_last_code') || '';
    $('post-title').value = '';
    $('post-content').value = '';
    $('post-link').value = '';

    const cats = b.categories && b.categories.length ? b.categories : ['ทั่วไป'];
    $('post-category').innerHTML = cats.map((c) => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    if (STATE.boardCategory !== 'all' && cats.includes(STATE.boardCategory)) {
      $('post-category').value = STATE.boardCategory;
    }

    STATE.selectedCardColor = 'white';
    document.querySelectorAll('#post-color-picker .color-dot').forEach((d) => {
      d.classList.toggle('active', d.dataset.color === 'white');
    });

    clearPendingAttachment();
    openModal('modal-composer');
  }

  function setUploadProgress(visible, pct, text) {
    const wrap = $('upload-progress-wrap');
    if (!wrap) return;
    wrap.classList.toggle('hidden', !visible);
    if (visible) {
      const clamped = Math.max(0, Math.min(100, Math.round(pct || 0)));
      $('upload-progress-pct').textContent = clamped + '%';
      $('upload-progress-bar').style.width = clamped + '%';
      if (text) $('upload-progress-text').textContent = text;
    }
  }

  function clearPendingAttachment() {
    STATE.pendingAttachment = null;
    $('post-file-input').value = '';
    $('post-camera-input').value = '';
    $('upload-placeholder').classList.remove('hidden');
    $('upload-preview').classList.add('hidden');
    $('upload-preview-img').classList.add('hidden');
    $('upload-preview-img').src = '';
    setUploadProgress(false);
  }

  async function handleFileSelected(file) {
    if (!file) return;
    try {
      showToast('กำลังเตรียมไฟล์แนบ...', 'info');
      const att = await API.prepareAttachment(file);
      STATE.pendingAttachment = att;
      $('upload-placeholder').classList.add('hidden');
      $('upload-preview').classList.remove('hidden');
      $('upload-file-name').textContent = att.name;
      $('upload-file-size').textContent = formatBytes(att.size) + (att.isImage ? ' (บีบอัดพร้อมส่งแล้ว)' : ' (พร้อมอัปโหลดตรงเข้า Google Drive)');

      if (att.isImage && att.previewUrl) {
        $('upload-preview-img').src = att.previewUrl;
        $('upload-preview-img').classList.remove('hidden');
      } else {
        $('upload-preview-img').classList.add('hidden');
      }
      refreshIcons();
    } catch (err) {
      showToast(err.message || 'ไม่สามารถอ่านไฟล์ได้', 'error');
      clearPendingAttachment();
    }
  }

  async function handleSubmitPost(e) {
    e.preventDefault();
    const b = STATE.activeBoard;
    if (!b) return;

    const btn = $('btn-submit-post');
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2"></i><span>กำลังดำเนินการ...</span>';
    refreshIcons();

    const authorName = $('post-author-name').value.trim();
    const authorCode = $('post-author-code').value.trim();
    localStorage.setItem('kruboard_last_author', authorName);
    localStorage.setItem('kruboard_last_code', authorCode);

    const passcode = STATE.boardPasscodes[b.boardId] || '';
    let uploadedFile = null;
    let fallbackAttachment = null;

    if (STATE.pendingAttachment) {
      setUploadProgress(true, 2, 'กำลังเริ่มอัปโหลดไฟล์...');
      const upRes = await API.uploadAttachment(
        b.boardId,
        STATE.pendingAttachment,
        passcode,
        (pct, text) => setUploadProgress(true, pct, text)
      );

      if (!upRes.ok) {
        setUploadProgress(false);
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="send"></i><span>ส่งงานขึ้นกระดาน</span>';
        refreshIcons();
        showToast(upRes.message || 'อัปโหลดไฟล์ไม่สำเร็จ', 'error');
        return;
      }

      if (upRes.uploadedFile) uploadedFile = upRes.uploadedFile;
      if (upRes.attachment) fallbackAttachment = upRes.attachment;
      setUploadProgress(true, 100, 'อัปโหลดไฟล์เรียบร้อย กำลังบันทึกข้อมูลลงกระดาน...');
    }

    const payload = {
      boardId: b.boardId,
      authorName,
      authorCode,
      category: $('post-category').value,
      title: $('post-title').value.trim(),
      content: $('post-content').value.trim(),
      linkUrl: $('post-link').value.trim(),
      cardColor: STATE.selectedCardColor,
      passcode: passcode,
      uploadedFile: uploadedFile,
      attachment: fallbackAttachment
    };

    const res = await API.rpc('createPost', payload);
    setUploadProgress(false);
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="send"></i><span>ส่งงานขึ้นกระดาน</span>';
    refreshIcons();

    if (!res.ok) {
      showToast(res.message || 'ส่งงานไม่สำเร็จ', 'error');
      return;
    }

    closeModal('modal-composer');
    if (res.post && !res.pendingApproval) {
      STATE.activePosts.unshift(res.post);
      renderBoardPosts();
    }
    showToast(res.message || 'ส่งงานสำเร็จ', 'success');
    openBoard(b.boardId, undefined, true);
  }

  // ============================================================
  // Post Detail, Comments & Admin Review
  // ============================================================

  function openPostDetail(postId) {
    const p = STATE.activePosts.find((x) => x.postId === postId);
    const b = STATE.activeBoard;
    if (!p || !b) return;

    STATE.activeDetailPostId = postId;
    const st = STATUS_META[p.status] || STATUS_META.approved;

    $('detail-badges').innerHTML = `
      <span class="tag-chip">${escHtml(p.category || 'ทั่วไป')}</span>
      ${p.pinned ? '<span class="status-badge st-pin"><i data-lucide="pin"></i> ปักหมุด</span>' : ''}
      <span class="status-badge ${st.cls}">${st.label}</span>
      ${p.score ? `<span class="status-badge st-score">คะแนน: ${escHtml(p.score)}</span>` : ''}
    `;
    $('detail-title').textContent = p.title;

    const att = p.attachment;
    let attHtml = '';
    if (att && att.isImage) {
      const src = STATE.imageDataCache[att.fileId] || att.url || '';
      attHtml = `
        <div class="post-media" style="margin:12px 0;" data-lightbox-src="${escHtml(src)}">
          <img src="${escHtml(src)}" alt="${escHtml(att.name)}" style="max-height:380px;object-fit:contain;background:#0f172a08;" data-drive-img="${escHtml(att.fileId)}" />
        </div>
        <div style="margin-bottom:12px;">
          <a class="btn btn-outline btn-sm" href="${escHtml(att.viewUrl || att.url)}" target="_blank" rel="noopener noreferrer">
            <i data-lucide="external-link"></i> เปิดไฟล์ต้นฉบับใน Google Drive
          </a>
        </div>
      `;
    } else if (att) {
      attHtml = `
        <div style="margin:12px 0;display:flex;gap:8px;flex-wrap:wrap;">
          <a class="btn btn-outline btn-sm" href="${escHtml(att.viewUrl || att.url)}" target="_blank" rel="noopener noreferrer">
            <i data-lucide="file-text"></i> เปิดไฟล์: ${escHtml(att.name)} (${escHtml(formatBytes(att.size))})
          </a>
          <a class="btn btn-soft btn-sm" href="${escHtml(att.downloadUrl || att.url)}" target="_blank" rel="noopener noreferrer">
            <i data-lucide="download"></i> ดาวน์โหลด
          </a>
        </div>
      `;
    }

    const linkHtml = p.linkUrl
      ? `
        <div style="margin:10px 0;">
          <a class="link-chip" href="${escHtml(p.linkUrl)}" target="_blank" rel="noopener noreferrer">
            <i data-lucide="external-link"></i>
            <span class="chip-text">${escHtml(p.linkUrl)}</span>
          </a>
        </div>
      `
      : '';

    const adminPanelHtml = STATE.user
      ? `
        <div class="detail-section">
          <div class="admin-review-panel">
            <h3><i data-lucide="clipboard-check"></i> ส่วนตรวจงานและจัดการโพสต์ (สำหรับครูผู้ดูแล)</h3>
            <form id="form-review-post">
              <div class="form-grid-2">
                <div class="form-group">
                  <label for="rev-status">สถานะงาน</label>
                  <select id="rev-status">
                    <option value="approved" ${p.status === 'approved' ? 'selected' : ''}>เผยแพร่แล้ว / อนุมัติ</option>
                    <option value="checked" ${p.status === 'checked' ? 'selected' : ''}>ตรวจเรียบร้อยแล้ว</option>
                    <option value="needs_revision" ${p.status === 'needs_revision' ? 'selected' : ''}>ขอให้แก้ไขเพิ่มเติม</option>
                    <option value="pending" ${p.status === 'pending' ? 'selected' : ''}>ซ่อนไว้ / รออนุมัติ</option>
                  </select>
                </div>
                <div class="form-group">
                  <label for="rev-score">คะแนน / ผลการประเมิน</label>
                  <input type="text" id="rev-score" value="${escHtml(p.score || '')}" placeholder="เช่น 10/10, ดีเยี่ยม, ผ่าน" maxlength="50" />
                </div>
              </div>
              <div class="form-group">
                <label for="rev-feedback">ข้อเสนอแนะจากครู (แสดงบนการ์ดงาน)</label>
                <textarea id="rev-feedback" rows="2" maxlength="1000" placeholder="พิมพ์คำชมหรือจุดที่ควรปรับปรุง...">${escHtml(p.teacherFeedback || '')}</textarea>
              </div>
              <div class="btn-group" style="justify-content:space-between;">
                <div class="btn-group">
                  <button type="submit" class="btn btn-primary btn-sm">
                    <i data-lucide="save"></i> บันทึกผลการตรวจ
                  </button>
                  <button type="button" id="btn-detail-pin" class="btn btn-outline btn-sm">
                    <i data-lucide="pin"></i> ${p.pinned ? 'ยกเลิกปักหมุด' : 'ปักหมุดโพสต์'}
                  </button>
                </div>
                <button type="button" id="btn-detail-delete" class="btn btn-danger-ghost btn-sm">
                  <i data-lucide="trash-2"></i> ลบโพสต์นี้
                </button>
              </div>
            </form>
          </div>
        </div>
      `
      : (p.teacherFeedback
          ? `<div class="feedback-box" style="margin-top:12px;"><strong>ข้อเสนอแนะจากครู</strong>${escHtml(p.teacherFeedback)}</div>`
          : '');

    const comments = p.comments || [];
    const commentsHtml = `
      <div class="detail-section">
        <h3><i data-lucide="message-square"></i> ความคิดเห็น (${comments.length})</h3>
        <div class="comment-list" id="detail-comment-list">
          ${comments.length
            ? comments.map((c) => `
                <div class="comment-item">
                  <div class="comment-head">
                    <div>
                      <span class="comment-author">${escHtml(c.authorName)}</span>
                      ${c.authorRole === 'admin' ? '<span class="comment-teacher-tag">ครูผู้ดูแล</span>' : ''}
                      <span style="color:var(--text-soft);margin-left:6px;">${escHtml(formatThaiDateTime(c.createdAt))}</span>
                    </div>
                    ${STATE.user ? `<button type="button" class="icon-btn icon-btn-danger" data-delete-comment="${escHtml(c.commentId)}" title="ลบความคิดเห็น"><i data-lucide="trash-2"></i></button>` : ''}
                  </div>
                  <p class="comment-body">${escHtml(c.body)}</p>
                </div>
              `).join('')
            : '<p style="color:var(--text-soft);font-size:0.88rem;margin:0 0 12px;">ยังไม่มีความคิดเห็น เป็นคนแรกที่ร่วมแสดงความคิดเห็นได้เลย</p>'}
        </div>

        ${(b.allowComment && (!b.isLocked || STATE.user)) ? `
          <form id="form-add-comment">
            <div class="form-grid-2">
              <div class="form-group">
                <input type="text" id="comment-author" required maxlength="100"
                  value="${escHtml(STATE.user ? STATE.user.displayName : (localStorage.getItem('kruboard_last_author') || ''))}"
                  placeholder="ชื่อของคุณ..." />
              </div>
              <div class="form-group">
                <input type="text" id="comment-body" required maxlength="1000" placeholder="พิมพ์ความคิดเห็น..." />
              </div>
            </div>
            <button type="submit" class="btn btn-primary btn-sm">
              <i data-lucide="send"></i> ส่งความคิดเห็น
            </button>
          </form>
        ` : ''}
      </div>
    `;

    const bodyEl = $('detail-body');
    bodyEl.innerHTML = `
      <div class="post-author-row" style="margin-bottom:12px;">
        <div class="avatar-circle">${escHtml(getInitials(p.authorName))}</div>
        <div>
          <div class="post-author-name">${escHtml(p.authorName)} ${p.authorCode ? '(' + escHtml(p.authorCode) + ')' : ''}</div>
          <div class="post-meta-sub">ส่งเมื่อ ${escHtml(formatThaiDateTime(p.createdAt))}</div>
        </div>
      </div>
      ${p.content ? `<p class="post-body" style="font-size:0.95rem;margin-bottom:10px;">${escHtml(p.content)}</p>` : ''}
      ${attHtml}
      ${linkHtml}
      ${adminPanelHtml}
      ${commentsHtml}
    `;

    attachDriveImageFallbacks(bodyEl);
    bindDetailModalEvents(p);
    openModal('modal-post-detail');
  }

  function bindDetailModalEvents(p) {
    const revForm = $('form-review-post');
    if (revForm) {
      revForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nextStatus = $('rev-status').value;
        const nextScore = $('rev-score').value.trim();
        const nextFeedback = $('rev-feedback').value.trim();
        const res = await API.rpc('reviewPost', p.postId, {
          status: nextStatus,
          score: nextScore,
          teacherFeedback: nextFeedback
        });
        if (!res.ok) return showToast(res.message || 'บันทึกไม่สำเร็จ', 'error');
        // อัปเดต UI ทันทีโดยไม่รอรีโหลดทั้งหน้า
        p.status = nextStatus;
        p.score = nextScore;
        p.teacherFeedback = nextFeedback;
        renderBoardPosts();
        openPostDetail(p.postId);
        showToast(res.message || 'บันทึกผลการตรวจแล้ว', 'success');
        openBoard(STATE.activeBoard.boardId, undefined, true);
      });
    }

    const pinBtn = $('btn-detail-pin');
    if (pinBtn) {
      pinBtn.addEventListener('click', async () => {
        const res = await API.rpc('togglePinPost', p.postId);
        if (!res.ok) return showToast(res.message || 'ไม่สำเร็จ', 'error');
        p.pinned = !!res.pinned;
        renderBoardPosts();
        openPostDetail(p.postId);
        showToast(res.message, 'success');
        openBoard(STATE.activeBoard.boardId, undefined, true);
      });
    }

    const delBtn = $('btn-detail-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('ต้องการลบโพสต์ "' + p.title + '" และไฟล์แนบใช่หรือไม่?')) return;
        const res = await API.rpc('deletePost', p.postId);
        if (!res.ok) return showToast(res.message || 'ลบไม่สำเร็จ', 'error');
        closeModal('modal-post-detail');
        STATE.activePosts = STATE.activePosts.filter((x) => x.postId !== p.postId);
        renderBoardPosts();
        showToast('ลบโพสต์เรียบร้อยแล้ว', 'success');
        openBoard(STATE.activeBoard.boardId, undefined, true);
      });
    }

    const cmtForm = $('form-add-comment');
    if (cmtForm) {
      cmtForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const authorName = $('comment-author').value.trim();
        const body = $('comment-body').value.trim();
        if (!authorName || !body) return;
        localStorage.setItem('kruboard_last_author', authorName);
        const res = await API.rpc('addComment', { postId: p.postId, authorName, body });
        if (!res.ok) return showToast(res.message || 'ส่งความคิดเห็นไม่สำเร็จ', 'error');
        if (res.comment) {
          p.comments = p.comments || [];
          p.comments.push(res.comment);
          p.commentsCount = res.commentsCount || p.comments.length;
        }
        renderBoardPosts();
        openPostDetail(p.postId);
        showToast('เพิ่มความคิดเห็นแล้ว', 'success');
        openBoard(STATE.activeBoard.boardId, undefined, true);
      });
    }

    $('detail-body').querySelectorAll('[data-delete-comment]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cid = btn.getAttribute('data-delete-comment');
        if (!confirm('ลบความคิดเห็นนี้?')) return;
        const res = await API.rpc('deleteComment', cid);
        if (!res.ok) return showToast(res.message || 'ลบไม่สำเร็จ', 'error');
        p.comments = (p.comments || []).filter((c) => c.commentId !== cid);
        p.commentsCount = res.commentsCount !== undefined ? res.commentsCount : p.comments.length;
        renderBoardPosts();
        openPostDetail(p.postId);
        openBoard(STATE.activeBoard.boardId, undefined, true);
      });
    });
  }

  // ============================================================
  // Board Creator / Editor (Admin)
  // ============================================================

  function openBoardEditor(boardToEdit) {
    const isEdit = !!boardToEdit;
    $('board-editor-heading').textContent = isEdit ? 'ตั้งค่าและแก้ไขกระดาน' : 'สร้างกระดานส่งงานใหม่';
    $('edit-board-id').value = isEdit ? boardToEdit.boardId : '';
    $('edit-board-title').value = isEdit ? boardToEdit.title : '';
    $('edit-board-desc').value = isEdit ? boardToEdit.description : '';
    $('edit-board-type').value = isEdit ? boardToEdit.boardType : 'classroom';
    $('edit-board-layout').value = isEdit ? boardToEdit.layout : 'masonry';
    $('edit-board-due').value = isEdit ? (boardToEdit.dueDate || '') : '';
    $('edit-board-categories').value = isEdit ? (boardToEdit.categories || []).join(', ') : 'ทั่วไป';
    $('edit-board-passcode').value = isEdit ? (boardToEdit.passcode || '') : '';
    $('edit-allow-post').checked = isEdit ? !!boardToEdit.allowPost : true;
    $('edit-require-approval').checked = isEdit ? !!boardToEdit.requireApproval : false;
    $('edit-show-score').checked = isEdit ? !!boardToEdit.showScore : true;
    $('edit-allow-like').checked = isEdit ? !!boardToEdit.allowLike : true;
    $('edit-allow-comment').checked = isEdit ? !!boardToEdit.allowComment : true;
    $('edit-is-locked').checked = isEdit ? !!boardToEdit.isLocked : false;

    STATE.selectedBoardTheme = isEdit ? (boardToEdit.theme || 'indigo') : 'indigo';
    document.querySelectorAll('#board-theme-picker .theme-chip').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.theme === STATE.selectedBoardTheme);
    });

    $('btn-delete-board').classList.toggle('hidden', !isEdit);
    openModal('modal-board-editor');
  }

  async function handleSaveBoard(e) {
    e.preventDefault();
    const boardId = $('edit-board-id').value.trim();
    const payload = {
      title: $('edit-board-title').value.trim(),
      description: $('edit-board-desc').value.trim(),
      boardType: $('edit-board-type').value,
      layout: $('edit-board-layout').value,
      dueDate: $('edit-board-due').value,
      categories: $('edit-board-categories').value,
      theme: STATE.selectedBoardTheme,
      passcode: $('edit-board-passcode').value.trim(),
      allowPost: $('edit-allow-post').checked,
      requireApproval: $('edit-require-approval').checked,
      showScore: $('edit-show-score').checked,
      allowLike: $('edit-allow-like').checked,
      allowComment: $('edit-allow-comment').checked,
      isLocked: $('edit-is-locked').checked
    };

    const btn = $('btn-save-board');
    btn.disabled = true;
    const res = boardId
      ? await API.rpc('updateBoard', boardId, payload)
      : await API.rpc('createBoard', payload);
    btn.disabled = false;

    if (!res.ok) {
      showToast(res.message || 'บันทึกกระดานไม่สำเร็จ', 'error');
      return;
    }

    closeModal('modal-board-editor');
    showToast(res.message || 'บันทึกเรียบร้อยแล้ว', 'success');

    if (boardId && STATE.activeBoard && STATE.activeBoard.boardId === boardId) {
      await openBoard(boardId);
    } else if (!boardId && res.board) {
      await initApp();
      navigateToBoard(res.board.boardId);
    } else {
      await initApp();
    }
  }

  async function handleDeleteBoard() {
    const boardId = $('edit-board-id').value.trim();
    if (!boardId) return;
    if (!confirm('คำเตือน: การลบกระดานจะลบโพสต์ ความคิดเห็น และย้ายไฟล์แนบทั้งหมดของกระดานนี้ลงถังขยะ ยืนยันหรือไม่?')) {
      return;
    }
    const res = await API.rpc('deleteBoard', boardId);
    if (!res.ok) return showToast(res.message || 'ลบไม่สำเร็จ', 'error');
    closeModal('modal-board-editor');
    showToast('ลบกระดานเรียบร้อยแล้ว', 'success');
    navigateToHome();
    await initApp();
  }

  // ============================================================
  // Share QR Code & CSV Export
  // ============================================================

  function openShareModal(board) {
    if (!board) return;
    const url = buildBoardShareUrl(board.boardId);
    $('share-board-name').textContent = board.title;
    $('share-url-input').value = url;

    const note = $('share-passcode-note');
    if (board.hasPasscode) {
      note.textContent = board.passcode
        ? 'กระดานนี้มีรหัสผ่านเข้าใช้งาน: ' + board.passcode
        : 'กระดานนี้ตั้งรหัสผ่านไว้ กรุณาแจ้งรหัสผ่านแก่ผู้ส่งงาน';
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }

    const qrBox = $('qr-container');
    qrBox.innerHTML = '';
    if (window.QRCode) {
      new window.QRCode(qrBox, {
        text: url,
        width: 210,
        height: 210,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    } else {
      qrBox.innerHTML = '<p style="font-size:0.85rem;color:var(--text-soft);">คัดลอกลิงก์ด้านล่างเพื่อแชร์</p>';
    }

    openModal('modal-share');
  }

  function exportActiveBoardCsv() {
    const b = STATE.activeBoard;
    if (!b) return;
    const rows = getFilteredPosts();
    if (rows.length === 0) {
      showToast('ยังไม่มีข้อมูลสำหรับส่งออก', 'info');
      return;
    }

    const headers = [
      'ลำดับ', 'หมวดหมู่/กลุ่ม', 'ชื่อผู้ส่ง', 'รหัส/เลขที่', 'หัวข้อชิ้นงาน',
      'รายละเอียด', 'ลิงก์แนบ', 'ไฟล์แนบ (Google Drive)', 'สถานะ',
      'คะแนน/ผลตรวจ', 'ข้อเสนอแนะครู', 'ยอดถูกใจ', 'วันที่ส่ง'
    ];
    const escCsv = (val) => '"' + String(val == null ? '' : val).replace(/"/g, '""') + '"';

    const lines = [headers.map(escCsv).join(',')];
    rows.forEach((p, idx) => {
      const st = (STATUS_META[p.status] && STATUS_META[p.status].label) || p.status;
      lines.push([
        idx + 1,
        p.category || 'ทั่วไป',
        p.authorName,
        p.authorCode,
        p.title,
        p.content,
        p.linkUrl,
        p.attachment ? (p.attachment.viewUrl || p.attachment.name) : '',
        st,
        p.score,
        p.teacherFeedback,
        p.likesCount || 0,
        formatThaiDateTime(p.createdAt)
      ].map(escCsv).join(','));
    });

    // ใส่ UTF-8 BOM เพื่อให้เปิดภาษาไทยใน Microsoft Excel ไม่เพี้ยน
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kruboard_' + b.boardId + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('ส่งออกไฟล์ CSV เรียบร้อยแล้ว', 'success');
  }

  // ============================================================
  // Auth & Settings
  // ============================================================

  function openSettingsModal() {
    $('setting-gas-url').value = API.getActiveGasUrl();
    $('setting-system-name').value = STATE.settings.systemName || 'ครูบอร์ด';
    $('setting-school-name').value = STATE.settings.schoolName || '';
    $('setting-developer-name').value = STATE.settings.developerName || 'ครูก้องนที อุ่นเจริญ';
    $('setting-cur-pass').value = '';
    $('setting-new-pass').value = '';
    $('admin-only-settings').classList.toggle('hidden', !STATE.user);
    openModal('modal-settings');
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const u = $('login-username').value.trim();
    const p = $('login-password').value;
    const btn = $('btn-submit-login');
    btn.disabled = true;
    const res = await API.rpc('login', u, p);
    btn.disabled = false;

    if (!res.ok) {
      showToast(res.message || 'เข้าสู่ระบบไม่สำเร็จ', 'error');
      return;
    }

    API.setSessionToken(res.token);
    STATE.user = res.user;
    closeModal('modal-login');
    $('login-password').value = '';
    showToast(res.message || 'เข้าสู่ระบบสำเร็จ', 'success');
    await initApp();
  }

  async function handleLogout() {
    const token = API.getSessionToken();
    await API.rpc('logout', token);
    API.setSessionToken('');
    STATE.user = null;
    showToast('ออกจากระบบเรียบร้อยแล้ว', 'info');
    await initApp();
  }

  // ============================================================
  // Event Binding
  // ============================================================

  function bindGlobalEvents() {
    // Modal close buttons & overlay click
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close-modal')));
    });
    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.add('hidden');
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay:not(.hidden)').forEach((m) => m.classList.add('hidden'));
      }
    });

    // Top navigation
    $('brand-link').addEventListener('click', (e) => {
      e.preventDefault();
      navigateToHome();
    });
    $('btn-home-nav').addEventListener('click', navigateToHome);
    $('btn-refresh-home').addEventListener('click', initApp);
    $('btn-create-board-top').addEventListener('click', () => openBoardEditor(null));
    $('btn-hero-create').addEventListener('click', () => openBoardEditor(null));
    $('btn-hero-login').addEventListener('click', () => openModal('modal-login'));
    $('btn-settings-top').addEventListener('click', openSettingsModal);
    $('btn-open-connect').addEventListener('click', openSettingsModal);

    $('btn-admin-auth').addEventListener('click', () => {
      if (STATE.user) {
        if (confirm('ต้องการออกจากระบบครูผู้ดูแลใช่หรือไม่?')) handleLogout();
      } else {
        openModal('modal-login');
      }
    });

    // Home filters
    $('home-type-filters').addEventListener('click', (e) => {
      const btn = e.target.closest('.pill');
      if (!btn) return;
      STATE.homeFilterType = btn.dataset.type;
      document.querySelectorAll('#home-type-filters .pill').forEach((p) => p.classList.toggle('active', p === btn));
      renderHome();
    });
    $('home-search').addEventListener('input', (e) => {
      STATE.homeSearch = e.target.value;
      renderHome();
    });

    // Home board cards click delegation
    $('boards-grid').addEventListener('click', (e) => {
      const shareBtn = e.target.closest('[data-quick-share]');
      if (shareBtn) {
        e.stopPropagation();
        const bid = shareBtn.getAttribute('data-quick-share');
        const found = STATE.boards.find((b) => b.boardId === bid);
        if (found) openShareModal(found);
        return;
      }
      const card = e.target.closest('[data-open-board]');
      if (card) {
        navigateToBoard(card.getAttribute('data-open-board'));
      }
    });

    // Board controls
    $('btn-open-composer').addEventListener('click', openPostComposer);
    $('fab-new-post').addEventListener('click', openPostComposer);
    $('btn-board-edit').addEventListener('click', () => openBoardEditor(STATE.activeBoard));
    $('btn-board-share').addEventListener('click', () => openShareModal(STATE.activeBoard));
    $('btn-board-export').addEventListener('click', exportActiveBoardCsv);
    $('btn-board-refresh').addEventListener('click', () => STATE.activeBoard && openBoard(STATE.activeBoard.boardId, undefined, true));

    $('board-search').addEventListener('input', (e) => {
      STATE.boardSearch = e.target.value;
      renderBoardPosts();
    });
    $('board-filter-category').addEventListener('change', (e) => {
      STATE.boardCategory = e.target.value;
      renderBoardPosts();
    });
    $('board-filter-status').addEventListener('change', (e) => {
      STATE.boardStatus = e.target.value;
      renderBoardPosts();
    });
    $('board-sort').addEventListener('change', (e) => {
      STATE.boardSort = e.target.value;
      renderBoardPosts();
    });

    document.querySelectorAll('.view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        STATE.activeLayout = btn.dataset.layout;
        document.querySelectorAll('.view-btn').forEach((x) => x.classList.toggle('active', x === btn));
        renderBoardPosts();
      });
    });

    // Posts container click delegation (Like, Open Detail, Lightbox)
    $('posts-container').addEventListener('click', async (e) => {
      if (e.target.closest('[data-stop-card]')) return;

      const media = e.target.closest('[data-lightbox-src]');
      if (media) {
        const src = media.getAttribute('data-lightbox-src');
        if (src) {
          $('lightbox-img').src = src;
          openModal('modal-lightbox');
        }
        return;
      }

      const likeBtn = e.target.closest('[data-like-post]');
      if (likeBtn) {
        const postId = likeBtn.getAttribute('data-like-post');
        const already = STATE.likedPosts.has(postId);
        const delta = already ? -1 : 1;
        if (already) STATE.likedPosts.delete(postId);
        else STATE.likedPosts.add(postId);
        saveJsonSet('kruboard_liked_posts', STATE.likedPosts);

        // Optimistic UI update
        const p = STATE.activePosts.find((x) => x.postId === postId);
        if (p) p.likesCount = Math.max(0, (p.likesCount || 0) + delta);
        renderBoardPosts();

        const res = await API.rpc('toggleLike', postId, delta);
        if (res.ok && p) {
          p.likesCount = res.likesCount;
          renderBoardPosts();
        }
        return;
      }

      const openPostEl = e.target.closest('[data-open-post]');
      if (openPostEl) {
        openPostDetail(openPostEl.getAttribute('data-open-post'));
      }
    });

    // Lightbox click from detail modal too
    $('detail-body').addEventListener('click', (e) => {
      const media = e.target.closest('[data-lightbox-src]');
      if (media) {
        const src = media.getAttribute('data-lightbox-src');
        if (src) {
          $('lightbox-img').src = src;
          openModal('modal-lightbox');
        }
      }
    });

    // Post Composer events
    $('post-color-picker').addEventListener('click', (e) => {
      const dot = e.target.closest('.color-dot');
      if (!dot) return;
      STATE.selectedCardColor = dot.dataset.color;
      document.querySelectorAll('#post-color-picker .color-dot').forEach((d) => d.classList.toggle('active', d === dot));
    });

    $('btn-pick-file').addEventListener('click', () => $('post-file-input').click());
    $('btn-pick-camera').addEventListener('click', () => $('post-camera-input').click());
    $('post-file-input').addEventListener('change', (e) => handleFileSelected(e.target.files[0]));
    $('post-camera-input').addEventListener('change', (e) => handleFileSelected(e.target.files[0]));
    $('btn-clear-file').addEventListener('click', clearPendingAttachment);

    const dropzone = $('upload-dropzone');
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileSelected(e.dataTransfer.files[0]);
      }
    });
    $('form-composer').addEventListener('submit', handleSubmitPost);

    // Board Editor events
    $('board-theme-picker').addEventListener('click', (e) => {
      const chip = e.target.closest('.theme-chip');
      if (!chip) return;
      STATE.selectedBoardTheme = chip.dataset.theme;
      document.querySelectorAll('#board-theme-picker .theme-chip').forEach((c) => c.classList.toggle('active', c === chip));
    });
    $('form-board-editor').addEventListener('submit', handleSaveBoard);
    $('btn-delete-board').addEventListener('click', handleDeleteBoard);

    // Share modal
    $('btn-copy-share').addEventListener('click', async () => {
      const val = $('share-url-input').value;
      try {
        await navigator.clipboard.writeText(val);
        showToast('คัดลอกลิงก์กระดานแล้ว', 'success');
      } catch (e) {
        $('share-url-input').select();
        document.execCommand('copy');
        showToast('คัดลอกลิงก์กระดานแล้ว', 'success');
      }
    });

    $('btn-download-qr').addEventListener('click', () => {
      const canvas = $('qr-container').querySelector('canvas');
      const img = $('qr-container').querySelector('img');
      const dataUrl = canvas ? canvas.toDataURL('image/png') : (img ? img.src : '');
      if (!dataUrl) return;
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'kruboard-qr.png';
      a.click();
    });

    // Auth & Passcode
    $('form-login').addEventListener('submit', handleLoginSubmit);
    $('form-passcode').addEventListener('submit', (e) => {
      e.preventDefault();
      const bid = $('form-passcode').dataset.boardId;
      const pass = $('input-board-passcode').value.trim();
      closeModal('modal-passcode');
      openBoard(bid, pass);
    });

    // Settings
    $('form-gas-url').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('setting-gas-url').value.trim();
      showToast('กำลังทดสอบการเชื่อมต่อ...', 'info');
      const test = await API.testGasConnection(url);
      if (!test.ok) {
        showToast(test.message, 'error');
        return;
      }
      API.setGasUrlOverride(url);
      closeModal('modal-settings');
      showToast(test.message, 'success');
      await initApp();
    });

    $('btn-reset-demo').addEventListener('click', async () => {
      if (!confirm('รีเซ็ตข้อมูลตัวอย่างในโหมดทดลองใช้กลับเป็นค่าเริ่มต้นใช่หรือไม่?')) return;
      API.resetDemoDb();
      closeModal('modal-settings');
      showToast('รีเซ็ตข้อมูลโหมดทดลองเรียบร้อยแล้ว', 'success');
      await initApp();
    });

    $('form-system-settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await API.rpc('updateSystemSettings', {
        systemName: $('setting-system-name').value.trim(),
        schoolName: $('setting-school-name').value.trim(),
        developerName: $('setting-developer-name').value.trim()
      });
      if (!res.ok) return showToast(res.message || 'บันทึกไม่สำเร็จ', 'error');
      STATE.settings = res.settings;
      renderBrandingAndAuth();
      showToast(res.message || 'บันทึกการตั้งค่าแล้ว', 'success');
    });

    $('form-change-password').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await API.rpc('changeAdminPassword', $('setting-cur-pass').value, $('setting-new-pass').value);
      if (!res.ok) return showToast(res.message || 'เปลี่ยนรหัสผ่านไม่สำเร็จ', 'error');
      $('setting-cur-pass').value = '';
      $('setting-new-pass').value = '';
      showToast(res.message || 'เปลี่ยนรหัสผ่านสำเร็จ', 'success');
    });

    // Browser back/forward
    window.addEventListener('popstate', renderCurrentRoute);
  }

  // Register Service Worker for GitHub Pages / HTTPS
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindGlobalEvents();
    refreshIcons();
    initApp();
  });
})();
