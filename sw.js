// Shell cache so the app can still open with no signal. It never caches
// data from Apps Script, only the app's own files.
//
// Revised 2026-09-30: this used to be cache-first (check cache, only hit
// the network if nothing was cached), which meant a freshly deployed
// version could sit unused indefinitely on a device that already had an
// older one cached, well past any reasonable expectation that "closing
// and reopening the app" would pick it up. Network-first fixes that: with
// a connection, it always tries the real, current files first, and the
// cache is purely an offline fallback, not something that can go stale
// and quietly keep serving.
const CACHE = 'ducks-shell-v26';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './app/styles.css', './app/main.js', './app/store.js', './app/sync.js',
  './app/rank.js', './app/quack.js', './app/recurrence.js',
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
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
