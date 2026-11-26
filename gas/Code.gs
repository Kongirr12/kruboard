/**
 * ครูบอร์ด (KruBoard) — Google Apps Script API Backend
 * พัฒนาโดย: ครูก้องนที อุ่นเจริญ
 *
 * วิธีติดตั้ง:
 * 1. สร้าง Google Sheet เปล่า 1 ไฟล์ แล้วเปิดเมนู ส่วนขยาย (Extensions) -> Apps Script
 * 2. วางโค้ดนี้ลงในไฟล์ Code.gs (และตั้งค่า appsscript.json ถ้าใช้ clasp)
 * 3. กดรันฟังก์ชัน setupSystem() 1 ครั้ง เพื่อสร้างชีต โฟลเดอร์ Drive และบัญชีแอดมินเริ่มต้น
 * 4. กด Deploy -> New deployment -> Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. นำ Web App URL (ลงท้ายด้วย /exec) ไปวางในไฟล์ js/config.js ของ GitHub Pages
 */

const APP_VERSION = '1.3.0';
const CACHE_VERSION = 3;
const DEFAULT_SYSTEM_NAME = 'ครูบอร์ด';
const DEFAULT_SCHOOL_NAME = 'กระดานส่งงานออนไลน์';
const DEFAULT_DEVELOPER_NAME = 'ครูก้องนที อุ่นเจริญ';
const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASS = 'admin1234';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 ชั่วโมง
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;  // 30 MB (Direct Upload ตรงเข้า Google Drive)
const MAX_BASE64_FALLBACK_BYTES = 10 * 1024 * 1024; // 10 MB สำหรับ fallback Base64

// หากต้องการผูกสคริปต์แบบ Standalone (ไม่ได้สร้างจากเมนู Extensions ของ Sheet)
// ให้ใส่ Spreadsheet ID ที่นี่ หรือปล่อยว่างไว้ถ้าเป็น Container-bound script
const SPREADSHEET_ID = '';

const SHEET_SCHEMAS = {
  Config: ['Key', 'Value'],
  Users: ['UserID', 'Username', 'DisplayName', 'Role', 'PasswordHash', 'PasswordSalt', 'Active', 'CreatedAt'],
  Sessions: ['Token', 'UserID', 'Username', 'DisplayName', 'Role', 'ExpiresAt', 'CreatedAt'],
  Boards: [
    'BoardID', 'Title', 'Description', 'BoardType', 'Categories', 'Theme', 'Layout',
    'AllowPost', 'AllowLike', 'AllowComment', 'RequireApproval', 'ShowScore',
    'IsLocked', 'IsArchived', 'Passcode', 'DueDate', 'CreatedBy', 'CreatedAt', 'UpdatedAt'
  ],
  Posts: [
    'PostID', 'BoardID', 'Category', 'Title', 'Content', 'AuthorName', 'AuthorCode', 'AuthorRole',
    'LinkUrl', 'AttachmentFileId', 'AttachmentName', 'AttachmentMime', 'AttachmentUrl', 'AttachmentSize',
    'CardColor', 'Pinned', 'Status', 'Score', 'TeacherFeedback',
    'LikesCount', 'CommentsCount', 'CreatedAt', 'UpdatedAt', 'EditToken', 'EditPin'
  ],
  Comments: ['CommentID', 'PostID', 'BoardID', 'AuthorName', 'AuthorRole', 'Body', 'CreatedAt'],
  AuditLogs: ['Timestamp', 'Actor', 'Action', 'Target', 'Detail']
};

const TEXT_FIELDS = [
  'BoardID', 'PostID', 'CommentID', 'UserID', 'AuthorCode', 'Passcode',
  'DueDate', 'CreatedAt', 'UpdatedAt', 'Timestamp', 'AttachmentFileId', 'Score',
  'EditToken', 'EditPin'
];

const RPC_ALLOWED = [
  'getPublicInit',
  'getBoardDetail',
  'initDirectUpload',
  'createPost',
  'updatePost',
  'toggleLike',
  'addComment',
  'getAttachmentDataUrl',
  'login',
  'verifySession',
  'logout',
  'createBoard',
  'updateBoard',
  'deleteBoard',
  'reviewPost',
  'togglePinPost',
  'deletePost',
  'deleteComment',
  'updateSystemSettings',
  'changeAdminPassword'
];

const PUBLIC_FNS = [
  'getPublicInit',
  'getBoardDetail',
  'initDirectUpload',
  'createPost',
  'updatePost',
  'toggleLike',
  'addComment',
  'getAttachmentDataUrl',
  'login',
  'verifySession',
  'logout'
];

// ============================================================
// Web App HTTP Entrypoints (External Frontend via text/plain)
// ============================================================

function doGet(e) {
  try {
    return jsonOut_({
      ok: true,
      service: 'KruBoard API',
      version: APP_VERSION,
      developer: DEFAULT_DEVELOPER_NAME,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    Logger.log('[doGet] ERR ' + (err.stack || err));
    return jsonOut_({ ok: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
}

function doPost(e) {
  const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
  const ctype = (e && e.postData && e.postData.type) ? e.postData.type : 'none';
  Logger.log('[doPost] in size=' + raw.length + ' type=' + ctype);

  try {
    const payload = JSON.parse(raw);
    const fn = String(payload.fn || '');
    const args = Array.isArray(payload.args) ? payload.args : [];
    const token = String(payload.token || '');

    if (!RPC_ALLOWED.includes(fn)) {
      Logger.log('[doPost] forbidden fn=' + fn);
      return jsonOut_({ ok: false, message: 'ไม่อนุญาตให้เรียกใช้คำสั่งนี้: ' + fn });
    }

    ensureSchemaLazy_();

    let caller = null;
    if (token) {
      caller = getSessionUserOrNull_(token);
    }

    if (!PUBLIC_FNS.includes(fn)) {
      if (!caller) {
        return jsonOut_({ ok: false, code: 'UNAUTHORIZED', message: 'กรุณาเข้าสู่ระบบผู้ดูแลก่อนดำเนินการ' });
      }
      requireRole_(caller, ['admin']);
    }

    Logger.log('[doPost] dispatch fn=' + fn + ' user=' + (caller ? caller.Username : 'guest'));
    const result = globalThis[fn].apply(null, [caller, ...args]);
    Logger.log('[doPost] out fn=' + fn + ' ok=' + !!(result && result.ok));
    return jsonOut_(result);
  } catch (err) {
    Logger.log('[doPost] EXCEPTION ' + (err.stack || err));
    return jsonOut_({ ok: false, message: err.message || 'เกิดข้อผิดพลาดในการประมวลผล' });
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// Setup & Schema Initialization
// ============================================================

/**
 * รันฟังก์ชันนี้ครั้งแรกหลังติดตั้ง เพื่อสร้างทุกชีต โฟลเดอร์ Drive และบัญชีแอดมินเริ่มต้น
 */
function setupSystem() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('ระบบกำลังประมวลผล กรุณาลองใหม่');
  try {
    const ss = getSpreadsheet_();
    Object.keys(SHEET_SCHEMAS).forEach(function (name) {
      const sh = ensureSheet_(ss, name, SHEET_SCHEMAS[name]);
      SHEET_SCHEMAS[name].forEach(function (col) {
        if (TEXT_FIELDS.includes(col)) {
          ensureTextColumn_(sh, col);
        }
      });
    });

    ensureConfigEntry_(ss, 'SYSTEM_NAME', function () { return DEFAULT_SYSTEM_NAME; });
    ensureConfigEntry_(ss, 'SCHOOL_NAME', function () { return DEFAULT_SCHOOL_NAME; });
    ensureConfigEntry_(ss, 'DEVELOPER_NAME', function () { return DEFAULT_DEVELOPER_NAME; });
    ensureConfigEntry_(ss, 'UPLOADS_FOLDER_ID', function () {
      return createDriveFolderIfMissing_('KruBoard_Uploads');
    });

    // สร้างบัญชีแอดมินเริ่มต้นถ้ายังไม่มีผู้ใช้
    const userSheet = ss.getSheetByName('Users');
    const existingUsers = readSheet_(userSheet);
    if (existingUsers.length === 0) {
      const salt = generateSalt_();
      const hash = hashPassword_(DEFAULT_ADMIN_PASS, salt);
      appendRowSafe_(userSheet, {
        UserID: 'USR001',
        Username: DEFAULT_ADMIN_USER,
        DisplayName: DEFAULT_DEVELOPER_NAME,
        Role: 'admin',
        PasswordHash: hash,
        PasswordSalt: salt,
        Active: true,
        CreatedAt: new Date().toISOString()
      });
    }

    // สร้างกระดานตัวอย่าง 2 บอร์ด (ห้องเรียน + งานครู) หากยังไม่มีบอร์ดเลย
    const boardSheet = ss.getSheetByName('Boards');
    if (readSheet_(boardSheet).length === 0) {
      const now = new Date().toISOString();
      appendRowSafe_(boardSheet, {
        BoardID: 'BRD001',
        Title: 'กระดานส่งงานห้องเรียน (ตัวอย่าง)',
        Description: 'พื้นที่ส่งใบงาน ภาพกิจกรรม โครงงาน และแลกเปลี่ยนเรียนรู้ร่วมกันในชั้นเรียน',
        BoardType: 'classroom',
        Categories: JSON.stringify(['ม.1/1', 'ม.1/2', 'ม.1/3']),
        Theme: 'indigo',
        Layout: 'masonry',
        AllowPost: true,
        AllowLike: true,
        AllowComment: true,
        RequireApproval: false,
        ShowScore: true,
        IsLocked: false,
        IsArchived: false,
        Passcode: '',
        DueDate: '',
        CreatedBy: DEFAULT_DEVELOPER_NAME,
        CreatedAt: now,
        UpdatedAt: now
      });
      appendRowSafe_(boardSheet, {
        BoardID: 'BRD002',
        Title: 'กระดานส่งงานครูและเอกสารวิชาการ (ตัวอย่าง)',
        Description: 'ช่องทางส่งแผนการจัดการเรียนรู้ รายงานโครงการ และเอกสารกลุ่มสาระการเรียนรู้',
        BoardType: 'teacher_doc',
        Categories: JSON.stringify(['กลุ่มสาระคณิตศาสตร์', 'กลุ่มสาระวิทยาศาสตร์ฯ', 'กลุ่มสาระภาษาไทย', 'ฝ่ายบริหารวิชาการ']),
        Theme: 'emerald',
        Layout: 'columns',
        AllowPost: true,
        AllowLike: true,
        AllowComment: true,
        RequireApproval: false,
        ShowScore: true,
        IsLocked: false,
        IsArchived: false,
        Passcode: '',
        DueDate: '',
        CreatedBy: DEFAULT_DEVELOPER_NAME,
        CreatedAt: now,
        UpdatedAt: now
      });
    }

    SpreadsheetApp.flush();
    invalidateCache_();
    CacheService.getScriptCache().put('schema_ready_v' + CACHE_VERSION, '1', 3600);
    Logger.log('[setupSystem] completed successfully');
    return { ok: true, message: 'ติดตั้งฐานข้อมูลและโฟลเดอร์สำเร็จ' };
  } finally {
    lock.releaseLock();
  }
}

function ensureSchemaLazy_() {
  const cache = CacheService.getScriptCache();
  const key = 'schema_ready_v' + CACHE_VERSION;
  if (cache.get(key) === '1') return;
  const ss = getSpreadsheet_();
  let needsFullSetup = false;
  Object.keys(SHEET_SCHEMAS).forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) {
      needsFullSetup = true;
    } else {
      ensureSheet_(ss, name, SHEET_SCHEMAS[name]);
      if (name === 'Posts') {
        ensureTextColumn_(sh, 'EditToken');
        ensureTextColumn_(sh, 'EditPin');
      }
    }
  });
  if (needsFullSetup) {
    setupSystem();
  } else {
    SpreadsheetApp.flush();
    cache.put(key, '1', 3600);
  }
}

// ============================================================
// Public Read & Submission RPCs
// ============================================================

function getPublicInit(caller) {
  try {
    const isAdmin = !!(caller && caller.Role === 'admin');
    const cacheKey = 'kb_v' + CACHE_VERSION + '_init_' + (isAdmin ? 'adm' : 'pub');
    const cached = cacheGetJson_(cacheKey);
    if (cached) {
      return {
        ok: true,
        cached: true,
        settings: cached.settings,
        user: caller ? sanitizeUser_(caller) : null,
        stats: cached.stats,
        boards: cached.boards
      };
    }

    const ss = getSpreadsheet_();
    const settings = getSystemSettingsMap_(ss);
    const boardsRaw = readSheet_(ss.getSheetByName('Boards'));
    const postsRaw = readSheet_(ss.getSheetByName('Posts'));

    // นับจำนวนโพสต์ต่อบอร์ดฝั่ง server
    const statsByBoard = {};
    let totalPosts = 0;
    let pendingPosts = 0;
    let checkedPosts = 0;

    postsRaw.forEach(function (p) {
      const bid = String(p.BoardID || '');
      const status = String(p.Status || 'approved');
      if (!statsByBoard[bid]) {
        statsByBoard[bid] = { total: 0, approved: 0, pending: 0, checked: 0, revision: 0 };
      }
      statsByBoard[bid].total++;
      if (status === 'pending') {
        statsByBoard[bid].pending++;
        pendingPosts++;
      } else if (status === 'checked') {
        statsByBoard[bid].checked++;
        checkedPosts++;
      } else if (status === 'needs_revision') {
        statsByBoard[bid].revision++;
      } else {
        statsByBoard[bid].approved++;
      }
      if (isAdmin || status !== 'pending') {
        totalPosts++;
      }
    });

    const boards = boardsRaw
      .filter(function (b) { return isAdmin || !toBool_(b.IsArchived); })
      .map(function (b) {
        const bid = String(b.BoardID || '');
        const st = statsByBoard[bid] || { total: 0, approved: 0, pending: 0, checked: 0, revision: 0 };
        return formatBoard_(b, st, isAdmin);
      })
      .sort(function (a, b) {
        return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
      });

    const statsObj = {
      totalBoards: boards.length,
      totalPosts: isAdmin ? postsRaw.length : totalPosts,
      pendingPosts: pendingPosts,
      checkedPosts: checkedPosts
    };

    cachePutJson_(cacheKey, { settings: settings, stats: statsObj, boards: boards }, 120);

    return {
      ok: true,
      settings: settings,
      user: caller ? sanitizeUser_(caller) : null,
      stats: statsObj,
      boards: boards
    };
  } catch (err) {
    Logger.log('[getPublicInit] ERR ' + (err.stack || err));
    return { ok: false, message: 'ไม่สามารถโหลดข้อมูลระบบได้: ' + err.message };
  }
}

function getBoardDetail(caller, boardId, passcode) {
  try {
    if (!boardId || typeof boardId !== 'string') {
      return { ok: false, message: 'ไม่พบรหัสกระดาน' };
    }
    const isAdmin = !!(caller && caller.Role === 'admin');
    const cacheKey = 'kb_v' + CACHE_VERSION + '_brd_' + boardId + '_' + (isAdmin ? 'adm' : 'pub');
    const cached = cacheGetJson_(cacheKey);
    if (cached) {
      if (!isAdmin && cached.isArchived) {
        return { ok: false, message: 'กระดานนี้ถูกเก็บเข้าคลังแล้ว' };
      }
      if (!isAdmin && cached.expectedPass && String(passcode || '').trim() !== cached.expectedPass) {
        return {
          ok: false,
          code: 'PASSCODE_REQUIRED',
          boardTitle: cached.boardTitle || '',
          message: 'กระดานนี้ตั้งรหัสผ่านไว้ กรุณากรอกรหัสผ่านเพื่อเข้าใช้งาน'
        };
      }
      return { ok: true, cached: true, board: cached.board, posts: cached.posts };
    }

    const ss = getSpreadsheet_();
    const boardsRaw = readSheet_(ss.getSheetByName('Boards'));
    const boardRow = boardsRaw.find(function (b) { return String(b.BoardID) === String(boardId); });

    if (!boardRow) {
      return { ok: false, message: 'ไม่พบกระดานงานที่ต้องการ' };
    }
    if (!isAdmin && toBool_(boardRow.IsArchived)) {
      return { ok: false, message: 'กระดานนี้ถูกเก็บเข้าคลังแล้ว' };
    }

    const expectedPass = String(boardRow.Passcode || '').trim();
    if (!isAdmin && expectedPass && String(passcode || '').trim() !== expectedPass) {
      return {
        ok: false,
        code: 'PASSCODE_REQUIRED',
        boardTitle: String(boardRow.Title || ''),
        message: 'กระดานนี้ตั้งรหัสผ่านไว้ กรุณากรอกรหัสผ่านเพื่อเข้าใช้งาน'
      };
    }

    const postsRaw = readSheet_(ss.getSheetByName('Posts')).filter(function (p) {
      return String(p.BoardID) === String(boardId);
    });
    const commentsRaw = readSheet_(ss.getSheetByName('Comments')).filter(function (c) {
      return String(c.BoardID) === String(boardId);
    });

    const commentsByPost = {};
    commentsRaw.forEach(function (c) {
      const pid = String(c.PostID || '');
      if (!commentsByPost[pid]) commentsByPost[pid] = [];
      commentsByPost[pid].push({
        commentId: String(c.CommentID || ''),
        postId: pid,
        boardId: String(c.BoardID || ''),
        authorName: String(c.AuthorName || ''),
        authorRole: String(c.AuthorRole || 'user'),
        body: String(c.Body || ''),
        createdAt: toIsoOrEmpty_(c.CreatedAt)
      });
    });

    const visiblePosts = postsRaw
      .filter(function (p) {
        if (isAdmin) return true;
        return String(p.Status || 'approved') !== 'pending';
      })
      .map(function (p) {
        const pid = String(p.PostID || '');
        const pComments = (commentsByPost[pid] || []).sort(function (a, b) {
          return String(a.createdAt).localeCompare(String(b.createdAt));
        });
        return formatPost_(p, pComments);
      })
      .sort(function (a, b) {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });

    const st = {
      total: postsRaw.length,
      approved: postsRaw.filter(function (p) { return String(p.Status) === 'approved'; }).length,
      pending: postsRaw.filter(function (p) { return String(p.Status) === 'pending'; }).length,
      checked: postsRaw.filter(function (p) { return String(p.Status) === 'checked'; }).length,
      revision: postsRaw.filter(function (p) { return String(p.Status) === 'needs_revision'; }).length
    };

    const boardFormatted = formatBoard_(boardRow, st, isAdmin);
    cachePutJson_(cacheKey, {
      expectedPass: expectedPass,
      isArchived: toBool_(boardRow.IsArchived),
      boardTitle: String(boardRow.Title || ''),
      board: boardFormatted,
      posts: visiblePosts
    }, 120);

    return {
      ok: true,
      board: boardFormatted,
      posts: visiblePosts
    };
  } catch (err) {
    Logger.log('[getBoardDetail] ERR ' + (err.stack || err));
    return { ok: false, message: 'ไม่สามารถโหลดข้อมูลกระดานได้: ' + err.message };
  }
}

function createPost(caller, payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'ข้อมูลที่ส่งไม่ถูกต้อง' };
  }

  const boardId = String(payload.boardId || '').trim();
  const title = String(payload.title || '').trim();
  const content = String(payload.content || '').trim();
  const authorName = String(payload.authorName || '').trim();
  const authorCode = String(payload.authorCode || '').trim();
  const category = String(payload.category || '').trim();
  const linkUrl = String(payload.linkUrl || '').trim();
  const cardColor = String(payload.cardColor || 'white').trim();
  const passcode = String(payload.passcode || '').trim();

  if (!boardId) return { ok: false, message: 'ไม่พบรหัสกระดาน' };
  if (!authorName) return { ok: false, message: 'กรุณาระบุชื่อผู้ส่งงาน' };
  if (!title) return { ok: false, message: 'กรุณาระบุหัวข้อหรืองานที่ส่ง' };
  if (title.length > 200) return { ok: false, message: 'หัวข้อต้องไม่เกิน 200 ตัวอักษร' };
  if (content.length > 4000) return { ok: false, message: 'รายละเอียดต้องไม่เกิน 4,000 ตัวอักษร' };
  if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
    return { ok: false, message: 'ลิงก์แนบต้องขึ้นต้นด้วย http:// หรือ https://' };
  }

  // ตรวจสอบบอร์ดก่อน upload ไฟล์ (ไม่ต้องถือ lock ระหว่าง upload Drive)
  const ss = getSpreadsheet_();
  const isAdmin = !!(caller && caller.Role === 'admin');
  const boardRow = readSheet_(ss.getSheetByName('Boards')).find(function (b) {
    return String(b.BoardID) === boardId;
  });

  if (!boardRow) return { ok: false, message: 'ไม่พบกระดานงานที่ต้องการ' };
  if (!isAdmin && (toBool_(boardRow.IsLocked) || toBool_(boardRow.IsArchived) || !toBool_(boardRow.AllowPost))) {
    return { ok: false, message: 'กระดานนี้ปิดรับการส่งงานชั่วคราว' };
  }
  const expectedPass = String(boardRow.Passcode || '').trim();
  if (!isAdmin && expectedPass && passcode !== expectedPass) {
    return { ok: false, code: 'PASSCODE_REQUIRED', message: 'รหัสผ่านกระดานไม่ถูกต้อง' };
  }

  // จัดการไฟล์แนบ: รองรับทั้ง Direct Upload (ส่ง fileId มาแล้ว) และ Base64 Fallback
  let attachmentInfo = { fileId: '', name: '', mime: '', url: '', size: 0 };
  if (payload.uploadedFile && payload.uploadedFile.fileId) {
    try {
      attachmentInfo = finalizeDirectUploadFile_(payload.uploadedFile);
    } catch (finErr) {
      Logger.log('[createPost] finalizeDirectUpload ERR ' + finErr.message);
      return { ok: false, message: 'ยืนยันไฟล์ที่อัปโหลดไม่สำเร็จ: ' + finErr.message };
    }
  } else if (payload.attachment && payload.attachment.dataUrl) {
    try {
      attachmentInfo = saveAttachmentToDrive_(boardId, payload.attachment);
    } catch (upErr) {
      Logger.log('[createPost] upload ERR ' + upErr.message);
      return { ok: false, message: 'อัปโหลดไฟล์ไม่สำเร็จ: ' + upErr.message };
    }
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { ok: false, message: 'ระบบกำลังบันทึกข้อมูลจำนวนมาก กรุณาลองใหม่ในอีกสักครู่' };
  }

  try {
    const postSheet = ss.getSheetByName('Posts');
    const now = new Date().toISOString();
    const postId = 'PST' + Date.now() + '_' + Math.floor(100 + Math.random() * 900);
    const editToken = Utilities.getUuid();
    const editPin = String(payload.editPin || '').trim().slice(0, 20);
    const needApproval = !isAdmin && toBool_(boardRow.RequireApproval);
    const initialStatus = needApproval ? 'pending' : 'approved';

    const rowObj = {
      PostID: postId,
      BoardID: boardId,
      Category: category || 'ทั่วไป',
      Title: title,
      Content: content,
      AuthorName: authorName,
      AuthorCode: authorCode,
      AuthorRole: isAdmin ? 'admin' : 'user',
      LinkUrl: linkUrl,
      AttachmentFileId: attachmentInfo.fileId,
      AttachmentName: attachmentInfo.name,
      AttachmentMime: attachmentInfo.mime,
      AttachmentUrl: attachmentInfo.url,
      AttachmentSize: attachmentInfo.size,
      CardColor: cardColor,
      Pinned: false,
      Status: initialStatus,
      Score: '',
      TeacherFeedback: '',
      LikesCount: 0,
      CommentsCount: 0,
      CreatedAt: now,
      UpdatedAt: now,
      EditToken: editToken,
      EditPin: editPin
    };

    appendRowSafe_(postSheet, rowObj);

    // อัปเดต UpdatedAt ของบอร์ด
    const boardSheet = ss.getSheetByName('Boards');
    const freshBoard = readSheet_(boardSheet).find(function (b) { return String(b.BoardID) === boardId; });
    if (freshBoard) {
      boardSheet.getRange(freshBoard.__rowIndex, colIndex_(boardSheet, 'UpdatedAt')).setValue("'" + now);
    }

    SpreadsheetApp.flush();
    invalidateBoardCache_(boardId);
    invalidateInitCache_();

    return {
      ok: true,
      pendingApproval: needApproval,
      editToken: editToken,
      message: needApproval
        ? 'ส่งงานเรียบร้อยแล้ว งานของคุณจะแสดงบนกระดานเมื่อครูผู้ดูแลอนุมัติ'
        : 'ส่งงานขึ้นกระดานเรียบร้อยแล้ว',
      post: formatPost_(rowObj, [])
    };
  } catch (err) {
    Logger.log('[createPost] ERR ' + (err.stack || err));
    return { ok: false, message: 'ไม่สามารถบันทึกโพสต์ได้: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * แก้ไขงานที่ส่งแล้ว (รองรับทั้งผู้ส่งเจ้าของโพสต์ผ่าน EditToken/PIN และครูผู้ดูแล)
 */
function updatePost(caller, postId, payload) {
  if (!postId || !payload || typeof payload !== 'object') {
    return { ok: false, message: 'ข้อมูลที่ต้องการแก้ไขไม่ถูกต้อง' };
  }

  const title = String(payload.title || '').trim();
  const content = String(payload.content || '').trim();
  const authorName = String(payload.authorName || '').trim();
  const authorCode = String(payload.authorCode || '').trim();
  const category = String(payload.category || '').trim();
  const linkUrl = String(payload.linkUrl || '').trim();
  const cardColor = String(payload.cardColor || 'white').trim();

  if (!authorName) return { ok: false, message: 'กรุณาระบุชื่อผู้ส่งงาน' };
  if (!title) return { ok: false, message: 'กรุณาระบุหัวข้อหรืองานที่ส่ง' };
  if (title.length > 200) return { ok: false, message: 'หัวข้อต้องไม่เกิน 200 ตัวอักษร' };
  if (content.length > 4000) return { ok: false, message: 'รายละเอียดต้องไม่เกิน 4,000 ตัวอักษร' };
  if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
    return { ok: false, message: 'ลิงก์แนบต้องขึ้นต้นด้วย http:// หรือ https://' };
  }

  const ss = getSpreadsheet_();
  const isAdmin = !!(caller && caller.Role === 'admin');
  const postSheet = ss.getSheetByName('Posts');
  const existingRow = readSheet_(postSheet).find(function (p) { return String(p.PostID) === String(postId); });
  if (!existingRow) return { ok: false, message: 'ไม่พบโพสต์ที่ต้องการแก้ไข' };

  const boardId = String(existingRow.BoardID || '');
  const boardRow = readSheet_(ss.getSheetByName('Boards')).find(function (b) {
    return String(b.BoardID) === boardId;
  });
  if (!boardRow) return { ok: false, message: 'ไม่พบกระดานงาน' };

  if (!isAdmin) {
    if (toBool_(boardRow.IsLocked) || toBool_(boardRow.IsArchived) || !toBool_(boardRow.AllowPost)) {
      return { ok: false, message: 'กระดานนี้ปิดรับการแก้ไขงานแล้ว' };
    }
    if (String(existingRow.Status) === 'checked') {
      return { ok: false, message: 'งานนี้ครูตรวจเรียบร้อยแล้ว ไม่สามารถแก้ไขได้' };
    }

    const storedToken = String(existingRow.EditToken || '').trim();
    const storedPin = String(existingRow.EditPin || '').trim();
    const inputToken = String(payload.editToken || '').trim();
    const inputPin = String(payload.editPin || '').trim();

    const tokenMatch = !!(storedToken && inputToken && storedToken === inputToken);
    const pinMatch = !!(storedPin && inputPin && storedPin === inputPin);

    if (!tokenMatch && !pinMatch) {
      return {
        ok: false,
        code: 'EDIT_AUTH_REQUIRED',
        message: 'ไม่มีสิทธิ์แก้ไขงานนี้ หรือรหัสแก้ไข (PIN) ไม่ถูกต้อง'
      };
    }
  }

  // จัดการไฟล์แนบใหม่ (นอก lock เพื่อไม่ให้บล็อกคนอื่น)
  let newAttachmentInfo = null;
  if (payload.uploadedFile && payload.uploadedFile.fileId) {
    try {
      newAttachmentInfo = finalizeDirectUploadFile_(payload.uploadedFile);
    } catch (finErr) {
      Logger.log('[updatePost] finalizeDirectUpload ERR ' + finErr.message);
      return { ok: false, message: 'ยืนยันไฟล์ใหม่ไม่สำเร็จ: ' + finErr.message };
    }
  } else if (payload.attachment && payload.attachment.dataUrl) {
    try {
      newAttachmentInfo = saveAttachmentToDrive_(boardId, payload.attachment);
    } catch (upErr) {
      Logger.log('[updatePost] upload ERR ' + upErr.message);
      return { ok: false, message: 'อัปโหลดไฟล์ใหม่ไม่สำเร็จ: ' + upErr.message };
    }
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { ok: false, message: 'ระบบกำลังบันทึกข้อมูล กรุณาลองใหม่ในอีกสักครู่' };
  }

  try {
    const freshRow = readSheet_(postSheet).find(function (p) { return String(p.PostID) === String(postId); });
    if (!freshRow) return { ok: false, message: 'ไม่พบโพสต์ที่ต้องการแก้ไข' };

    const now = new Date().toISOString();
    const updates = {
      Category: category || String(freshRow.Category || 'ทั่วไป'),
      Title: title,
      Content: content,
      AuthorName: authorName,
      AuthorCode: authorCode,
      LinkUrl: linkUrl,
      CardColor: cardColor,
      UpdatedAt: now
    };

    if (payload.newEditPin !== undefined) {
      updates.EditPin = String(payload.newEditPin || '').trim().slice(0, 20);
    }

    // ถ้าครูเคยสั่ง "ขอให้แก้ไข" แล้วผู้ส่งเข้ามาแก้ → เปลี่ยนสถานะกลับเป็นรอตรวจ/เผยแพร่
    if (!isAdmin && String(freshRow.Status) === 'needs_revision') {
      updates.Status = toBool_(boardRow.RequireApproval) ? 'pending' : 'approved';
    }

    const oldFileId = String(freshRow.AttachmentFileId || '');
    if (newAttachmentInfo) {
      updates.AttachmentFileId = newAttachmentInfo.fileId;
      updates.AttachmentName = newAttachmentInfo.name;
      updates.AttachmentMime = newAttachmentInfo.mime;
      updates.AttachmentUrl = newAttachmentInfo.url;
      updates.AttachmentSize = newAttachmentInfo.size;
      if (oldFileId && oldFileId !== newAttachmentInfo.fileId) {
        trashDriveFileQuiet_(oldFileId);
      }
    } else if (payload.removeAttachment) {
      updates.AttachmentFileId = '';
      updates.AttachmentName = '';
      updates.AttachmentMime = '';
      updates.AttachmentUrl = '';
      updates.AttachmentSize = 0;
      if (oldFileId) trashDriveFileQuiet_(oldFileId);
    }

    updateRowByHeaders_(postSheet, freshRow.__rowIndex, updates);
    SpreadsheetApp.flush();
    invalidateBoardCache_(boardId);
    invalidateInitCache_();

    const merged = Object.assign({}, freshRow, updates);
    const commentsRaw = readSheet_(ss.getSheetByName('Comments'))
      .filter(function (c) { return String(c.PostID) === String(postId); })
      .map(function (c) {
        return {
          commentId: String(c.CommentID || ''),
          postId: String(c.PostID || ''),
          boardId: String(c.BoardID || ''),
          authorName: String(c.AuthorName || ''),
          authorRole: String(c.AuthorRole || 'user'),
          body: String(c.Body || ''),
          createdAt: toIsoOrEmpty_(c.CreatedAt)
        };
      });

    return {
      ok: true,
      message: 'บันทึกการแก้ไขงานเรียบร้อยแล้ว',
      post: formatPost_(merged, commentsRaw)
    };
  } catch (err) {
    Logger.log('[updatePost] ERR ' + (err.stack || err));
    return { ok: false, message: 'ไม่สามารถบันทึกการแก้ไขงานได้: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function toggleLike(caller, postId, delta) {
  if (!postId) return { ok: false, message: 'ไม่พบรหัสโพสต์' };
  const step = Number(delta) < 0 ? -1 : 1;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const postSheet = ss.getSheetByName('Posts');
    const post = readSheet_(postSheet).find(function (p) { return String(p.PostID) === String(postId); });
    if (!post) return { ok: false, message: 'ไม่พบโพสต์นี้' };

    const board = readSheet_(ss.getSheetByName('Boards')).find(function (b) {
      return String(b.BoardID) === String(post.BoardID);
    });
    if (board && !toBool_(board.AllowLike)) {
      return { ok: false, message: 'กระดานนี้ปิดการกดถูกใจ' };
    }

    const nextCount = Math.max(0, (parseInt(post.LikesCount, 10) || 0) + step);
    postSheet.getRange(post.__rowIndex, colIndex_(postSheet, 'LikesCount')).setValue(nextCount);
    SpreadsheetApp.flush();
    invalidateBoardCache_(String(post.BoardID));
    return { ok: true, postId: postId, likesCount: nextCount };
  } catch (err) {
    Logger.log('[toggleLike] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถอัปเดตยอดถูกใจได้' };
  } finally {
    lock.releaseLock();
  }
}

function addComment(caller, payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'ข้อมูลความคิดเห็นไม่ถูกต้อง' };
  }
  const postId = String(payload.postId || '').trim();
  const authorName = String(payload.authorName || (caller ? caller.DisplayName : '') || '').trim();
  const body = String(payload.body || '').trim();

  if (!postId) return { ok: false, message: 'ไม่พบรหัสโพสต์' };
  if (!authorName) return { ok: false, message: 'กรุณาระบุชื่อผู้แสดงความคิดเห็น' };
  if (!body) return { ok: false, message: 'กรุณาพิมพ์ข้อความความคิดเห็น' };
  if (body.length > 1000) return { ok: false, message: 'ความคิดเห็นต้องไม่เกิน 1,000 ตัวอักษร' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const postSheet = ss.getSheetByName('Posts');
    const post = readSheet_(postSheet).find(function (p) { return String(p.PostID) === postId; });
    if (!post) return { ok: false, message: 'ไม่พบโพสต์ที่ต้องการแสดงความคิดเห็น' };

    const isAdmin = !!(caller && caller.Role === 'admin');
    const board = readSheet_(ss.getSheetByName('Boards')).find(function (b) {
      return String(b.BoardID) === String(post.BoardID);
    });
    if (!isAdmin && board && (!toBool_(board.AllowComment) || toBool_(board.IsLocked))) {
      return { ok: false, message: 'กระดานนี้ปิดการแสดงความคิดเห็น' };
    }

    const commentSheet = ss.getSheetByName('Comments');
    const now = new Date().toISOString();
    const commentId = 'CMT' + Date.now() + '_' + Math.floor(100 + Math.random() * 900);

    appendRowSafe_(commentSheet, {
      CommentID: commentId,
      PostID: postId,
      BoardID: String(post.BoardID),
      AuthorName: authorName,
      AuthorRole: isAdmin ? 'admin' : 'user',
      Body: body,
      CreatedAt: now
    });

    // คำนวณจำนวนคอมเมนต์ใหม่ฝั่ง server
    const allComments = readSheet_(commentSheet).filter(function (c) {
      return String(c.PostID) === postId;
    });
    postSheet.getRange(post.__rowIndex, colIndex_(postSheet, 'CommentsCount')).setValue(allComments.length);
    SpreadsheetApp.flush();
    invalidateBoardCache_(String(post.BoardID));

    return {
      ok: true,
      comment: {
        commentId: commentId,
        postId: postId,
        boardId: String(post.BoardID),
        authorName: authorName,
        authorRole: isAdmin ? 'admin' : 'user',
        body: body,
        createdAt: now
      },
      commentsCount: allComments.length
    };
  } catch (err) {
    Logger.log('[addComment] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถบันทึกความคิดเห็นได้: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Fallback สำหรับดึงรูปภาพจาก Drive เป็น base64 dataURL
 * ใช้กรณี Google Workspace ของโรงเรียนปิด public sharing (Rule drive-ops #3/#4.1)
 */
function getAttachmentDataUrl(caller, fileId) {
  try {
    if (!fileId || typeof fileId !== 'string') {
      return { ok: false, message: 'ไม่พบรหัสไฟล์' };
    }
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const bytes = blob.getBytes();
    if (bytes.length > 4 * 1024 * 1024) {
      return { ok: false, message: 'ไฟล์มีขนาดใหญ่เกินกว่าจะแสดงตัวอย่างแบบฝัง กรุณาเปิดดูใน Google Drive' };
    }
    const mime = blob.getContentType() || 'application/octet-stream';
    const b64 = Utilities.base64Encode(bytes);
    return {
      ok: true,
      fileId: fileId,
      name: file.getName(),
      mime: mime,
      dataUrl: 'data:' + mime + ';base64,' + b64
    };
  } catch (err) {
    Logger.log('[getAttachmentDataUrl] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถดึงไฟล์แนบได้' };
  }
}

// ============================================================
// Auth RPCs (PBKDF2-HMAC-SHA256 + Session Token)
// ============================================================

function login(caller, username, password) {
  const uname = String(username || '').trim();
  const pass = String(password || '');
  if (!uname || !pass) {
    return { ok: false, message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const users = readSheet_(ss.getSheetByName('Users'));
    const user = users.find(function (u) {
      return String(u.Username).toLowerCase() === uname.toLowerCase();
    });

    if (!user || !toBool_(user.Active)) {
      return { ok: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
    }

    const expectedHash = hashPassword_(pass, String(user.PasswordSalt || ''));
    if (expectedHash !== String(user.PasswordHash || '')) {
      return { ok: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
    }

    const token = Utilities.getUuid();
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    const sessionSheet = ss.getSheetByName('Sessions');

    // ล้าง session หมดอายุออกบ้าง
    pruneExpiredSessions_(sessionSheet);

    appendRowSafe_(sessionSheet, {
      Token: token,
      UserID: String(user.UserID),
      Username: String(user.Username),
      DisplayName: String(user.DisplayName),
      Role: String(user.Role),
      ExpiresAt: expiresAt,
      CreatedAt: new Date(now).toISOString()
    });

    logAudit_(ss, user.Username, 'login', user.UserID, 'Admin login');
    SpreadsheetApp.flush();

    return {
      ok: true,
      token: token,
      user: sanitizeUser_(user),
      message: 'เข้าสู่ระบบสำเร็จ'
    };
  } catch (err) {
    Logger.log('[login] ERR ' + (err.stack || err));
    return { ok: false, message: 'ไม่สามารถเข้าสู่ระบบได้: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function verifySession(caller) {
  if (!caller) {
    return { ok: false, message: 'ไม่ได้เข้าสู่ระบบหรือเซสชันหมดอายุ' };
  }
  return { ok: true, user: sanitizeUser_(caller) };
}

function logout(caller, tokenToRevoke) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: true };
  try {
    const ss = getSpreadsheet_();
    const sessionSheet = ss.getSheetByName('Sessions');
    const rows = readSheet_(sessionSheet);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (tokenToRevoke && String(rows[i].Token) === String(tokenToRevoke)) {
        sessionSheet.deleteRow(rows[i].__rowIndex);
      }
    }
    SpreadsheetApp.flush();
    invalidateSessionCache_(tokenToRevoke);
    return { ok: true, message: 'ออกจากระบบแล้ว' };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// Admin RPCs (Boards, Post Moderation, Settings)
// ============================================================

function createBoard(caller, payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'ข้อมูลกระดานไม่ถูกต้อง' };
  }
  const title = String(payload.title || '').trim();
  if (!title) return { ok: false, message: 'กรุณาระบุชื่อกระดาน' };
  if (title.length > 200) return { ok: false, message: 'ชื่อกระดานยาวเกิน 200 ตัวอักษร' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const boardSheet = ss.getSheetByName('Boards');
    const now = new Date().toISOString();
    const boardId = 'BRD' + Date.now().toString().slice(-6) + Math.floor(10 + Math.random() * 90);
    const categories = normalizeCategories_(payload.categories);

    const rowObj = {
      BoardID: boardId,
      Title: title,
      Description: String(payload.description || '').trim().slice(0, 1000),
      BoardType: normalizeBoardType_(payload.boardType),
      Categories: JSON.stringify(categories),
      Theme: String(payload.theme || 'indigo'),
      Layout: normalizeLayout_(payload.layout),
      AllowPost: payload.allowPost !== false,
      AllowLike: payload.allowLike !== false,
      AllowComment: payload.allowComment !== false,
      RequireApproval: !!payload.requireApproval,
      ShowScore: payload.showScore !== false,
      IsLocked: !!payload.isLocked,
      IsArchived: false,
      Passcode: String(payload.passcode || '').trim(),
      DueDate: String(payload.dueDate || '').trim(),
      CreatedBy: caller.DisplayName || DEFAULT_DEVELOPER_NAME,
      CreatedAt: now,
      UpdatedAt: now
    };

    appendRowSafe_(boardSheet, rowObj);
    logAudit_(ss, caller.Username, 'createBoard', boardId, title);
    SpreadsheetApp.flush();
    invalidateInitCache_();

    return {
      ok: true,
      message: 'สร้างกระดานใหม่เรียบร้อยแล้ว',
      board: formatBoard_(rowObj, { total: 0, approved: 0, pending: 0, checked: 0, revision: 0 }, true)
    };
  } catch (err) {
    Logger.log('[createBoard] ERR ' + (err.stack || err));
    return { ok: false, message: 'ไม่สามารถสร้างกระดานได้: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function updateBoard(caller, boardId, payload) {
  if (!boardId || !payload) return { ok: false, message: 'ข้อมูลไม่ครบถ้วน' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const boardSheet = ss.getSheetByName('Boards');
    const row = readSheet_(boardSheet).find(function (b) { return String(b.BoardID) === String(boardId); });
    if (!row) return { ok: false, message: 'ไม่พบกระดานงาน' };

    const updates = {
      UpdatedAt: new Date().toISOString()
    };
    if (payload.title !== undefined) {
      const t = String(payload.title || '').trim();
      if (!t) return { ok: false, message: 'กรุณาระบุชื่อกระดาน' };
      updates.Title = t.slice(0, 200);
    }
    if (payload.description !== undefined) updates.Description = String(payload.description || '').trim().slice(0, 1000);
    if (payload.boardType !== undefined) updates.BoardType = normalizeBoardType_(payload.boardType);
    if (payload.categories !== undefined) updates.Categories = JSON.stringify(normalizeCategories_(payload.categories));
    if (payload.theme !== undefined) updates.Theme = String(payload.theme || 'indigo');
    if (payload.layout !== undefined) updates.Layout = normalizeLayout_(payload.layout);
    if (payload.allowPost !== undefined) updates.AllowPost = !!payload.allowPost;
    if (payload.allowLike !== undefined) updates.AllowLike = !!payload.allowLike;
    if (payload.allowComment !== undefined) updates.AllowComment = !!payload.allowComment;
    if (payload.requireApproval !== undefined) updates.RequireApproval = !!payload.requireApproval;
    if (payload.showScore !== undefined) updates.ShowScore = !!payload.showScore;
    if (payload.isLocked !== undefined) updates.IsLocked = !!payload.isLocked;
    if (payload.isArchived !== undefined) updates.IsArchived = !!payload.isArchived;
    if (payload.passcode !== undefined) updates.Passcode = String(payload.passcode || '').trim();
    if (payload.dueDate !== undefined) updates.DueDate = String(payload.dueDate || '').trim();

    updateRowByHeaders_(boardSheet, row.__rowIndex, updates);
    logAudit_(ss, caller.Username, 'updateBoard', boardId, updates.Title || row.Title);
    SpreadsheetApp.flush();
    invalidateBoardCache_(boardId);
    invalidateInitCache_();

    const updatedRow = Object.assign({}, row, updates);
    return {
      ok: true,
      message: 'บันทึกการแก้ไขกระดานเรียบร้อยแล้ว',
      board: formatBoard_(updatedRow, null, true)
    };
  } catch (err) {
    Logger.log('[updateBoard] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถแก้ไขกระดานได้: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function deleteBoard(caller, boardId) {
  if (!boardId) return { ok: false, message: 'ไม่พบรหัสกระดาน' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const boardSheet = ss.getSheetByName('Boards');
    const postSheet = ss.getSheetByName('Posts');
    const commentSheet = ss.getSheetByName('Comments');

    const boardRow = readSheet_(boardSheet).find(function (b) { return String(b.BoardID) === String(boardId); });
    if (!boardRow) return { ok: false, message: 'ไม่พบกระดานงาน' };

    // ลบคอมเมนต์ของบอร์ดนี้ (ลบจากแถวล่างขึ้นบน)
    const comments = readSheet_(commentSheet);
    for (let i = comments.length - 1; i >= 0; i--) {
      if (String(comments[i].BoardID) === String(boardId)) {
        commentSheet.deleteRow(comments[i].__rowIndex);
      }
    }

    // ลบโพสต์และย้ายไฟล์แนบลงถังขยะ
    const posts = readSheet_(postSheet);
    for (let i = posts.length - 1; i >= 0; i--) {
      if (String(posts[i].BoardID) === String(boardId)) {
        trashDriveFileQuiet_(posts[i].AttachmentFileId);
        postSheet.deleteRow(posts[i].__rowIndex);
      }
    }

    boardSheet.deleteRow(boardRow.__rowIndex);
    logAudit_(ss, caller.Username, 'deleteBoard', boardId, boardRow.Title);
    SpreadsheetApp.flush();
    invalidateBoardCache_(boardId);
    invalidateInitCache_();

    return { ok: true, message: 'ลบกระดานและข้อมูลทั้งหมดในกระดานเรียบร้อยแล้ว' };
  } catch (err) {
    Logger.log('[deleteBoard] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถลบกระดานได้: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function reviewPost(caller, postId, payload) {
  if (!postId || !payload) return { ok: false, message: 'ข้อมูลไม่ครบถ้วน' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const postSheet = ss.getSheetByName('Posts');
    const row = readSheet_(postSheet).find(function (p) { return String(p.PostID) === String(postId); });
    if (!row) return { ok: false, message: 'ไม่พบโพสต์นี้' };

    const validStatuses = ['approved', 'pending', 'checked', 'needs_revision'];
    const updates = { UpdatedAt: new Date().toISOString() };
    if (payload.status && validStatuses.includes(payload.status)) {
      updates.Status = payload.status;
    }
    if (payload.score !== undefined) {
      updates.Score = String(payload.score || '').trim().slice(0, 50);
    }
    if (payload.teacherFeedback !== undefined) {
      updates.TeacherFeedback = String(payload.teacherFeedback || '').trim().slice(0, 1000);
    }
    if (payload.category !== undefined) {
      updates.Category = String(payload.category || '').trim().slice(0, 100);
    }

    updateRowByHeaders_(postSheet, row.__rowIndex, updates);
    logAudit_(ss, caller.Username, 'reviewPost', postId, JSON.stringify(updates));
    SpreadsheetApp.flush();
    invalidateBoardCache_(String(row.BoardID));
    invalidateInitCache_();

    return { ok: true, message: 'บันทึกผลการตรวจเรียบร้อยแล้ว' };
  } catch (err) {
    Logger.log('[reviewPost] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถบันทึกผลการตรวจได้: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function togglePinPost(caller, postId) {
  if (!postId) return { ok: false, message: 'ไม่พบรหัสโพสต์' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const postSheet = ss.getSheetByName('Posts');
    const row = readSheet_(postSheet).find(function (p) { return String(p.PostID) === String(postId); });
    if (!row) return { ok: false, message: 'ไม่พบโพสต์นี้' };

    const nextPinned = !toBool_(row.Pinned);
    updateRowByHeaders_(postSheet, row.__rowIndex, {
      Pinned: nextPinned,
      UpdatedAt: new Date().toISOString()
    });
    SpreadsheetApp.flush();
    invalidateBoardCache_(String(row.BoardID));
    return { ok: true, pinned: nextPinned, message: nextPinned ? 'ปักหมุดโพสต์แล้ว' : 'ยกเลิกการปักหมุดแล้ว' };
  } catch (err) {
    Logger.log('[togglePinPost] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถเปลี่ยนสถานะปักหมุดได้' };
  } finally {
    lock.releaseLock();
  }
}

function deletePost(caller, postId) {
  if (!postId) return { ok: false, message: 'ไม่พบรหัสโพสต์' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const postSheet = ss.getSheetByName('Posts');
    const commentSheet = ss.getSheetByName('Comments');

    const row = readSheet_(postSheet).find(function (p) { return String(p.PostID) === String(postId); });
    if (!row) return { ok: false, message: 'ไม่พบโพสต์นี้' };

    const comments = readSheet_(commentSheet);
    for (let i = comments.length - 1; i >= 0; i--) {
      if (String(comments[i].PostID) === String(postId)) {
        commentSheet.deleteRow(comments[i].__rowIndex);
      }
    }

    trashDriveFileQuiet_(row.AttachmentFileId);
    postSheet.deleteRow(row.__rowIndex);
    logAudit_(ss, caller.Username, 'deletePost', postId, row.Title);
    SpreadsheetApp.flush();
    invalidateBoardCache_(String(row.BoardID));
    invalidateInitCache_();

    return { ok: true, message: 'ลบโพสต์เรียบร้อยแล้ว' };
  } catch (err) {
    Logger.log('[deletePost] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถลบโพสต์ได้: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function deleteComment(caller, commentId) {
  if (!commentId) return { ok: false, message: 'ไม่พบรหัสความคิดเห็น' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const commentSheet = ss.getSheetByName('Comments');
    const postSheet = ss.getSheetByName('Posts');

    const row = readSheet_(commentSheet).find(function (c) { return String(c.CommentID) === String(commentId); });
    if (!row) return { ok: false, message: 'ไม่พบความคิดเห็นนี้' };

    const postId = String(row.PostID);
    commentSheet.deleteRow(row.__rowIndex);

    // คำนวณจำนวนคอมเมนต์ใหม่ฝั่ง server
    const remainCount = readSheet_(commentSheet).filter(function (c) {
      return String(c.PostID) === postId;
    }).length;
    const postRow = readSheet_(postSheet).find(function (p) { return String(p.PostID) === postId; });
    if (postRow) {
      postSheet.getRange(postRow.__rowIndex, colIndex_(postSheet, 'CommentsCount')).setValue(remainCount);
    }

    SpreadsheetApp.flush();
    invalidateBoardCache_(String(row.BoardID));
    return { ok: true, commentsCount: remainCount, message: 'ลบความคิดเห็นแล้ว' };
  } catch (err) {
    Logger.log('[deleteComment] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถลบความคิดเห็นได้' };
  } finally {
    lock.releaseLock();
  }
}

function updateSystemSettings(caller, payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'ข้อมูลการตั้งค่าไม่ถูกต้อง' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    if (payload.systemName !== undefined) {
      setConfigValue_(ss, 'SYSTEM_NAME', String(payload.systemName || DEFAULT_SYSTEM_NAME).trim().slice(0, 100));
    }
    if (payload.schoolName !== undefined) {
      setConfigValue_(ss, 'SCHOOL_NAME', String(payload.schoolName || '').trim().slice(0, 150));
    }
    if (payload.developerName !== undefined) {
      setConfigValue_(ss, 'DEVELOPER_NAME', String(payload.developerName || DEFAULT_DEVELOPER_NAME).trim().slice(0, 150));
    }

    logAudit_(ss, caller.Username, 'updateSystemSettings', 'Config', JSON.stringify(payload));
    SpreadsheetApp.flush();
    invalidateCache_();

    return {
      ok: true,
      settings: getSystemSettingsMap_(ss),
      message: 'บันทึกการตั้งค่าระบบเรียบร้อยแล้ว'
    };
  } catch (err) {
    Logger.log('[updateSystemSettings] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถบันทึกการตั้งค่าได้: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function changeAdminPassword(caller, currentPassword, newPassword) {
  const cur = String(currentPassword || '');
  const next = String(newPassword || '');
  if (!cur || next.length < 6) {
    return { ok: false, message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, message: 'ระบบกำลังประมวลผล กรุณาลองใหม่' };
  }

  try {
    const ss = getSpreadsheet_();
    const userSheet = ss.getSheetByName('Users');
    const user = readSheet_(userSheet).find(function (u) {
      return String(u.UserID) === String(caller.UserID);
    });
    if (!user) return { ok: false, message: 'ไม่พบบัญชีผู้ใช้' };

    const expected = hashPassword_(cur, String(user.PasswordSalt || ''));
    if (expected !== String(user.PasswordHash || '')) {
      return { ok: false, message: 'รหัสผ่านเดิมไม่ถูกต้อง' };
    }

    const newSalt = generateSalt_();
    const newHash = hashPassword_(next, newSalt);
    updateRowByHeaders_(userSheet, user.__rowIndex, {
      PasswordSalt: newSalt,
      PasswordHash: newHash
    });
    logAudit_(ss, caller.Username, 'changeAdminPassword', caller.UserID, 'Password updated');
    SpreadsheetApp.flush();

    return { ok: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' };
  } catch (err) {
    Logger.log('[changeAdminPassword] ERR ' + err.message);
    return { ok: false, message: 'ไม่สามารถเปลี่ยนรหัสผ่านได้' };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// Drive Direct Resumable Upload & Helpers (Rule drive-ops #1-#7)
// ============================================================

function isAllowedUploadMime_(mime) {
  const m = String(mime || '').toLowerCase();
  const allowedPrefixes = [
    'image/',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.',
    'application/vnd.ms-',
    'text/plain',
    'text/csv',
    'application/zip',
    'application/x-zip-compressed',
    'video/mp4',
    'audio/'
  ];
  return allowedPrefixes.some(function (prefix) {
    return m.indexOf(prefix) === 0;
  });
}

/**
 * ออก Resumable Upload Session URL ของ Google Drive v3 ให้หน้าเว็บ GitHub Pages
 * อัปโหลดไฟล์แบบ Binary ตรงเข้า Google Drive (รองรับสูงสุด 30 MB ไม่ผ่าน Base64/RAM ของ GAS)
 * หมายเหตุ: ไม่ส่ง OAuth Token ออกไปให้ client — ลิงก์ uploadUrl ใช้ได้เฉพาะไฟล์นี้ไฟล์เดียว
 */
function initDirectUpload(caller, payload) {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'ข้อมูลคำขออัปโหลดไม่ถูกต้อง' };
    }

    const boardId = String(payload.boardId || '').trim();
    const rawName = String(payload.name || ('file_' + Date.now())).replace(/[\\/:*?"<>|]/g, '_');
    const mime = String(payload.mime || 'application/octet-stream').trim();
    const size = Number(payload.size || 0);
    const origin = String(payload.origin || '').trim();
    const passcode = String(payload.passcode || '').trim();

    if (!boardId) return { ok: false, message: 'ไม่พบรหัสกระดาน' };
    if (!size || size <= 0) return { ok: false, message: 'ไม่พบขนาดไฟล์ที่ต้องการอัปโหลด' };
    if (size > MAX_UPLOAD_BYTES) {
      return { ok: false, message: 'ขนาดไฟล์เกิน 30 MB กรุณาย่อไฟล์หรือแนบเป็นลิงก์ Google Drive แทน' };
    }
    if (!isAllowedUploadMime_(mime)) {
      return { ok: false, message: 'ไม่รองรับประเภทไฟล์นี้ (' + mime + ')' };
    }

    // ตรวจสิทธิ์กระดานก่อนออก upload session
    const ss = getSpreadsheet_();
    const isAdmin = !!(caller && caller.Role === 'admin');
    const boardRow = readSheet_(ss.getSheetByName('Boards')).find(function (b) {
      return String(b.BoardID) === boardId;
    });
    if (!boardRow) return { ok: false, message: 'ไม่พบกระดานงานที่ต้องการ' };
    if (!isAdmin && (toBool_(boardRow.IsLocked) || toBool_(boardRow.IsArchived) || !toBool_(boardRow.AllowPost))) {
      return { ok: false, message: 'กระดานนี้ปิดรับการส่งงานชั่วคราว' };
    }
    const expectedPass = String(boardRow.Passcode || '').trim();
    if (!isAdmin && expectedPass && passcode !== expectedPass) {
      return { ok: false, code: 'PASSCODE_REQUIRED', message: 'รหัสผ่านกระดานไม่ถูกต้อง' };
    }

    const folder = ensureBoardUploadFolder_(boardId);
    const safeName = Date.now() + '_' + rawName.slice(0, 120);

    const apiUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size';
    const reqHeaders = {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(size)
    };
    // ระบุ Origin เพื่อให้ Google Drive ตอบ CORS headers กลับไปยังหน้าเว็บ GitHub Pages/localhost ได้ถูกต้อง
    if (origin && /^https?:\/\//i.test(origin)) {
      reqHeaders['Origin'] = origin;
    }

    const resp = UrlFetchApp.fetch(apiUrl, {
      method: 'post',
      headers: reqHeaders,
      payload: JSON.stringify({
        name: safeName,
        parents: [folder.getId()]
      }),
      muteHttpExceptions: true
    });

    const status = resp.getResponseCode();
    if (status < 200 || status >= 300) {
      Logger.log('[initDirectUpload] Drive API HTTP ' + status + ' body=' + resp.getContentText());
      return { ok: false, message: 'ไม่สามารถเตรียมช่องทางอัปโหลด Google Drive ได้ (HTTP ' + status + ')' };
    }

    const respHeaders = resp.getAllHeaders();
    let uploadUrl = '';
    Object.keys(respHeaders).forEach(function (k) {
      if (k.toLowerCase() === 'location') {
        uploadUrl = Array.isArray(respHeaders[k]) ? respHeaders[k][0] : respHeaders[k];
      }
    });

    if (!uploadUrl) {
      return { ok: false, message: 'Google Drive ไม่ส่งลิงก์สำหรับอัปโหลดกลับมา' };
    }

    return {
      ok: true,
      uploadUrl: uploadUrl,
      safeName: safeName,
      originalName: rawName
    };
  } catch (err) {
    Logger.log('[initDirectUpload] ERR ' + (err.stack || err));
    return { ok: false, message: 'เริ่มอัปโหลดไม่สำเร็จ: ' + err.message };
  }
}

/**
 * ตรวจสอบไฟล์ที่ client อัปโหลดตรงเข้า Drive เสร็จแล้ว ตั้งสิทธิ์แชร์อย่างปลอดภัย และคำนวณขนาดจริงฝั่ง server
 */
function finalizeDirectUploadFile_(uploadedFile) {
  const fileId = String(uploadedFile.fileId || '').trim();
  if (!fileId) throw new Error('ไม่พบรหัสไฟล์ที่อัปโหลด');

  const file = DriveApp.getFileById(fileId);
  const realSize = Number(file.getSize() || uploadedFile.size || 0);
  if (realSize > MAX_UPLOAD_BYTES) {
    try { file.setTrashed(true); } catch (e) {}
    throw new Error('ไฟล์มีขนาดเกิน 30 MB');
  }

  const mime = String(file.getMimeType() || uploadedFile.mime || 'application/octet-stream');
  const displayName = String(uploadedFile.name || file.getName()).slice(0, 160);
  const viewUrl = 'https://drive.google.com/file/d/' + fileId + '/view';
  let publicShared = false;

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    publicShared = true;
  } catch (shareErr) {
    Logger.log('[finalizeDirectUploadFile_] setSharing skipped (domain policy): ' + shareErr.message);
  }

  const directUrl = (publicShared && mime.indexOf('image/') === 0)
    ? 'https://lh3.googleusercontent.com/d/' + fileId + '=w1000'
    : viewUrl;

  return {
    fileId: fileId,
    name: displayName,
    mime: mime,
    url: directUrl,
    size: realSize
  };
}

function saveAttachmentToDrive_(boardId, attachment) {
  const dataUrl = String(attachment.dataUrl || '');
  const rawName = String(attachment.name || ('file_' + Date.now())).replace(/[\\/:*?"<>|]/g, '_');

  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) {
    throw new Error('รูปแบบไฟล์แนบไม่ถูกต้อง');
  }

  const mime = m[1];
  if (!isAllowedUploadMime_(mime)) {
    throw new Error('ไม่รองรับประเภทไฟล์นี้ (' + mime + ')');
  }

  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > MAX_BASE64_FALLBACK_BYTES) {
    throw new Error('ขนาดไฟล์เกิน 10 MB สำหรับโหมดสำรอง กรุณาใช้การอัปโหลดตรง (Direct Upload)');
  }

  const folder = ensureBoardUploadFolder_(boardId);
  const safeName = Date.now() + '_' + rawName.slice(0, 120);
  const blob = Utilities.newBlob(bytes, mime, safeName);
  const file = folder.createFile(blob);

  let viewUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';
  let publicShared = false;

  // ลองแชร์แบบ ANYONE_WITH_LINK ภายใน try/catch เพื่อไม่ให้พังบนโดเมนโรงเรียนที่บล็อก public share
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    publicShared = true;
  } catch (shareErr) {
    Logger.log('[saveAttachmentToDrive_] setSharing skipped (domain policy): ' + shareErr.message);
  }

  const directUrl = (publicShared && mime.indexOf('image/') === 0)
    ? 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w1000'
    : viewUrl;

  return {
    fileId: file.getId(),
    name: rawName,
    mime: mime,
    url: directUrl,
    size: bytes.length
  };
}

function ensureBoardUploadFolder_(boardId) {
  const ss = getSpreadsheet_();
  const subCfgKey = 'BOARD_FOLDER_' + boardId;
  const cachedSubId = getConfig_(ss, subCfgKey);
  if (cachedSubId) {
    try {
      return DriveApp.getFolderById(cachedSubId);
    } catch (e) {
      Logger.log('[ensureBoardUploadFolder_] cached subfolder missing, recreating: ' + e.message);
    }
  }

  let rootId = getConfig_(ss, 'UPLOADS_FOLDER_ID');
  let rootFolder = null;

  if (rootId) {
    try {
      rootFolder = DriveApp.getFolderById(rootId);
    } catch (e) {
      rootFolder = null;
    }
  }
  if (!rootFolder) {
    rootId = createDriveFolderIfMissing_('KruBoard_Uploads');
    setConfigValue_(ss, 'UPLOADS_FOLDER_ID', rootId);
    rootFolder = DriveApp.getFolderById(rootId);
  }

  const subName = 'Board_' + boardId;
  let subFolder = null;
  try {
    const existing = rootFolder.getFoldersByName(subName);
    if (existing.hasNext()) subFolder = existing.next();
  } catch (e) {
    Logger.log('[ensureBoardUploadFolder_] getFoldersByName skipped (scope): ' + e.message);
  }
  if (!subFolder) {
    subFolder = rootFolder.createFolder(subName);
  }
  setConfigValue_(ss, subCfgKey, subFolder.getId());
  return subFolder;
}

function createDriveFolderIfMissing_(name) {
  try {
    const folders = DriveApp.getFoldersByName(name);
    if (folders.hasNext()) return folders.next().getId();
  } catch (e) {
    // กรณี appsscript.json ใช้ scope drive.file จะเรียก getFoldersByName ไม่ได้ → สร้างโฟลเดอร์ใหม่ตรงๆ ได้เลย
    Logger.log('[createDriveFolderIfMissing_] getFoldersByName skipped (scope), creating directly: ' + e.message);
  }
  return DriveApp.createFolder(name).getId();
}

function trashDriveFileQuiet_(fileId) {
  if (!fileId) return;
  try {
    DriveApp.getFileById(String(fileId)).setTrashed(true);
  } catch (e) {
    Logger.log('[trashDriveFileQuiet_] skip id=' + fileId + ': ' + e.message);
  }
}

// ============================================================
// Spreadsheet & Security Helpers
// ============================================================

function getSpreadsheet_() {
  if (SPREADSHEET_ID) {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('ไม่พบ Google Sheet กรุณารันสคริปต์จาก Google Sheet หรือระบุ SPREADSHEET_ID ใน Code.gs');
  }
  return active;
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else {
    const lastCol = sh.getLastColumn();
    const existing = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    headers.forEach(function (h) {
      if (existing.indexOf(h) === -1) {
        sh.getRange(1, existing.length + 1).setValue(h);
        existing.push(h);
      }
    });
  }
  return sh;
}

function ensureTextColumn_(sheet, headerName) {
  const col = colIndex_(sheet, headerName);
  const rows = Math.max(sheet.getMaxRows(), 500);
  sheet.getRange(1, col, rows, 1).setNumberFormat('@');
}

function readSheet_(sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const o = {};
    let hasAny = false;
    for (let j = 0; j < headers.length; j++) {
      o[headers[j]] = data[i][j];
      if (data[i][j] !== '' && data[i][j] != null) hasAny = true;
    }
    if (!hasAny) continue;
    o.__rowIndex = i + 1;
    rows.push(o);
  }
  return rows;
}

function colIndex_(sheet, headerName) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = headers.indexOf(headerName);
  if (idx < 0) throw new Error('ไม่พบคอลัมน์: ' + headerName);
  return idx + 1;
}

function appendRowSafe_(sheet, obj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = headers.map(function (h) {
    const v = obj[h];
    if (v === null || v === undefined) return '';
    if (TEXT_FIELDS.includes(h) && String(v) !== '') {
      return "'" + String(v);
    }
    return v;
  });
  sheet.appendRow(row);
}

function updateRowByHeaders_(sheet, rowIndex, updates) {
  const lastCol = sheet.getLastColumn();
  if (lastCol <= 0) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const rowRange = sheet.getRange(rowIndex, 1, 1, lastCol);
  const rowVals = rowRange.getValues()[0];

  // ปกป้อง TEXT_FIELDS เดิมไม่ให้โดน auto-parse ตอน batch write ทั้งแถว
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (Object.prototype.hasOwnProperty.call(updates, h)) {
      let val = updates[h];
      if (val === null || val === undefined) val = '';
      if (TEXT_FIELDS.includes(h) && String(val) !== '') {
        val = "'" + String(val);
      }
      rowVals[i] = val;
    } else if (TEXT_FIELDS.includes(h) && rowVals[i] !== '' && rowVals[i] != null) {
      rowVals[i] = "'" + String(rowVals[i]);
    }
  }
  rowRange.setValues([rowVals]);
}

function cacheGetJson_(key) {
  try {
    const raw = CacheService.getScriptCache().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function cachePutJson_(key, obj, ttlSeconds) {
  try {
    const str = JSON.stringify(obj);
    // ScriptCache จำกัด 100 KB ต่อ 1 key
    if (str.length >= 95000) return;
    CacheService.getScriptCache().put(key, str, ttlSeconds || 120);
  } catch (e) {}
}

function invalidateInitCache_() {
  try {
    CacheService.getScriptCache().removeAll([
      'kb_v' + CACHE_VERSION + '_init_pub',
      'kb_v' + CACHE_VERSION + '_init_adm'
    ]);
  } catch (e) {}
}

function invalidateBoardCache_(boardId) {
  if (!boardId) return;
  try {
    CacheService.getScriptCache().removeAll([
      'kb_v' + CACHE_VERSION + '_brd_' + boardId + '_pub',
      'kb_v' + CACHE_VERSION + '_brd_' + boardId + '_adm'
    ]);
  } catch (e) {}
}

function invalidateSessionCache_(token) {
  if (!token) return;
  try {
    CacheService.getScriptCache().remove('kb_v' + CACHE_VERSION + '_sess_' + token);
  } catch (e) {}
}

function getConfig_(ss, key) {
  const cache = CacheService.getScriptCache();
  const ck = 'kb_cfg_' + key;
  const cached = cache.get(ck);
  if (cached !== null) return cached;

  const sh = ss.getSheetByName('Config');
  if (!sh) return '';
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      const val = String(data[i][1] != null ? data[i][1] : '');
      try { cache.put(ck, val, 1800); } catch (e) {}
      return val;
    }
  }
  return '';
}

function setConfigValue_(ss, key, value) {
  const sh = ss.getSheetByName('Config');
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      sh.getRange(i + 1, 2).setValue(value);
      try { CacheService.getScriptCache().put('kb_cfg_' + key, String(value), 1800); } catch (e) {}
      return;
    }
  }
  sh.appendRow([key, value]);
  try { CacheService.getScriptCache().put('kb_cfg_' + key, String(value), 1800); } catch (e) {}
}

function ensureConfigEntry_(ss, key, valueFn) {
  const existing = getConfig_(ss, key);
  if (existing) return existing;
  const val = valueFn();
  setConfigValue_(ss, key, val);
  return val;
}

function getSystemSettingsMap_(ss) {
  const ck = 'kb_v' + CACHE_VERSION + '_settings';
  const cached = cacheGetJson_(ck);
  if (cached) return cached;
  const map = {
    systemName: getConfig_(ss, 'SYSTEM_NAME') || DEFAULT_SYSTEM_NAME,
    schoolName: getConfig_(ss, 'SCHOOL_NAME') || DEFAULT_SCHOOL_NAME,
    developerName: getConfig_(ss, 'DEVELOPER_NAME') || DEFAULT_DEVELOPER_NAME
  };
  cachePutJson_(ck, map, 3600);
  return map;
}

function invalidateCache_() {
  try {
    CacheService.getScriptCache().removeAll([
      'kb_cfg_SYSTEM_NAME',
      'kb_cfg_SCHOOL_NAME',
      'kb_cfg_DEVELOPER_NAME',
      'kb_cfg_UPLOADS_FOLDER_ID',
      'kb_v' + CACHE_VERSION + '_settings',
      'kb_v' + CACHE_VERSION + '_init_pub',
      'kb_v' + CACHE_VERSION + '_init_adm'
    ]);
  } catch (e) {}
}

function getSessionUserOrNull_(token) {
  if (!token) return null;
  const ck = 'kb_v' + CACHE_VERSION + '_sess_' + token;
  const cached = cacheGetJson_(ck);
  if (cached && cached.user && Number(cached.expiresAt) > Date.now()) {
    return cached.user;
  }

  const ss = getSpreadsheet_();
  const sessions = readSheet_(ss.getSheetByName('Sessions'));
  const s = sessions.find(function (r) { return String(r.Token) === String(token); });
  if (!s) return null;
  if (Number(s.ExpiresAt) < Date.now()) return null;

  const users = readSheet_(ss.getSheetByName('Users'));
  const u = users.find(function (r) { return String(r.UserID) === String(s.UserID); });
  if (!u || !toBool_(u.Active)) return null;

  const cleanUser = {
    UserID: String(u.UserID),
    Username: String(u.Username),
    DisplayName: String(u.DisplayName),
    Role: String(u.Role),
    Active: true
  };
  cachePutJson_(ck, { user: cleanUser, expiresAt: Number(s.ExpiresAt) }, 300);
  return cleanUser;
}

function pruneExpiredSessions_(sessionSheet) {
  const now = Date.now();
  const rows = readSheet_(sessionSheet);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (Number(rows[i].ExpiresAt) < now) {
      sessionSheet.deleteRow(rows[i].__rowIndex);
    }
  }
}

function requireRole_(user, allowedRoles) {
  if (!user || !allowedRoles.includes(String(user.Role))) {
    throw new Error('ไม่มีสิทธิ์ในการดำเนินการนี้');
  }
}

function hashPassword_(password, salt) {
  let bytes = Utilities.newBlob(String(password)).getBytes();
  const saltBytes = Utilities.newBlob(String(salt)).getBytes();
  for (let i = 0; i < 1000; i++) {
    bytes = Utilities.computeHmacSha256Signature(bytes, saltBytes);
  }
  return Utilities.base64Encode(bytes);
}

function generateSalt_() {
  return Utilities.getUuid();
}

function logAudit_(ss, actor, action, target, detail) {
  try {
    const sh = ss.getSheetByName('AuditLogs');
    if (!sh) return;
    appendRowSafe_(sh, {
      Timestamp: new Date().toISOString(),
      Actor: String(actor || 'system'),
      Action: String(action || ''),
      Target: String(target || ''),
      Detail: String(detail || '').slice(0, 500)
    });
  } catch (e) {}
}

// ============================================================
// Formatting & Normalization Helpers
// ============================================================

function formatBoard_(b, stats, isAdmin) {
  let categories = [];
  try {
    const parsed = JSON.parse(String(b.Categories || '[]'));
    if (Array.isArray(parsed)) categories = parsed;
  } catch (e) {
    categories = String(b.Categories || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  return {
    boardId: String(b.BoardID || ''),
    title: String(b.Title || ''),
    description: String(b.Description || ''),
    boardType: normalizeBoardType_(b.BoardType),
    categories: categories,
    theme: String(b.Theme || 'indigo'),
    layout: normalizeLayout_(b.Layout),
    allowPost: toBool_(b.AllowPost),
    allowLike: toBool_(b.AllowLike),
    allowComment: toBool_(b.AllowComment),
    requireApproval: toBool_(b.RequireApproval),
    showScore: toBool_(b.ShowScore),
    isLocked: toBool_(b.IsLocked),
    isArchived: toBool_(b.IsArchived),
    hasPasscode: !!String(b.Passcode || '').trim(),
    passcode: isAdmin ? String(b.Passcode || '').trim() : '',
    dueDate: String(b.DueDate || '').trim(),
    createdBy: String(b.CreatedBy || DEFAULT_DEVELOPER_NAME),
    createdAt: toIsoOrEmpty_(b.CreatedAt),
    updatedAt: toIsoOrEmpty_(b.UpdatedAt),
    stats: stats || { total: 0, approved: 0, pending: 0, checked: 0, revision: 0 }
  };
}

function formatPost_(p, comments) {
  const fileId = String(p.AttachmentFileId || '');
  const mime = String(p.AttachmentMime || '');
  return {
    postId: String(p.PostID || ''),
    boardId: String(p.BoardID || ''),
    category: String(p.Category || 'ทั่วไป'),
    title: String(p.Title || ''),
    content: String(p.Content || ''),
    authorName: String(p.AuthorName || ''),
    authorCode: String(p.AuthorCode || ''),
    authorRole: String(p.AuthorRole || 'user'),
    linkUrl: String(p.LinkUrl || ''),
    attachment: fileId ? {
      fileId: fileId,
      name: String(p.AttachmentName || 'ไฟล์แนบ'),
      mime: mime,
      url: String(p.AttachmentUrl || ''),
      viewUrl: 'https://drive.google.com/file/d/' + fileId + '/view',
      downloadUrl: 'https://drive.google.com/uc?export=download&id=' + fileId,
      size: Number(p.AttachmentSize || 0),
      isImage: mime.indexOf('image/') === 0
    } : null,
    cardColor: String(p.CardColor || 'white'),
    pinned: toBool_(p.Pinned),
    status: String(p.Status || 'approved'),
    score: String(p.Score || ''),
    teacherFeedback: String(p.TeacherFeedback || ''),
    likesCount: parseInt(p.LikesCount, 10) || 0,
    commentsCount: comments ? comments.length : (parseInt(p.CommentsCount, 10) || 0),
    comments: comments || [],
    hasEditPin: !!String(p.EditPin || '').trim(),
    createdAt: toIsoOrEmpty_(p.CreatedAt),
    updatedAt: toIsoOrEmpty_(p.UpdatedAt)
  };
}

function sanitizeUser_(u) {
  return {
    userId: String(u.UserID || ''),
    username: String(u.Username || ''),
    displayName: String(u.DisplayName || DEFAULT_DEVELOPER_NAME),
    role: String(u.Role || 'admin')
  };
}

function normalizeCategories_(input) {
  let list = [];
  if (Array.isArray(input)) {
    list = input;
  } else if (typeof input === 'string') {
    list = input.split(/[\n,]+/);
  }
  const clean = [];
  list.forEach(function (item) {
    const s = String(item || '').trim().slice(0, 60);
    if (s && clean.indexOf(s) === -1) clean.push(s);
  });
  return clean.length > 0 ? clean : ['ทั่วไป'];
}

function normalizeBoardType_(t) {
  const valid = ['classroom', 'teacher_doc', 'general'];
  return valid.includes(String(t)) ? String(t) : 'general';
}

function normalizeLayout_(l) {
  const valid = ['masonry', 'columns', 'table'];
  return valid.includes(String(l)) ? String(l) : 'masonry';
}

function toBool_(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

function toIsoOrEmpty_(v) {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  const s = String(v).trim();
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString();
}
