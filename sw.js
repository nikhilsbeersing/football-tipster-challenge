// Minimal service worker: makes the site installable and always prefers the
// freshest files, so when you update index.html the change shows up straight away.
const CACHE = 'ftc-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;   // Supabase, CDNs etc. go straight to the network

  event.respondWith((async () => {
    try {
      const res = await fetch(req, req.mode === 'navigate' ? { cache: 'no-cache' } : undefined);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      const hit = (await caches.match(req)) || (req.mode === 'navigate' ? await caches.match('./') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
