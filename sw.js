// Minimal shell cache so the app opens instantly and still opens with no
// signal. It never caches data from Apps Script, only the app's own files.
const CACHE = 'ducks-shell-v9';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './app/styles.css', './app/main.js', './app/store.js', './app/sync.js',
  './app/rank.js', './app/quack.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './icons/duck-glyph.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // never intercept Apps Script calls
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
