const CACHE_NAME = 'cosmo-notes-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Pre-cache the shell — don't abort install if this fails
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add('/'))
      .catch(() => {})
  );
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
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if (url.hostname.includes('turso.io')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match('/').then((c) => c || caches.match(event.request)))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => new Response('', { status: 503, statusText: 'Offline' }));
    })
  );
});
