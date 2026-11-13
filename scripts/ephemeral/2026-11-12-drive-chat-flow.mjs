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
const SITE_PORT = 8766;
const APP = `http://127.0.0.1:${SITE_PORT}/src/index.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Since the PWA work (ADR-0003) the driver runs its own web server, so that it
// can take the server away and check the page still opens offline. Run it from
// the repo root; no separate `python3 -m http.server` is needed any more.
const server = spawn('python3', ['-m', 'http.server', String(SITE_PORT), '--bind', '127.0.0.1'], { stdio: 'ignore' });
const serverGone = new Promise((resolve) => server.on('exit', resolve));

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
    // "flaky": the first try is accepted (200) and then rate-limited by the
    // provider inside the stream, after a little thinking — the shape of the
    // failure prorick hit on the live page. The second try answers normally.
    if (last.includes('flaky')) {
      window.__flaky = (window.__flaky || 0) + 1;
      if (window.__flaky === 1) {
        const line = (obj) => 'data: ' + JSON.stringify(obj) + '\\n\\n';
        const body = line({ model: 'fake/limited-1', choices: [{ delta: { reasoning: 'Starting to think' } }] })
          + line({ model: 'fake/limited-1', error: { code: 429, message: 'fake/limited-1 is temporarily rate-limited upstream. Please retry shortly.' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
      }
    }
    const slow = last.includes('slow');
    const pieces = slow
      ? Array.from({ length: 200 }, (_, i) => 'word' + i + ' ')
      : ['Here is ', 'a **bold** ', 'claim and a list:\\n\\n', '- one\\n', '- two\\n\\n', '\`\`\`js\\nconst x = 1;\\n', '\`\`\`\\n\\nDone <b>not html</b>.'];
    // "think": a reasoning model behind a router — thoughts first (sent both
    // ways, as OpenRouter does), then the answer, every chunk naming the model
    // that actually served it (ADR-0002).
    const think = last.includes('think');
    const chunks = think
      ? [
          ...['**Adding the numbers**\\n\\n', 'Five plus five ', 'is ten.'].map((t) => ({ model: 'fake/thinker-1', choices: [{ delta: { reasoning: t, reasoning_details: [{ type: 'reasoning.text', text: t }] } }] })),
          { model: 'fake/thinker-1', choices: [{ delta: { content: '5 + 5 = 10.' } }] },
        ]
      : pieces.map((p) => ({ choices: [{ delta: { content: p } }] }));
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const onAbort = () => controller.error(new DOMException('Aborted', 'AbortError'));
        init.signal?.addEventListener('abort', onAbort);
        try {
          for (const chunk of chunks) {
            if (init.signal?.aborted) return;
            controller.enqueue(enc.encode('data: ' + JSON.stringify(chunk) + '\\n\\n'));
            await new Promise((r) => setTimeout(r, think ? 400 : slow ? 40 : 30));
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

  // --- thinking (ADR-0002) ----------------------------------------------------
  const lastReply = `[...document.querySelectorAll('.msg.assistant')].at(-1)`;
  const notBusy = `!document.getElementById('send').classList.contains('busy')`;

  // --- automatic retry (ADR-0004) ----------------------------------------------
  await js(`document.getElementById('new-chat').click()`);
  const beforeRetry = await js(`window.__requests.length`);
  await say('a flaky question');
  check(
    'a rate-limited reply shows a “trying again” note, not an error, and drops the failed try’s thinking',
    await until(`(document.querySelector('.retry-note')?.textContent ?? '').includes('attempt 2 of 4') && document.querySelector('.msg-error') === null && document.querySelector('.thinking') === null`, 3000),
    await js(`document.querySelector('.retry-note')?.textContent`),
  );
  await shot('drive-retry-note.png');
  await until(notBusy, 15000);
  s = await saved();
  const retried = s.conversations.find((c) => c.id === s.activeId).messages.at(-1);
  check(
    '…then the answer arrives by itself, on the second request, with nothing kept from the failed one',
    retried.content.endsWith('Done <b>not html</b>.') && !retried.error && !retried.reasoning && retried.model === 'openrouter/auto' && (await js(`window.__requests.length`)) === beforeRetry + 2 && (await js(`document.querySelector('.retry-note') === null && document.querySelector('.msg-error') === null`)),
    JSON.stringify({ model: retried.model, requests: (await js(`window.__requests.length`)) - beforeRetry }),
  );

  await js(`document.getElementById('new-chat').click()`);
  await say('think about 5 + 5');
  check('while the model thinks, a “Thinking…” row shows above the waiting dots', await until(`document.querySelector('.thinking .thinking-label')?.textContent === 'Thinking…' && document.querySelector('.msg.assistant .typing') !== null`, 3000));
  await shot('drive-4-thinking.png');
  await until(notBusy);
  check(
    'once the answer starts, the row reads “Thought for…” with a one-line gist, collapsed',
    await js(`(() => { const d = document.querySelector('.thinking'); return /^Thought (briefly|for \\d+s)$/.test(d.querySelector('.thinking-label').textContent) && d.querySelector('.thinking-gist').textContent === 'Adding the numbers' && !d.open; })()`),
    await js(`document.querySelector('.thinking summary').textContent`),
  );
  check('the request asked the model to think', JSON.stringify(await js(`window.__requests.at(-1).body.reasoning`)) === '{"enabled":true}');
  await shot('drive-5-thought-collapsed.png');
  await js(`document.querySelector('.thinking summary').click()`);
  check('opening the row shows the thinking in full', await until(`document.querySelector('.thinking').open && document.querySelector('.thinking-body').textContent.includes('Five plus five is ten.')`, 2000));
  await shot('drive-6-thought-open.png');
  s = await saved();
  const thought = s.conversations.find((c) => c.id === s.activeId).messages.at(-1);
  check('the thinking, its duration and the model that answered are saved with the reply', thought.reasoning === '**Adding the numbers**\n\nFive plus five is ten.' && thought.thinkingMs > 0 && thought.model === 'fake/thinker-1' && thought.content === '5 + 5 = 10.', JSON.stringify({ ms: thought.thinkingMs, model: thought.model }));
  check('…and the reply names the model that answered, not the router', await js(`${lastReply}.querySelector('.msg-meta').textContent.includes('fake/thinker-1')`));

  await say('and a plain one');
  await until(`${notBusy} && document.querySelectorAll('.msg.assistant').length === 2`);
  check('a reply whose model shared no thinking says so, with no empty row', await js(`${lastReply}.querySelector('.thinking') === null && ${lastReply}.querySelector('.msg-meta').textContent.includes('no thinking shared')`));
  check('a row the reader opened stays open when the page re-renders', await js(`document.querySelector('.thinking').open && document.querySelector('.thinking-body').textContent.includes('Five plus five is ten.')`));
  check('the follow-up did not send the earlier thinking back to the model', await js(`window.__requests.at(-1).body.messages.every((m) => Object.keys(m).sort().join() === 'content,role')`));

  // The switch sits by the message box, on by default (QST-THINKING-DEFAULT = C).
  check('the Think switch starts on', await js(`document.getElementById('think').getAttribute('aria-pressed') === 'true'`));
  await js(`document.getElementById('think').click()`);
  check('clicking it turns it off and the choice is saved', (await js(`document.getElementById('think').getAttribute('aria-pressed')`)) === 'false' && (await saved()).settings.thinking === false);
  await say('think once more');
  await until(`${notBusy} && document.querySelectorAll('.msg.assistant').length === 3`);
  check('switched off, the request no longer asks for thinking', await js(`!('reasoning' in window.__requests.at(-1).body)`));
  check('…but thinking a model shares anyway is still shown', await js(`${lastReply}.querySelector('.thinking') !== null && !${lastReply}.querySelector('.msg-meta').textContent.includes('no thinking shared')`));

  await cdp('Page.reload');
  await until(`document.querySelectorAll('.msg').length > 0`);
  check('after a reload both thinking rows are back, collapsed', await js(`document.querySelectorAll('.thinking').length === 2 && [...document.querySelectorAll('.thinking')].every((d) => !d.open)`));
  check('…and the Think switch is still off, as it was left', await js(`document.getElementById('think').getAttribute('aria-pressed') === 'false'`));

  // --- installable app (ADR-0003) ---------------------------------------------
  check('the service worker is active and controls the page', await until(`navigator.serviceWorker.controller !== null`, 10000));
  const manifest = await cdp('Page.getAppManifest');
  check('Chrome reads the manifest without errors', manifest.errors.length === 0 && manifest.url.endsWith('manifest.webmanifest'), JSON.stringify(manifest.errors));
  const installability = await cdp('Page.getInstallabilityErrors');
  check('Chrome finds nothing that would stop the page being installed', installability.installabilityErrors.length === 0, JSON.stringify(installability.installabilityErrors));
  await shot('drive-7-think-switch.png');

  // --- the model list (real network: OpenRouter's public endpoint) -----------
  // A scripted .focus() fires no `focus` event here: a headless page does not
  // hold window focus (see 2026-11-12-probe-model-list.mjs). Dispatch it.
  await js(`document.getElementById('model').dispatchEvent(new FocusEvent('focus'))`);
  const gotModels = await until(`document.querySelectorAll('#model-list option').length > 50`, 15000);
  check('the model picker fills from OpenRouter’s live list (real request, through the CSP)', gotModels, `${await js(`document.querySelectorAll('#model-list option').length`)} models`);

  check('no script errors, CSP violations or console errors during the run', problems.length === 0, problems.join(' | '));

  // --- offline (ADR-0003): take the web server away, then reload --------------
  server.kill();
  await serverGone;
  const serverDown = await fetch(APP).then(() => false, () => true);
  await cdp('Page.reload');
  const opened = await until(`document.querySelectorAll('.msg').length > 0 && document.getElementById('chat-title').textContent === 'think about 5 + 5'`, 8000);
  check('with the web server gone, a reload still opens the page with its saved conversation', serverDown && opened, `server down: ${serverDown}`);
  check('…styled, and with its scripts running', await js(`getComputedStyle(document.querySelector('.sidebar')).display === 'flex' && document.getElementById('think').getAttribute('aria-pressed') === 'false'`));
  await shot('drive-8-offline.png');
  ws.close();
} finally {
  chrome.kill();
  server.kill();
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
// - Later the same day, extended for the thinking view (ADR-0002): a "think"
//   scenario whose stand-in stream sends reasoning first (both as
//   reasoning_details and as the plain string), then the answer, naming a
//   served model. 30/30 on the first run. It supported deploying the thinking
//   view; it does not show that a real model's reasoning arrives in that shape.
// - Later again, for the PWA (ADR-0003) and the Think switch (ADR-0002,
//   QST-THINKING-DEFAULT = C): the driver now starts its own web server on
//   :8766 (so it can shut it down), checks the switch, asks Chrome for
//   manifest and installability errors over the DevTools protocol, then kills
//   the server and reloads. 38/38 on the first run with a fresh profile: the
//   worker controlled the page, Chrome reported nothing blocking install, and
//   the page reopened offline with its conversation. Give it a fresh output
//   directory each time — a profile from an earlier run carries an old worker.
// - And for the automatic retry (ADR-0004): a "flaky" scenario whose first
//   try is rate-limited inside a 200 stream after a little thinking — the
//   shape of the failure prorick reported from the live page — and whose
//   second try answers. 40/40: the page showed the "trying again" note, then
//   the answer, with two requests and nothing kept from the failed try.
// - Follow-up recorded in docs/TECHNICAL-DEBT.md ("The gate does not open a
//   browser"): promote this to a real test.
