const CACHE_NAME = 'moneytracker-v8.2';
const ASSETS = [
  './',
  './index.html',
  './shared.css',
  './expenses.css',
  './expenses.js',
  './db.js',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => {
        if (key !== CACHE_NAME) return caches.delete(key);
      })
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Only cache GET requests — POST/PUT/etc. are unsupported by Cache API
  if (e.request.method !== 'GET') return;

  // Do not cache API requests to Firebase
  if (e.request.url.includes('firebaseio.com')) {
    return; // Pass through to network fetch
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      // Return cached version or fetch from network and cache
      return cached || fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
        return res;
      });
    })
  );
});
