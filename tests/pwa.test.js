import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const read = (path) => readFileSync(join(SRC, path), 'utf8');

// Where the page really lives: a folder under an origin it shares with the
// account's other GitHub Pages sites.
const ORIGIN = 'https://example.github.io';
const SCOPE = `${ORIGIN}/my-AI-harness/`;
const OUR_CACHE = /^my-ai-harness-shell-/;

// Runs the real src/sw.js against a stand-in for the browser's worker
// environment: Cache Storage as maps, and a `fetch` the test controls.
function loadWorker({ fetchImpl = async () => { throw new TypeError('offline'); }, existingCaches = [] } = {}) {
  const listeners = {};
  const storage = new Map(existingCaches.map((name) => [name, new Map()]));
  const abs = (request) => new URL(typeof request === 'string' ? request : request.url, SCOPE).href;
  const withoutSearch = (url) => url.split('?')[0];
  const open = async (name) => {
    if (!storage.has(name)) storage.set(name, new Map());
    const entries = storage.get(name);
    return {
      async addAll(urls) {
        for (const url of urls) entries.set(abs(url), { ok: true, from: 'install', clone() { return this; } });
      },
      async put(request, response) {
        entries.set(abs(request), response);
      },
      async match(request, { ignoreSearch = false } = {}) {
        const key = abs(request);
        if (entries.has(key)) return entries.get(key);
        if (ignoreSearch) for (const [url, response] of entries) if (withoutSearch(url) === withoutSearch(key)) return response;
        return undefined;
      },
    };
  };
  const context = {
    URL,
    self: {
      addEventListener: (type, handler) => { listeners[type] = handler; },
      location: { origin: ORIGIN },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: { open, keys: async () => [...storage.keys()], delete: async (name) => storage.delete(name) },
    fetch: (request) => fetchImpl(request),
  };
  vm.runInNewContext(read('sw.js'), context, { filename: 'sw.js' });

  // Fires an event the way the browser does; resolves to whatever the worker
  // passed to respondWith (undefined when it chose not to handle the request).
  async function dispatch(type, init = {}) {
    let waited;
    let responded;
    listeners[type]({ ...init, waitUntil: (promise) => { waited = promise; }, respondWith: (promise) => { responded = promise; } });
    await waited;
    return responded;
  }
  const get = (path, mode = 'no-cors') => ({ request: { method: 'GET', url: new URL(path, SCOPE).href, mode } });
  return { dispatch, storage, get };
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('everything the page is made of is saved for offline use when the app installs', async () => {
  // The list in sw.js is kept by hand. A new module that is not on it works
  // online and breaks the page offline — the kind of gap nobody notices.
  const worker = loadWorker();
  await worker.dispatch('install');
  const [cacheName] = [...worker.storage.keys()];
  const saved = [...worker.storage.get(cacheName).keys()].map((url) => url.slice(SCOPE.length)).sort();

  const onDisk = filesUnder(SRC)
    .map((path) => relative(SRC, path).split('\\').join('/'))
    .filter((path) => path !== 'sw.js' && !path.endsWith('.DS_Store')) // the worker does not cache itself; the browser keeps it
    .map((path) => (path === 'index.html' ? '' : path)) // the page is saved under the folder URL
    .sort();
  assert.deepEqual(saved, onDisk);
});

test('requests to OpenRouter never pass through the worker, so the key and the conversation are never cached', async () => {
  const worker = loadWorker();
  const chat = await worker.dispatch('fetch', { request: { method: 'POST', url: 'https://openrouter.ai/api/v1/chat/completions', mode: 'cors' } });
  const models = await worker.dispatch('fetch', { request: { method: 'GET', url: 'https://openrouter.ai/api/v1/models', mode: 'cors' } });
  assert.equal(chat, undefined);
  assert.equal(models, undefined);
  assert.equal(worker.storage.size, 0, 'nothing was written to any cache');
});

test('offline, the page and its files open from the saved copy', async () => {
  const worker = loadWorker(); // fetch always fails: no network
  await worker.dispatch('install');

  assert.equal((await worker.dispatch('fetch', worker.get('js/app.js'))).from, 'install');
  // Opening the app from its icon, with or without a query string, and the
  // explicit index.html address, all land on the saved page.
  assert.equal((await worker.dispatch('fetch', worker.get('', 'navigate'))).from, 'install');
  assert.equal((await worker.dispatch('fetch', worker.get('?source=pwa', 'navigate'))).from, 'install');
  assert.equal((await worker.dispatch('fetch', worker.get('index.html', 'navigate'))).from, 'install');
  // Something that was never saved fails the way it would without a worker.
  await assert.rejects(worker.dispatch('fetch', worker.get('js/not-a-file.js')), TypeError);
});

test('online, a new deploy is served at once and becomes the copy used offline', async () => {
  // Network first: an installed app must not keep showing last week's code.
  let online = true;
  const deployed = { ok: true, from: 'deploy-2', clone() { return this; } };
  const worker = loadWorker({
    fetchImpl: async () => {
      if (!online) throw new TypeError('offline');
      return deployed;
    },
  });
  await worker.dispatch('install'); // the saved copy is the older one, from install time

  assert.equal((await worker.dispatch('fetch', worker.get('js/app.js'))).from, 'deploy-2');
  online = false;
  assert.equal((await worker.dispatch('fetch', worker.get('js/app.js'))).from, 'deploy-2');
});

test('a new worker clears its own old caches and leaves the rest of the origin alone', async () => {
  // prorick.github.io and every project site under it share one Cache Storage.
  const worker = loadWorker({ existingCaches: ['my-ai-harness-shell-v0', 'portfolio-site-cache', 'workbox-precache-v2'] });
  await worker.dispatch('install');
  await worker.dispatch('activate');
  const names = [...worker.storage.keys()];
  assert.deepEqual(names.filter((name) => !OUR_CACHE.test(name)).sort(), ['portfolio-site-cache', 'workbox-precache-v2']);
  assert.equal(names.filter((name) => OUR_CACHE.test(name)).length, 1, 'exactly one cache of ours remains');
  assert.ok(!names.includes('my-ai-harness-shell-v0'));
});

test('the manifest describes an installable app whose icons exist at the sizes it claims', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  // Relative, so the app opens at /my-AI-harness/ (and at any fork's path), not at the origin root —
  // which on GitHub Pages is a different site.
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');

  const pngSize = (path) => {
    const bytes = readFileSync(join(SRC, path));
    assert.equal(bytes.toString('latin1', 1, 4), 'PNG', `${path} is a PNG`);
    return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
  };
  for (const icon of manifest.icons.filter((i) => i.type === 'image/png')) assert.equal(pngSize(icon.src), icon.sizes, icon.src);

  // What browsers ask for before they offer to install: a 192 and a 512, plus a maskable one for Android.
  const has = (sizes, purpose) => manifest.icons.some((i) => i.type === 'image/png' && i.sizes === sizes && i.purpose === purpose);
  assert.ok(has('192x192', 'any') && has('512x512', 'any') && has('512x512', 'maskable'));
});

test('the page links the manifest and its security policy lets the manifest and the worker load', () => {
  // The policy starts from "allow nothing"; without these two entries the
  // browser silently drops the manifest and refuses the worker.
  const html = read('index.html');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /connect-src https:\/\/openrouter\.ai;/, 'and the network rule is unchanged: OpenRouter only');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/);
});
