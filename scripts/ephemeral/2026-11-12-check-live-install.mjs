// 2026-11-12-check-live-install.mjs — one-off check of the DEPLOYED page (Keel 5.2).
//
// Context: the PWA (ADR-0003) was checked locally, where the page is served
// from /src/ on localhost. The real thing lives in a sub-folder of a shared
// GitHub Pages origin, over HTTPS — a different scope, different headers. This
// asks real headless Chrome, pointed at the live URL, three questions: does
// the service worker take control, does Chrome see manifest or installability
// errors, and which URLs does the manifest resolve to. Read-only: it loads the
// page and inspects it; it sends no messages and stores no key.
//
// Use:  node scripts/ephemeral/2026-11-12-check-live-install.mjs <url> <fresh-profile-dir>
//
// OUTCOME: see the end of this file.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) throw new Error('usage: node 2026-11-12-check-live-install.mjs <url> <fresh-profile-dir>');
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(outDir, 'chrome-live-install')}`, 'about:blank'], { stdio: 'ignore' });

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let nextId = 1;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(msg.params.entry.text);
    else if (msg.method === 'Runtime.exceptionThrown') problems.push(msg.params.exceptionDetails.text);
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, (msg) => resolve(msg.result ?? msg.error));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const js = async (expression) => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Page.navigate', { url });
  let controlled = false;
  for (let i = 0; i < 100 && !controlled; i++) {
    await sleep(150);
    controlled = await js(`navigator.serviceWorker?.controller != null`);
  }
  console.log('service worker controls the page:', controlled);
  console.log('worker scope:', await js(`navigator.serviceWorker.getRegistration().then((r) => r?.scope)`));
  console.log('worker script:', await js(`navigator.serviceWorker.controller?.scriptURL`));
  const manifest = await cdp('Page.getAppManifest');
  console.log('manifest url:', manifest.url, '· errors:', JSON.stringify(manifest.errors));
  const parsed = JSON.parse(manifest.data);
  console.log('start_url resolves to:', new URL(parsed.start_url, manifest.url).href, '· scope:', new URL(parsed.scope, manifest.url).href);
  console.log('installability errors:', JSON.stringify((await cdp('Page.getInstallabilityErrors')).installabilityErrors));
  console.log('offline files saved:', await js(`caches.keys().then(async (keys) => { const out = {}; for (const k of keys) out[k] = (await (await caches.open(k)).keys()).length; return JSON.stringify(out); })`));
  console.log('page errors:', JSON.stringify(problems));
  ws.close();
} finally {
  chrome.kill();
}

// OUTCOME (2026-11-12, against https://prorick.github.io/my-AI-harness/ after
// the deploy of fbaa806):
//   service worker controls the page: true
//   worker scope:  …/my-AI-harness/          (the project folder, not the origin root)
//   manifest errors: []   installability errors: []
//   start_url and scope both resolve to …/my-AI-harness/
//   offline files saved: {"my-ai-harness-shell-v1":14}
//   page errors: []
// So the deployed page is installable as far as Chrome can tell, and the
// worker is confined to this project's folder. Recorded in ADR-0003 under
// Verification. Still not done: a real install by a person.
