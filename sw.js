// Service worker : met en cache uniquement le shell de l'app (aucun texte, aucun son).
// index.html en network-first pour que les mises à jour arrivent ; le reste en cache-first,
// versionné : changer VERSION (ici et dans js/version.js) renouvelle tout le cache.
const VERSION = '1.0.0';
const CACHE = 'transcription-' + VERSION;
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/ui.js',
  'js/supervisor.js',
  'js/storage.js',
  'js/export.js',
  'js/wakelock.js',
  'js/mock.js',
  'js/version.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'media/veille.mp4',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('transcription-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/')) {
    // network-first, repli sur le cache si le wifi de l'amphi est mauvais (timeout 4 s)
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await Promise.race([
          fetch(req, { cache: 'no-store' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
        ]);
        if (res.ok) cache.put('index.html', res.clone());
        return res;
      } catch {
        return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
