// sw.js — service worker: guarda os ficheiros da app para funcionar offline.
// Nunca toca nos dados do cofre (esses vivem no IndexedDB, já cifrados).
//
// Ao publicar uma nova versão da app, aumenta o número em CACHE.

const CACHE = 'lockmaster-v1';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'vault.js',
  'storage.js',
  'icons.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Responde logo com o que está em cache e atualiza em segundo plano
// (a versão nova fica ativa na abertura seguinte).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return (await network) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
    }),
  );
});
