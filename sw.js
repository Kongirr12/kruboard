const CACHE_NAME = 'kruboard-static-v6';
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/config.js',
  './js/api.js',
  './js/app.js',
  './manifest.json',
  './favicon.svg',
  './favicon.ico',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  // ห้าม cache API calls ของ Google Apps Script, Drive หรือ Upload API
  if (
    event.request.method !== 'GET' ||
    url.includes('script.google.com') ||
    url.includes('googleusercontent.com') ||
    url.includes('googleapis.com')
  ) {
    return;
  }

  // Stale-While-Revalidate สำหรับไฟล์หน้าเว็บ (เปิดปุ๊บขึ้นทันที + อัปเดตเบื้องหลัง)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
