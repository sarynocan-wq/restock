// Keeps the app itself available with a weak signal in the store.
// Data calls to Supabase are never cached here; the app keeps its own saved copy.
const CACHE = 'restock-v2';   // bump this when you change files, to push the update out
const SHELL = ['./', './index.html', './app.css', './app.js', './db.js', './config.js', './scanner.js', './lookup.js', './vendor/zxing.min.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.hostname.endsWith('supabase.co')) return;
  if (u.origin !== location.origin && u.hostname !== 'cdn.jsdelivr.net') return;
  // Network first, fall back to cache when offline
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html'))));
});
