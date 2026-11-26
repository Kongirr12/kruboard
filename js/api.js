/**
 * ครูบอร์ด (KruBoard) — API Client & Demo Adapter
 * รองรับการเชื่อมต่อ Google Apps Script (POST text/plain ไม่ติด CORS preflight)
 * และโหมดทดลองใช้งานในเบราว์เซอร์ (Demo Mode) เมื่อยังไม่ได้ตั้งค่า GAS_API_URL
 * พัฒนาโดย: ครูก้องนที อุ่นเจริญ
 */
(function (global) {
  'use strict';

  const STORAGE_KEYS = {
    TOKEN: 'kruboard_admin_token',
    GAS_OVERRIDE: 'kruboard_gas_url_override',
    DEMO_DB: 'kruboard_demo_db_v1'
  };

  function getActiveGasUrl() {
    const override = (localStorage.getItem(STORAGE_KEYS.GAS_OVERRIDE) || '').trim();
    if (override) return override;
    return ((global.KRUBOARD_CONFIG && global.KRUBOARD_CONFIG.GAS_API_URL) || '').trim();
  }

  function isDemoMode() {
    return !getActiveGasUrl();
  }

  function setGasUrlOverride(url) {
    const clean = String(url || '').trim();
    if (clean) {
      localStorage.setItem(STORAGE_KEYS.GAS_OVERRIDE, clean);
    } else {
      localStorage.removeItem(STORAGE_KEYS.GAS_OVERRIDE);
    }
    // ล้าง token เดิมเมื่อสลับปลายทาง API
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
  }

  function getSessionToken() {
    return localStorage.getItem(STORAGE_KEYS.TOKEN) || '';
  }

  function setSessionToken(token) {
    if (token) {
      localStorage.setItem(STORAGE_KEYS.TOKEN, token);
    } else {
      localStorage.removeItem(STORAGE_KEYS.TOKEN);
    }
  }

  // ============================================================
  // Live Google Apps Script RPC (text/plain avoids CORS preflight)
  // ============================================================

  async function callLiveRpc(fn, args) {
    const url = getActiveGasUrl();
    const token = getSessionToken();
    const t0 = Date.now();
    console.log('→ RPC', fn, { demo: false, argCount: args.length });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ fn, args, token }),
        redirect: 'follow'
      });

      if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      }

      const text = await res.text();
      if (!text || text.trim().startsWith('<')) {
        throw new Error(
          'ปลายทาง GAS คืนค่าเป็นหน้าเว็บ HTML แทน JSON — กรุณาตรวจสอบว่า Deploy แบบ Execute as: Me และ Who has access: Anyone และใช้ลิงก์ลงท้าย /exec'
        );
      }

      const data = JSON.parse(text);
      console.log('← RPC', fn, (Date.now() - t0) + 'ms', { ok: data.ok });
      if (data && data.code === 'UNAUTHORIZED') {
        setSessionToken('');
      }
      return data;
    } catch (err) {
      console.error('✗ RPC', fn, err);
      return {
        ok: false,
        message: 'เชื่อมต่อ Google Apps Script ไม่สำเร็จ: ' + (err.message || err)
      };
    }
  }

  async function testGasConnection(url) {
    const clean = String(url || '').trim();
    if (!clean) return { ok: true, mode: 'demo', message: 'สลับกลับเป็นโหมดทดลองใช้งานแล้ว' };
    try {
      const res = await fetch(clean, { method: 'GET', redirect: 'follow' });
      const text = await res.text();
      if (!text || text.trim().startsWith('<')) {
        return {
          ok: false,
          message: 'เชื่อมต่อได้แต่ GAS ส่ง HTML กลับมา กรุณาตั้งค่า Deploy เป็น Execute as: Me และ Who has access: Anyone'
        };
      }
      const data = JSON.parse(text);
      if (data && data.ok) {
        return { ok: true, mode: 'live', message: 'เชื่อมต่อ ' + (data.service || 'KruBoard API') + ' สำเร็จ!' };
      }
      return { ok: false, message: (data && data.message) || 'ปลายทางไม่ตอบสนองตามรูปแบบ API' };
    } catch (err) {
      return { ok: false, message: 'ไม่สามารถเชื่อมต่อ URL นี้ได้: ' + (err.message || err) };
    }
  }

  // ============================================================
  // Image Compression & File Reader Utilities
  // ============================================================

  function compressImageDataUrl(dataUrl, maxWidth, quality) {
    const maxW = maxWidth || (global.KRUBOARD_CONFIG && global.KRUBOARD_CONFIG.MAX_IMAGE_WIDTH) || 1400;
    const q = quality || (global.KRUBOARD_CONFIG && global.KRUBOARD_CONFIG.IMAGE_QUALITY) || 0.85;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(maxW / img.width, 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', q));
      };
      img.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพได้'));
      img.src = dataUrl;
    });
  }

  function dataUrlToBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const mimeMatch = parts[0].match(/:([^;]+);/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const binary = atob(parts[1]);
    const len = binary.length;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = binary.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์ที่เลือกได้'));
      reader.readAsDataURL(file);
    });
  }

  async function prepareAttachment(file) {
    const maxBytes = (global.KRUBOARD_CONFIG && global.KRUBOARD_CONFIG.MAX_FILE_BYTES) || (30 * 1024 * 1024);
    if (!file) return null;

    const isImage = !!(file.type && file.type.startsWith('image/'));

    if (isImage && file.type !== 'image/gif') {
      const rawDataUrl = await readFileAsDataUrl(file);
      const compressed = await compressImageDataUrl(rawDataUrl);
      const blob = dataUrlToBlob(compressed);
      if (blob.size > maxBytes) {
        throw new Error('รูปภาพยังมีขนาดใหญ่เกิน 30 MB กรุณาเลือกรูปขนาดเล็กลง');
      }
      const baseName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      return {
        name: baseName,
        mime: 'image/jpeg',
        size: blob.size,
        isImage: true,
        blob: blob,
        previewUrl: compressed
      };
    }

    if (file.size > maxBytes) {
      throw new Error('ขนาดไฟล์เกิน 30 MB กรุณาย่อไฟล์หรือแนบเป็นลิงก์ Google Drive แทน');
    }

    const previewUrl = isImage ? await readFileAsDataUrl(file) : '';
    return {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      isImage: isImage,
      blob: file,
      previewUrl: previewUrl
    };
  }

  function putBinaryWithProgress(uploadUrl, blob, mime, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl, true);
      xhr.setRequestHeader('Content-Type', mime || 'application/octet-stream');

      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable && typeof onProgress === 'function') {
          const pct = Math.min(99, Math.round((evt.loaded / evt.total) * 100));
          onProgress(pct, evt.loaded, evt.total);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const parsed = JSON.parse(xhr.responseText || '{}');
            if (!parsed.id) {
              reject(new Error('Google Drive ไม่ส่งรหัสไฟล์กลับมา'));
              return;
            }
            if (typeof onProgress === 'function') onProgress(100, blob.size, blob.size);
            resolve(parsed);
          } catch (e) {
            reject(new Error('ไม่สามารถอ่านผลลัพธ์จาก Google Drive ได้'));
          }
        } else {
          reject(new Error('Google Drive ตอบกลับสถานะ HTTP ' + xhr.status));
        }
      };

      xhr.onerror = () => reject(new Error('เชื่อมต่อ Google Drive เพื่อส่งไฟล์ไม่สำเร็จ (เครือข่ายหรือ CORS)'));
      xhr.ontimeout = () => reject(new Error('หมดเวลาในการอัปโหลดไฟล์ กรุณาลองใหม่'));
      xhr.send(blob);
    });
  }

  /**
   * อัปโหลดไฟล์แนบ:
   * - Live Mode: ขอ Resumable Upload URL จาก GAS แล้วส่ง Binary ตรงเข้า Google Drive พร้อม Progress Bar
   *   (หากเครือข่ายบล็อก Direct PUT และไฟล์ <= 10 MB จะสลับไปใช้ Base64 fallback ให้อัตโนมัติ)
   * - Demo Mode: จำลอง Progress Bar และเก็บใน localStorage
   */
  async function uploadAttachment(boardId, preparedFile, passcode, onProgress) {
    if (!preparedFile) return { ok: true, mode: 'none' };

    const report = (pct, text) => {
      if (typeof onProgress === 'function') onProgress(pct, text);
    };

    if (isDemoMode()) {
      report(25, 'กำลังจำลองการอัปโหลด (โหมดทดลองใช้)...');
      await new Promise((r) => setTimeout(r, 180));
      report(75, 'กำลังบันทึกไฟล์ตัวอย่าง...');
      let dataUrl = preparedFile.previewUrl || '';
      if (!dataUrl && preparedFile.size <= 3 * 1024 * 1024 && preparedFile.blob) {
        dataUrl = await readFileAsDataUrl(preparedFile.blob);
      }
      await new Promise((r) => setTimeout(r, 180));
      report(100, 'อัปโหลดเสร็จสิ้น (โหมดทดลองใช้)');
      return {
        ok: true,
        mode: 'demo',
        attachment: {
          name: preparedFile.name,
          mime: preparedFile.mime,
          size: preparedFile.size,
          isImage: preparedFile.isImage,
          dataUrl: dataUrl || 'data:text/plain;base64,RGVtbw=='
        }
      };
    }

    report(5, 'กำลังเตรียมช่องทางอัปโหลดตรงเข้า Google Drive...');
    const initRes = await callLiveRpc('initDirectUpload', [{
      boardId: boardId,
      name: preparedFile.name,
      mime: preparedFile.mime,
      size: preparedFile.size,
      origin: global.location.origin,
      passcode: passcode || ''
    }]);

    if (initRes && initRes.ok && initRes.uploadUrl) {
      try {
        report(10, 'กำลังอัปโหลดไฟล์ตรงเข้า Google Drive...');
        const driveFile = await putBinaryWithProgress(
          initRes.uploadUrl,
          preparedFile.blob,
          preparedFile.mime,
          (pct) => report(Math.max(10, pct), 'กำลังอัปโหลดไฟล์เข้า Google Drive...')
        );
        return {
          ok: true,
          mode: 'direct',
          uploadedFile: {
            fileId: driveFile.id,
            name: preparedFile.name,
            mime: driveFile.mimeType || preparedFile.mime,
            size: Number(driveFile.size || preparedFile.size)
          }
        };
      } catch (directErr) {
        console.warn('Direct Drive upload failed, checking fallback:', directErr);
        const fallbackMax = (global.KRUBOARD_CONFIG && global.KRUBOARD_CONFIG.FALLBACK_BASE64_MAX_BYTES) || (10 * 1024 * 1024);
        if (preparedFile.size <= fallbackMax) {
          report(45, 'สลับไปใช้วิธีอัปโหลดสำรองผ่าน Apps Script...');
          const dataUrl = preparedFile.previewUrl || await readFileAsDataUrl(preparedFile.blob);
          return {
            ok: true,
            mode: 'base64_fallback',
            attachment: {
              name: preparedFile.name,
              mime: preparedFile.mime,
              size: preparedFile.size,
              isImage: preparedFile.isImage,
              dataUrl: dataUrl
            }
          };
        }
        return {
          ok: false,
          message: 'อัปโหลดไฟล์ขนาดใหญ่ตรงเข้า Google Drive ไม่สำเร็จ: ' + directErr.message
        };
      }
    }

    // กรณี initDirectUpload ไม่สำเร็จ (เช่น ยังไม่ได้อัปเดต Code.gs เวอร์ชันใหม่) ลอง fallback ถ้าไฟล์ <= 10 MB
    const fallbackMax = (global.KRUBOARD_CONFIG && global.KRUBOARD_CONFIG.FALLBACK_BASE64_MAX_BYTES) || (10 * 1024 * 1024);
    if (preparedFile.size <= fallbackMax && (!initRes || initRes.code !== 'PASSCODE_REQUIRED')) {
      report(40, 'กำลังอัปโหลดผ่าน Apps Script...');
      const dataUrl = preparedFile.previewUrl || await readFileAsDataUrl(preparedFile.blob);
      return {
        ok: true,
        mode: 'base64_fallback',
        attachment: {
          name: preparedFile.name,
          mime: preparedFile.mime,
          size: preparedFile.size,
          isImage: preparedFile.isImage,
          dataUrl: dataUrl
        }
      };
    }

    return {
      ok: false,
      message: (initRes && initRes.message) || 'ไม่สามารถเริ่มอัปโหลดไฟล์เข้า Google Drive ได้'
    };
  }

  // ============================================================
  // Demo Mode LocalStorage Adapter (100% feature parity)
  // ============================================================

  function createSeedDemoDb() {
    const cfg = global.KRUBOARD_CONFIG || {};
    const now = Date.now();
    const iso = (offsetMins) => new Date(now - offsetMins * 60000).toISOString();

    return {
      settings: {
        systemName: cfg.SYSTEM_NAME || 'ครูบอร์ด',
        schoolName: cfg.SCHOOL_NAME || 'กระดานส่งงานออนไลน์',
        developerName: cfg.DEVELOPER_NAME || 'ครูก้องนที อุ่นเจริญ'
      },
      adminPassword: 'admin1234',
      boards: [
        {
          boardId: 'BRD_DEMO_01',
          title: 'ส่งงานโครงงานวิทยาการคำนวณ ม.2',
          description: 'ให้นักเรียนโพสต์สรุปไอเดียโครงงาน แนบภาพต้นแบบหรือลิงก์ Canva พร้อมระบุชื่อ-เลขที่ให้ชัดเจน',
          boardType: 'classroom',
          categories: ['ม.2/1', 'ม.2/2', 'ม.2/3'],
          theme: 'indigo',
          layout: 'masonry',
          allowPost: true,
          allowLike: true,
          allowComment: true,
          requireApproval: false,
          showScore: true,
          isLocked: false,
          isArchived: false,
          passcode: '',
          dueDate: '2026-12-15',
          createdBy: cfg.DEVELOPER_NAME || 'ครูก้องนที อุ่นเจริญ',
          createdAt: iso(1800),
          updatedAt: iso(45)
        },
        {
          boardId: 'BRD_DEMO_02',
          title: 'กระดานส่งแผนการจัดการเรียนรู้และเอกสารครู',
          description: 'ช่องทางส่งแผนการสอน รายงานวิจัยในชั้นเรียน และเอกสารประจำภาคเรียน แยกตามกลุ่มสาระการเรียนรู้',
          boardType: 'teacher_doc',
          categories: ['กลุ่มสาระคณิตศาสตร์', 'กลุ่มสาระวิทยาศาสตร์ฯ', 'กลุ่มสาระภาษาไทย', 'ฝ่ายบริหารวิชาการ'],
          theme: 'emerald',
          layout: 'columns',
          allowPost: true,
          allowLike: true,
          allowComment: true,
          requireApproval: false,
          showScore: true,
          isLocked: false,
          isArchived: false,
          passcode: '',
          dueDate: '2026-12-20',
          createdBy: cfg.DEVELOPER_NAME || 'ครูก้องนที อุ่นเจริญ',
          createdAt: iso(2400),
          updatedAt: iso(20)
        }
      ],
      posts: [
        {
          postId: 'PST_DEMO_01',
          boardId: 'BRD_DEMO_01',
          category: 'ม.2/1',
          title: 'โครงงานถังขยะอัจฉริยะแยกประเภทด้วยเซนเซอร์',
          content: 'ออกแบบวงจรเบื้องต้นด้วยบอร์ด KidBright ร่วมกับเซนเซอร์วัดระยะทาง เพื่อเปิดฝาถังอัตโนมัติและนับจำนวนขวดพลาสติกครับ',
          authorName: 'ด.ช.ธนกฤต รักเรียน',
          authorCode: 'เลขที่ 05',
          authorRole: 'user',
          linkUrl: 'https://www.canva.com/',
          attachment: null,
          cardColor: 'blue',
          pinned: true,
          status: 'checked',
          score: '10/10',
          teacherFeedback: 'แนวคิดดีมากและแก้ปัญหาในโรงเรียนได้จริง เตรียมทดลองประกอบวงจรในคาบหน้าได้เลยครับ',
          likesCount: 8,
          createdAt: iso(120),
          updatedAt: iso(60)
        },
        {
          postId: 'PST_DEMO_02',
          boardId: 'BRD_DEMO_01',
          category: 'ม.2/2',
          title: 'อินโฟกราฟิกเรื่องความปลอดภัยทางไซเบอร์',
          content: 'สรุป 5 วิธีตั้งรหัสผ่านให้ปลอดภัยและวิธีสังเกตลิงก์ฟิชชิ่งสำหรับเพื่อน ๆ ในโรงเรียนค่ะ',
          authorName: 'ด.ญ.พิมพ์ชนก ใจดี',
          authorCode: 'เลขที่ 14',
          authorRole: 'user',
          linkUrl: '',
          attachment: null,
          cardColor: 'yellow',
          pinned: false,
          status: 'approved',
          score: '',
          teacherFeedback: '',
          likesCount: 5,
          createdAt: iso(45),
          updatedAt: iso(45)
        },
        {
          postId: 'PST_DEMO_03',
          boardId: 'BRD_DEMO_02',
          category: 'กลุ่มสาระวิทยาศาสตร์ฯ',
          title: 'แผนการจัดการเรียนรู้ หน่วยที่ 3 ระบบนิเวศ (5E)',
          content: 'ส่งแผนการจัดการเรียนรู้เชิงรุก Active Learning รูปแบบ 5E พร้อมใบกิจกรรมและเกณฑ์การประเมิน K-P-A ครบชุดครับ',
          authorName: 'ครูก้องนที อุ่นเจริญ',
          authorCode: 'T001',
          authorRole: 'admin',
          linkUrl: 'https://docs.google.com/',
          attachment: null,
          cardColor: 'mint',
          pinned: true,
          status: 'checked',
          score: 'ผ่านการตรวจ',
          teacherFeedback: 'องค์ประกอบแผนครบถ้วน สอดคล้องกับตัวชี้วัดและ วPA',
          likesCount: 6,
          createdAt: iso(90),
          updatedAt: iso(30)
        },
        {
          postId: 'PST_DEMO_04',
          boardId: 'BRD_DEMO_02',
          category: 'กลุ่มสาระคณิตศาสตร์',
          title: 'แบบสรุปรายงานโครงการค่ายคณิตศาสตร์',
          content: 'ส่งเอกสารสรุปผลโครงการและภาพประกอบกิจกรรม เพื่อรวบรวมจัดทำรายงาน SAR ประจำปีการศึกษา',
          authorName: 'ครูศิริพร ชำนาญเลข',
          authorCode: 'T012',
          authorRole: 'user',
          linkUrl: '',
          attachment: null,
          cardColor: 'white',
          pinned: false,
          status: 'approved',
          score: '',
          teacherFeedback: '',
          likesCount: 3,
          createdAt: iso(20),
          updatedAt: iso(20)
        }
      ],
      comments: [
        {
          commentId: 'CMT_DEMO_01',
          postId: 'PST_DEMO_01',
          boardId: 'BRD_DEMO_01',
          authorName: 'ครูก้องนที อุ่นเจริญ',
          authorRole: 'admin',
          body: 'ยอดเยี่ยมมากครับ อย่าลืมบันทึกภาพขั้นตอนการประกอบมาอัปเดตเพิ่มในสัปดาห์หน้านะครับ',
          createdAt: iso(55)
        }
      ]
    };
  }

  function loadDemoDb() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.DEMO_DB);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    const seed = createSeedDemoDb();
    saveDemoDb(seed);
    return seed;
  }

  function saveDemoDb(db) {
    try {
      localStorage.setItem(STORAGE_KEYS.DEMO_DB, JSON.stringify(db));
    } catch (e) {
      throw new Error('พื้นที่จัดเก็บชั่วคราวในเบราว์เซอร์เต็ม (โหมดทดลองใช้) กรุณาเชื่อม Google Apps Script เพื่อเก็บไฟล์ลง Google Drive');
    }
  }

  function resetDemoDb() {
    const seed = createSeedDemoDb();
    saveDemoDb(seed);
    setSessionToken('');
    return seed;
  }

  function demoAdminUser(db) {
    const token = getSessionToken();
    if (token !== 'demo-admin-token') return null;
    return {
      userId: 'USR001',
      username: 'admin',
      displayName: (db.settings && db.settings.developerName) || 'ครูก้องนที อุ่นเจริญ',
      role: 'admin'
    };
  }

  function computeBoardStats(posts, boardId) {
    const list = posts.filter((p) => p.boardId === boardId);
    return {
      total: list.length,
      approved: list.filter((p) => p.status === 'approved').length,
      pending: list.filter((p) => p.status === 'pending').length,
      checked: list.filter((p) => p.status === 'checked').length,
      revision: list.filter((p) => p.status === 'needs_revision').length
    };
  }

  async function callDemoRpc(fn, args) {
    console.log('→ RPC [DEMO]', fn, args);
    const db = loadDemoDb();
    const user = demoAdminUser(db);
    const isAdmin = !!user;

    const requireAdmin = () => {
      if (!isAdmin) return { ok: false, code: 'UNAUTHORIZED', message: 'กรุณาเข้าสู่ระบบครูผู้ดูแลก่อนดำเนินการ' };
      return null;
    };

    try {
      switch (fn) {
        case 'getPublicInit': {
          const boards = db.boards
            .filter((b) => isAdmin || !b.isArchived)
            .map((b) => ({
              ...b,
              hasPasscode: !!b.passcode,
              passcode: isAdmin ? b.passcode : '',
              stats: computeBoardStats(db.posts, b.boardId)
            }))
            .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));

          const visiblePosts = isAdmin ? db.posts : db.posts.filter((p) => p.status !== 'pending');
          return {
            ok: true,
            settings: db.settings,
            user: user,
            stats: {
              totalBoards: boards.length,
              totalPosts: visiblePosts.length,
              pendingPosts: db.posts.filter((p) => p.status === 'pending').length,
              checkedPosts: db.posts.filter((p) => p.status === 'checked').length
            },
            boards: boards
          };
        }

        case 'getBoardDetail': {
          const [boardId, passcode] = args;
          const b = db.boards.find((x) => x.boardId === boardId);
          if (!b) return { ok: false, message: 'ไม่พบกระดานงานที่ต้องการ' };
          if (!isAdmin && b.passcode && String(passcode || '') !== String(b.passcode)) {
            return { ok: false, code: 'PASSCODE_REQUIRED', boardTitle: b.title, message: 'กรุณากรอกรหัสผ่านเพื่อเข้ากระดานนี้' };
          }
          const posts = db.posts
            .filter((p) => p.boardId === boardId && (isAdmin || p.status !== 'pending'))
            .map((p) => {
              const pComments = db.comments.filter((c) => c.postId === p.postId);
              return { ...p, comments: pComments, commentsCount: pComments.length };
            })
            .sort((a, b2) => {
              if (a.pinned !== b2.pinned) return a.pinned ? -1 : 1;
              return String(b2.createdAt).localeCompare(String(a.createdAt));
            });

          return {
            ok: true,
            board: {
              ...b,
              hasPasscode: !!b.passcode,
              passcode: isAdmin ? b.passcode : '',
              stats: computeBoardStats(db.posts, b.boardId)
            },
            posts: posts
          };
        }

        case 'createPost': {
          const [payload] = args;
          const b = db.boards.find((x) => x.boardId === payload.boardId);
          if (!b) return { ok: false, message: 'ไม่พบกระดานงาน' };
          if (!isAdmin && (b.isLocked || !b.allowPost)) return { ok: false, message: 'กระดานนี้ปิดรับการส่งงานชั่วคราว' };
          const now = new Date().toISOString();
          const needApproval = !isAdmin && b.requireApproval;
          const att = payload.attachment && payload.attachment.dataUrl
            ? {
                fileId: 'DEMO_FILE_' + Date.now(),
                name: payload.attachment.name,
                mime: payload.attachment.mime,
                url: payload.attachment.dataUrl,
                viewUrl: payload.attachment.dataUrl,
                downloadUrl: payload.attachment.dataUrl,
                size: payload.attachment.size || 0,
                isImage: !!payload.attachment.isImage
              }
            : null;

          const newPost = {
            postId: 'PST' + Date.now(),
            boardId: payload.boardId,
            category: payload.category || 'ทั่วไป',
            title: payload.title,
            content: payload.content || '',
            authorName: payload.authorName,
            authorCode: payload.authorCode || '',
            authorRole: isAdmin ? 'admin' : 'user',
            linkUrl: payload.linkUrl || '',
            attachment: att,
            cardColor: payload.cardColor || 'white',
            pinned: false,
            status: needApproval ? 'pending' : 'approved',
            score: '',
            teacherFeedback: '',
            likesCount: 0,
            commentsCount: 0,
            comments: [],
            createdAt: now,
            updatedAt: now
          };

          db.posts.unshift(newPost);
          b.updatedAt = now;
          saveDemoDb(db);
          return {
            ok: true,
            pendingApproval: needApproval,
            message: needApproval
              ? 'ส่งงานเรียบร้อยแล้ว งานของคุณจะแสดงเมื่อครูอนุมัติ'
              : 'ส่งงานขึ้นกระดานเรียบร้อยแล้ว (โหมดทดลองใช้)',
            post: newPost
          };
        }

        case 'toggleLike': {
          const [postId, delta] = args;
          const p = db.posts.find((x) => x.postId === postId);
          if (!p) return { ok: false, message: 'ไม่พบโพสต์' };
          p.likesCount = Math.max(0, (p.likesCount || 0) + (Number(delta) < 0 ? -1 : 1));
          saveDemoDb(db);
          return { ok: true, postId, likesCount: p.likesCount };
        }

        case 'addComment': {
          const [payload] = args;
          const p = db.posts.find((x) => x.postId === payload.postId);
          if (!p) return { ok: false, message: 'ไม่พบโพสต์' };
          const cmt = {
            commentId: 'CMT' + Date.now(),
            postId: p.postId,
            boardId: p.boardId,
            authorName: payload.authorName || (user ? user.displayName : 'ผู้ใช้งาน'),
            authorRole: isAdmin ? 'admin' : 'user',
            body: payload.body,
            createdAt: new Date().toISOString()
          };
          db.comments.push(cmt);
          const count = db.comments.filter((c) => c.postId === p.postId).length;
          saveDemoDb(db);
          return { ok: true, comment: cmt, commentsCount: count };
        }

        case 'login': {
          const [username, password] = args;
          if (String(username).trim().toLowerCase() === 'admin' && String(password) === db.adminPassword) {
            setSessionToken('demo-admin-token');
            return {
              ok: true,
              token: 'demo-admin-token',
              user: demoAdminUser(db),
              message: 'เข้าสู่ระบบครูผู้ดูแลสำเร็จ (โหมดทดลองใช้)'
            };
          }
          return { ok: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง (โหมดทดลอง: admin / admin1234)' };
        }

        case 'logout': {
          setSessionToken('');
          return { ok: true, message: 'ออกจากระบบแล้ว' };
        }

        case 'createBoard': {
          const err = requireAdmin(); if (err) return err;
          const [payload] = args;
          const now = new Date().toISOString();
          const cats = Array.isArray(payload.categories)
            ? payload.categories
            : String(payload.categories || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
          const board = {
            boardId: 'BRD' + Date.now().toString().slice(-6),
            title: payload.title,
            description: payload.description || '',
            boardType: payload.boardType || 'general',
            categories: cats.length ? cats : ['ทั่วไป'],
            theme: payload.theme || 'indigo',
            layout: payload.layout || 'masonry',
            allowPost: payload.allowPost !== false,
            allowLike: payload.allowLike !== false,
            allowComment: payload.allowComment !== false,
            requireApproval: !!payload.requireApproval,
            showScore: payload.showScore !== false,
            isLocked: !!payload.isLocked,
            isArchived: false,
            passcode: String(payload.passcode || '').trim(),
            dueDate: payload.dueDate || '',
            createdBy: user.displayName,
            createdAt: now,
            updatedAt: now
          };
          db.boards.unshift(board);
          saveDemoDb(db);
          return { ok: true, board, message: 'สร้างกระดานใหม่เรียบร้อยแล้ว' };
        }

        case 'updateBoard': {
          const err = requireAdmin(); if (err) return err;
          const [boardId, payload] = args;
          const b = db.boards.find((x) => x.boardId === boardId);
          if (!b) return { ok: false, message: 'ไม่พบกระดานงาน' };
          const cats = Array.isArray(payload.categories)
            ? payload.categories
            : String(payload.categories || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
          Object.assign(b, {
            title: payload.title || b.title,
            description: payload.description !== undefined ? payload.description : b.description,
            boardType: payload.boardType || b.boardType,
            categories: cats.length ? cats : ['ทั่วไป'],
            theme: payload.theme || b.theme,
            layout: payload.layout || b.layout,
            allowPost: !!payload.allowPost,
            allowLike: !!payload.allowLike,
            allowComment: !!payload.allowComment,
            requireApproval: !!payload.requireApproval,
            showScore: !!payload.showScore,
            isLocked: !!payload.isLocked,
            passcode: String(payload.passcode || '').trim(),
            dueDate: payload.dueDate || '',
            updatedAt: new Date().toISOString()
          });
          saveDemoDb(db);
          return { ok: true, board: b, message: 'บันทึกการแก้ไขกระดานเรียบร้อยแล้ว' };
        }

        case 'deleteBoard': {
          const err = requireAdmin(); if (err) return err;
          const [boardId] = args;
          db.boards = db.boards.filter((b) => b.boardId !== boardId);
          db.posts = db.posts.filter((p) => p.boardId !== boardId);
          db.comments = db.comments.filter((c) => c.boardId !== boardId);
          saveDemoDb(db);
          return { ok: true, message: 'ลบกระดานเรียบร้อยแล้ว' };
        }

        case 'reviewPost': {
          const err = requireAdmin(); if (err) return err;
          const [postId, payload] = args;
          const p = db.posts.find((x) => x.postId === postId);
          if (!p) return { ok: false, message: 'ไม่พบโพสต์' };
          if (payload.status) p.status = payload.status;
          if (payload.score !== undefined) p.score = payload.score;
          if (payload.teacherFeedback !== undefined) p.teacherFeedback = payload.teacherFeedback;
          p.updatedAt = new Date().toISOString();
          saveDemoDb(db);
          return { ok: true, message: 'บันทึกผลการตรวจเรียบร้อยแล้ว' };
        }

        case 'togglePinPost': {
          const err = requireAdmin(); if (err) return err;
          const [postId] = args;
          const p = db.posts.find((x) => x.postId === postId);
          if (!p) return { ok: false, message: 'ไม่พบโพสต์' };
          p.pinned = !p.pinned;
          saveDemoDb(db);
          return { ok: true, pinned: p.pinned, message: p.pinned ? 'ปักหมุดโพสต์แล้ว' : 'ยกเลิกการปักหมุดแล้ว' };
        }

        case 'deletePost': {
          const err = requireAdmin(); if (err) return err;
          const [postId] = args;
          db.posts = db.posts.filter((p) => p.postId !== postId);
          db.comments = db.comments.filter((c) => c.postId !== postId);
          saveDemoDb(db);
          return { ok: true, message: 'ลบโพสต์เรียบร้อยแล้ว' };
        }

        case 'deleteComment': {
          const err = requireAdmin(); if (err) return err;
          const [commentId] = args;
          db.comments = db.comments.filter((c) => c.commentId !== commentId);
          saveDemoDb(db);
          return { ok: true, message: 'ลบความคิดเห็นแล้ว' };
        }

        case 'updateSystemSettings': {
          const err = requireAdmin(); if (err) return err;
          const [payload] = args;
          db.settings = {
            systemName: payload.systemName || db.settings.systemName,
            schoolName: payload.schoolName !== undefined ? payload.schoolName : db.settings.schoolName,
            developerName: payload.developerName || db.settings.developerName
          };
          saveDemoDb(db);
          return { ok: true, settings: db.settings, message: 'บันทึกการตั้งค่าระบบเรียบร้อยแล้ว' };
        }

        case 'changeAdminPassword': {
          const err = requireAdmin(); if (err) return err;
          const [cur, next] = args;
          if (cur !== db.adminPassword) return { ok: false, message: 'รหัสผ่านเดิมไม่ถูกต้อง' };
          db.adminPassword = next;
          saveDemoDb(db);
          return { ok: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' };
        }

        default:
          return { ok: false, message: 'ไม่รองรับคำสั่ง: ' + fn };
      }
    } catch (e) {
      return { ok: false, message: e.message || 'เกิดข้อผิดพลาดในโหมดทดลองใช้' };
    }
  }

  async function rpc(fn, ...args) {
    if (isDemoMode()) {
      return callDemoRpc(fn, args);
    }
    return callLiveRpc(fn, args);
  }

  global.KruBoardAPI = {
    rpc,
    isDemoMode,
    getActiveGasUrl,
    setGasUrlOverride,
    getSessionToken,
    setSessionToken,
    testGasConnection,
    prepareAttachment,
    uploadAttachment,
    resetDemoDb
  };
})(window);
