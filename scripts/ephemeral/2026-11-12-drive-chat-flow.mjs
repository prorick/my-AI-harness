// 2026-11-12-drive-chat-flow.mjs — one-off end-to-end check of the chat page (Keel 5.2).
//
// Context: the unit tests cover the stream parser, the store and the markdown
// reader, but nothing exercised the page itself: type → send → reply streams
// in → saved → reload. No OpenRouter key was available, so this drives a real
// headless Chrome over the DevTools protocol and swaps `fetch` for a stand-in
// that answers the chat-completions URL with a scripted event stream. Only the
// network is faked; the DOM, the CSP, the modules and localStorage are real.
//
// Use (from the repo root, with `python3 -m http.server 8765` running there):
//   node scripts/ephemeral/2026-11-12-drive-chat-flow.mjs <dir-for-profile-and-screenshots>
//
// No dependencies: Node 22+ has fetch and WebSocket built in.
//
// OUTCOME (2026-11-12, Chrome headless, Node 24): see the comment block at the
// end of this file.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node 2026-11-12-drive-chat-flow.mjs <output-dir>');
mkdirSync(outDir, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const APP = 'http://127.0.0.1:8765/src/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the page before any of its scripts. Answers by what the last user
// message says, so each scenario below picks its own behaviour.
const FAKE_FETCH = `(() => {
  const real = window.fetch.bind(window);
  window.__requests = [];
  window.fetch = async (url, init = {}) => {
    if (!String(url).includes('/chat/completions')) return real(url, init);
    const body = JSON.parse(init.body);
    window.__requests.push({ url: String(url), auth: init.headers.Authorization, body });
    const last = body.messages[body.messages.length - 1].content;
    if (last.includes('fail')) {
      return new Response(JSON.stringify({ error: { code: 401, message: 'No auth credentials found' } }), { status: 401 });
    }
    const slow = last.includes('slow');
    const pieces = slow
      ? Array.from({ length: 200 }, (_, i) => 'word' + i + ' ')
      : ['Here is ', 'a **bold** ', 'claim and a list:\\n\\n', '- one\\n', '- two\\n\\n', '\`\`\`js\\nconst x = 1;\\n', '\`\`\`\\n\\nDone <b>not html</b>.'];
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const onAbort = () => controller.error(new DOMException('Aborted', 'AbortError'));
        init.signal?.addEventListener('abort', onAbort);
        try {
          for (const p of pieces) {
            if (init.signal?.aborted) return;
            controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\\n\\n'));
            await new Promise((r) => setTimeout(r, slow ? 40 : 30));
          }
          controller.enqueue(enc.encode('data: [DONE]\\n\\n'));
          controller.close();
        } catch {}
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
})();`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(outDir, 'chrome-drive')}`, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('Chrome did not come up');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    } else if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) {
      problems.push(`${msg.params.entry.level}: ${msg.params.entry.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const js = async (expression) => {
    const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(expression)) return true;
      await sleep(50);
    }
    return false;
  };
  const shot = async (name) => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
  };
  const say = (text) =>
    js(`(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('composer').requestSubmit(); })()`);
  const saved = () => js(`JSON.parse(localStorage.getItem('my-ai-harness:v1'))`);

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_FETCH });

  // --- first visit: no key -------------------------------------------------
  await cdp('Page.navigate', { url: APP });
  await until(`document.querySelector('.empty') !== null`);
  await js(`localStorage.clear()`);
  await cdp('Page.reload');
  await until(`document.querySelector('.empty') !== null`);
  check('first visit shows the add-key prompt', await js(`document.querySelector('.empty .btn')?.textContent === 'Add key'`));
  await say('hello before a key');
  check('sending without a key opens Settings and keeps the draft', await js(`document.getElementById('settings').open && document.getElementById('input').value === 'hello before a key'`));
  check('…and sends nothing', (await js(`window.__requests.length`)) === 0);

  // --- save a key through the dialog --------------------------------------
  await js(`(() => { document.getElementById('api-key').value = '  sk-or-drive-test  '; document.getElementById('settings-form').requestSubmit(); })()`);
  check('saving the key closes Settings and stores it trimmed', (await saved()).settings.apiKey === 'sk-or-drive-test' && !(await js(`document.getElementById('settings').open`)));

  // --- a normal exchange ----------------------------------------------------
  await say('Explain something\nover two lines');
  check('while streaming, the button is Stop', await until(`document.getElementById('send').classList.contains('busy')`, 2000));
  await until(`!document.getElementById('send').classList.contains('busy')`);
  const req = (await js(`window.__requests`))[0];
  check('the request carried the key and the conversation', req.auth === 'Bearer sk-or-drive-test' && req.body.stream === true && req.body.messages.at(-1).content === 'Explain something\nover two lines', JSON.stringify(req.body.messages));
  check('the reply rendered as markdown: bold, list, code block', await js(`!!document.querySelector('.msg.assistant strong') && document.querySelectorAll('.msg.assistant li').length === 2 && document.querySelector('.msg.assistant pre code')?.textContent === 'const x = 1;'`));
  check('HTML in the reply is shown as text, not turned into an element', await js(`document.querySelector('.msg.assistant .prose b') === null && document.querySelector('.msg.assistant .prose').textContent.includes('<b>not html</b>')`));
  let s = await saved();
  check('the exchange is saved, titled from the first message', s.conversations.length === 1 && s.conversations[0].title === 'Explain something over two lines' && s.conversations[0].messages.length === 2 && s.conversations[0].messages[1].content.endsWith('Done <b>not html</b>.'));
  check('the sidebar lists it as the open conversation', await js(`document.querySelector('.conv.active .conv-open')?.textContent === 'Explain something over two lines'`));
  await shot('drive-1-exchange.png');

  // --- stop mid-reply -------------------------------------------------------
  await say('slow please');
  await until(`(document.querySelectorAll('.msg.assistant .prose')[1]?.textContent ?? '').includes('word5 ')`);
  await shot('drive-2-streaming.png');
  await js(`document.getElementById('composer').requestSubmit()`); // the Stop button
  await until(`!document.getElementById('send').classList.contains('busy')`, 3000);
  s = await saved();
  const partial = s.conversations[0].messages.at(-1);
  check('Stop ends the reply and keeps the part that arrived', partial.role === 'assistant' && partial.content.startsWith('word0 word1') && !partial.content.includes('word199') && !partial.error, `${partial.content.length} chars kept`);

  // --- a failed reply, then retry -------------------------------------------
  await say('this one will fail');
  await until(`document.querySelector('.msg-error') !== null`);
  check('a rejected key shows a plain-language error with Retry', await js(`/API key/.test(document.querySelector('.msg-error span').textContent) && document.querySelector('.msg-error [data-action=retry]') !== null`), await js(`document.querySelector('.msg-error span').textContent`));
  await shot('drive-3-error.png');
  const before = await js(`window.__requests.length`);
  await js(`document.querySelector('.msg-error [data-action=retry]').click()`);
  await until(`window.__requests.length === ${before + 1}`, 3000);
  await until(`!document.getElementById('send').classList.contains('busy')`);
  s = await saved();
  check('Retry re-sends the same turn without piling up failed replies', s.conversations[0].messages.filter((m) => m.error).length === 1 && s.conversations[0].messages.length === 6, `${s.conversations[0].messages.length} messages`);

  // --- reload ---------------------------------------------------------------
  await cdp('Page.reload');
  await until(`document.querySelectorAll('.msg').length > 0`);
  check('after a reload the conversation is back on screen', (await js(`document.querySelectorAll('.msg').length`)) === 6 && (await js(`document.getElementById('chat-title').textContent`)) === 'Explain something over two lines');

  // --- new chat, then delete -------------------------------------------------
  await js(`document.getElementById('new-chat').click()`);
  check('New chat shows a blank page and keeps the old conversation in the list', await js(`document.querySelector('.empty') !== null && document.querySelectorAll('.conv').length === 1`));
  await say('A second conversation');
  await until(`!document.getElementById('send').classList.contains('busy') && document.querySelectorAll('.conv').length === 2`);
  await js(`window.confirm = () => true; document.querySelector('.conv.active .conv-del').click()`);
  s = await saved();
  check('deleting the open conversation falls back to the other one', s.conversations.length === 1 && s.activeId === s.conversations[0].id && (await js(`document.getElementById('chat-title').textContent`)) === 'Explain something over two lines');

  // --- the model list (real network: OpenRouter's public endpoint) -----------
  // A scripted .focus() fires no `focus` event here: a headless page does not
  // hold window focus (see 2026-11-12-probe-model-list.mjs). Dispatch it.
  await js(`document.getElementById('model').dispatchEvent(new FocusEvent('focus'))`);
  const gotModels = await until(`document.querySelectorAll('#model-list option').length > 50`, 15000);
  check('the model picker fills from OpenRouter’s live list (real request, through the CSP)', gotModels, `${await js(`document.querySelectorAll('#model-list option').length`)} models`);

  check('no script errors, CSP violations or console errors during the run', problems.length === 0, problems.join(' | '));
  ws.close();
} finally {
  chrome.kill();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

// OUTCOME (2026-11-12):
// - First run: 17/18. The one failure was this driver, not the page — the
//   model-list check called element.focus(), which fires no `focus` event in a
//   headless page (diagnosed with 2026-11-12-probe-model-list.mjs). Fixed here
//   by dispatching the event.
// - Second run, and a third after streamChat() was changed to yield typed
//   events: 18/18. No script errors and no CSP violations.
// - Decision it supported: the first version was committed and deployed
//   (ADR-0001, Iteration 2). It also showed the page works under its own CSP,
//   including the real request to OpenRouter's model list.
// - What it does NOT show: a real chat completion. The reply stream is a
//   stand-in; no API key was available.
// - Follow-up recorded in docs/TECHNICAL-DEBT.md ("The gate does not open a
//   browser"): promote this to a real test.
