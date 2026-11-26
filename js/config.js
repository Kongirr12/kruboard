/**
 * การตั้งค่าหลักของระบบ ครูบอร์ด (KruBoard)
 * พัฒนาโดย: ครูก้องนที อุ่นเจริญ
 *
 * วิธีเชื่อมต่อ Google Sheet + Drive จริง:
 * 1. นำโค้ดในโฟลเดอร์ gas/Code.gs ไปวางใน Google Apps Script ของ Google Sheet
 * 2. กดรัน setupSystem() 1 ครั้ง แล้ว Deploy เป็น Web App (Execute as: Me, Access: Anyone)
 * 3. นำ URL ที่ลงท้ายด้วย /exec มาใส่ในค่า GAS_API_URL ด้านล่าง แล้ว push ขึ้น GitHub Pages
 */
window.KRUBOARD_CONFIG = {
  // วางลิงก์ Google Apps Script Web App URL ที่นี่ (เช่น 'https://script.google.com/macros/s/AKfycb.../exec')
  // หากปล่อยว่างไว้ ระบบจะทำงานใน "โหมดทดลองใช้ (Demo Mode)" ด้วยข้อมูลตัวอย่างในเบราว์เซอร์
  GAS_API_URL: 'https://script.google.com/macros/s/AKfycby2yK690e8Yq2OvOTuZPr0JVu8UlIeHTg8evi70qyDJ_6aYFbDcUI25hytivgjXhLJPSg/exec',

  // ข้อมูลเริ่มต้นของระบบ (สามารถแก้เพิ่มในเมนูตั้งค่าหลังเชื่อมต่อ Sheet ได้)
  SYSTEM_NAME: 'ครูบอร์ด',
  SCHOOL_NAME: 'กระดานส่งงานออนไลน์',
  DEVELOPER_NAME: 'ครูก้องนที อุ่นเจริญ',

  // การบีบอัดรูปภาพและขนาดไฟล์สูงสุดก่อนส่งตรงเข้า Google Drive
  MAX_IMAGE_WIDTH: 1400,
  IMAGE_QUALITY: 0.85,
  MAX_FILE_BYTES: 30 * 1024 * 1024, // 30 MB (Direct Upload ตรงเข้า Google Drive)
  FALLBACK_BASE64_MAX_BYTES: 10 * 1024 * 1024 // 10 MB สำหรับโหมดสำรองผ่าน GAS
};
