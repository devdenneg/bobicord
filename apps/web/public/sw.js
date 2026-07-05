// Минимальный service worker: обеспечивает installability PWA.
// Никакого кэширования — приложение реального времени, всегда свежая версия с сервера.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* passthrough — сеть напрямую */ });
