// 2026-11-12-probe-model-list.mjs — one-off diagnosis (Keel 5.2).
//
// Context: in 2026-11-12-drive-chat-flow.mjs every check passed except "the
// model picker fills from OpenRouter's live list". Two suspects: (a) the page's
// real request to openrouter.ai/api/v1/models fails in the browser (CSP? CORS?),
// or (b) a scripted element.focus() does not fire `focus` in a headless page
// that does not have window focus, so the fetch never starts. This asks the
// page itself, in real headless Chrome, with no fetch stand-in.
//
// Use (repo root served on :8765):  node scripts/ephemeral/2026-11-12-probe-model-list.mjs <profile-dir>
//
// OUTCOME: see the end of this file.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const outDir = process.argv[2];
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(outDir, 'chrome-probe')}`, 'about:blank'], { stdio: 'ignore' });

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
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    else if (msg.method === 'Log.entryAdded') console.log('  log:', msg.params.entry.level, msg.params.entry.text);
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, (msg) => resolve(msg.result ?? msg.error));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const js = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? `THREW: ${r.exceptionDetails.exception?.description}` : r.result.value;
  };

  await cdp('Page.enable');
  await cdp('Log.enable');
  await cdp('Page.navigate', { url: 'http://127.0.0.1:8765/src/index.html' });
  await sleep(1500);

  console.log('document.hasFocus():', await js(`document.hasFocus()`));
  console.log('direct fetch from the page:', await js(`fetch('https://openrouter.ai/api/v1/models').then(r => r.json()).then(b => b.data.length + ' models', e => 'FAILED: ' + e)`));

  await js(`document.getElementById('model').focus()`);
  await sleep(4000);
  console.log('after element.focus(): activeElement =', await js(`document.activeElement.id`), '· options =', await js(`document.querySelectorAll('#model-list option').length`));

  await js(`document.getElementById('model').dispatchEvent(new FocusEvent('focus'))`);
  await sleep(4000);
  console.log('after a dispatched focus event: options =', await js(`document.querySelectorAll('#model-list option').length`));
  ws.close();
} finally {
  chrome.kill();
}

// OUTCOME (2026-11-12):
//   document.hasFocus(): false
//   direct fetch from the page: 475 models
//   after element.focus(): activeElement = model · options = 0
//   after a dispatched focus event: options = 475
// Suspect (b). The page's request to OpenRouter works under the CSP; the
// headless page simply never held focus, so `focus` never fired. No change to
// the page; the driver now dispatches the event itself.
