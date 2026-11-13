// Service worker for the chat page (ADR-0003). It does one job: let the page
// open when there is no network, so saved conversations can still be read.
//
// Strategy: network first, cache as the fallback. Online, every file comes
// from the network exactly as it would without a worker — a deploy is live on
// the next load and there is nothing to version by hand. Offline, the last
// copy that was fetched is served instead.
//
// It only ever answers GET requests for this site's own files, inside its own
// folder. Requests to OpenRouter never pass through it: they carry the API key
// and the conversation, and neither belongs in a cache.

const CACHE = 'my-ai-harness-shell-v1';
// GitHub Pages serves every project site of an account from one origin, and
// Cache Storage is shared per origin — so only caches with this prefix are
// ever ours to delete.
const CACHE_PREFIX = 'my-ai-harness-shell-';

// Everything the page needs to open. tests/pwa.test.js fails if a file in
// src/ is missing from this list, or if the list names a file that is gone.
const SHELL = [
  './',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/store.js',
  'js/openrouter.js',
  'js/markdown.js',
  'js/render.js',
  'js/thinking.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = (await cache.match(request, { ignoreSearch: true })) ?? (request.mode === 'navigate' ? await cache.match('./') : undefined);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
