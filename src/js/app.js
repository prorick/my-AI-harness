// The page: wires the DOM to the store (store.js), the network (openrouter.js)
// and the markdown renderer (render.js). State is one object, saved whole.

import { STORAGE_KEY, DEFAULT_MODEL, createStore, createConversation, appendMessage, removeConversation, recentFirst } from './store.js';
import { streamChat, fetchModels, buildMessages, describeError } from './openrouter.js';
import { renderMarkdown } from './render.js';
import { thinkingLabel, gist } from './thinking.js';

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  conversations: $('conversations'),
  title: $('chat-title'),
  model: $('model'),
  modelList: $('model-list'),
  notice: $('notice'),
  noticeText: $('notice-text'),
  messages: $('messages'),
  composer: $('composer'),
  input: $('input'),
  send: $('send'),
  settings: $('settings'),
  apiKey: $('api-key'),
  toggleKey: $('toggle-key'),
  systemPrompt: $('system-prompt'),
  thinking: $('thinking'),
};

const make = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
};

const store = createStore(window.localStorage);
const loaded = store.load();
let state = loaded.state;

// The reply being streamed, if any: { controller, convId, msg }.
let active = null;
// The DOM node the streaming reply is painted into, when it is on screen.
let liveBody = null;
// The "Thought for…" row of the streaming reply, once it has one.
let liveThinking = null;
let paintQueued = false;
// Replies whose thinking the reader has expanded. Kept by message object so a
// row stays open through re-renders; a reload starts with all rows collapsed.
const openThinking = new WeakSet();

/* ---------- state helpers ---------- */

const activeConv = () => state.conversations.find((c) => c.id === state.activeId) ?? null;

function persist() {
  const result = store.save(state);
  if (!result.ok) {
    showNotice(
      result.reason === 'full'
        ? 'This browser’s storage for the page is full, so recent messages are not being saved. Delete some conversations to make room.'
        : 'This browser is not letting the page save anything, so conversations will be gone when the tab closes.',
    );
  }
  return result.ok;
}

function showNotice(text) {
  els.noticeText.textContent = text;
  els.notice.hidden = false;
}

/* ---------- rendering ---------- */

function renderSidebar() {
  const rows = recentFirst(state.conversations).map((conv) => {
    const row = make('div', conv.id === state.activeId ? 'conv active' : 'conv');
    const open = make('button', 'conv-open', conv.title);
    open.type = 'button';
    open.dataset.open = conv.id;
    open.title = conv.title;
    if (conv.id === state.activeId) open.setAttribute('aria-current', 'true');
    const del = make('button', 'conv-del', '×');
    del.type = 'button';
    del.dataset.del = conv.id;
    del.setAttribute('aria-label', `Delete “${conv.title}”`);
    row.append(open, del);
    return row;
  });
  els.conversations.replaceChildren(...(rows.length ? rows : [make('p', 'conv-empty', 'No conversations yet.')]));
}

function emptyState() {
  const wrap = make('div', 'empty');
  wrap.append(make('h2', null, 'What’s on your mind?'));
  if (!state.settings.apiKey) {
    wrap.append(make('p', null, 'Add an OpenRouter API key to start. It stays in this browser.'));
    const add = make('button', 'btn primary', 'Add key');
    add.type = 'button';
    add.dataset.action = 'settings';
    wrap.append(add);
  }
  return wrap;
}

function typingDots() {
  const dots = make('span', 'typing');
  dots.setAttribute('aria-label', 'Waiting for the reply');
  dots.append(make('i'), make('i'), make('i'));
  return dots;
}

// The "Thought for…" row (ADR-0002): a native <details>, so the expand button,
// keyboard handling and screen-reader state come from the browser. Collapsed,
// it shows how long the model thought and a one-line gist; expanded, the
// model's reasoning in full.
function paintThinking(node, message, stillThinking) {
  node.label.textContent = stillThinking ? 'Thinking…' : thinkingLabel(message.thinkingMs);
  node.gist.textContent = gist(message.reasoning, { from: stillThinking ? 'end' : 'start' });
  // The full text is only built while the row is open.
  if (node.details.open) node.body.replaceChildren(renderMarkdown(message.reasoning));
}

function thinkingEl(message, isLive) {
  const details = make('details', 'thinking');
  const summary = make('summary');
  const node = { details, label: make('span', 'thinking-label'), gist: make('span', 'thinking-gist'), body: make('div', 'thinking-body prose') };
  summary.append(node.label, node.gist);
  details.append(summary, node.body);
  details.open = openThinking.has(message);
  details.addEventListener('toggle', () => {
    if (details.open) {
      openThinking.add(message);
      node.body.replaceChildren(renderMarkdown(message.reasoning));
    } else {
      openThinking.delete(message);
    }
  });
  paintThinking(node, message, isLive && !message.content);
  if (isLive) liveThinking = node;
  return details;
}

function messageEl(message, index, conv) {
  const article = make('article', `msg ${message.role}`);
  if (message.role === 'user') {
    article.append(make('div', 'bubble', message.content));
    return article;
  }

  const isLive = active?.msg === message;
  if (message.reasoning) article.append(thinkingEl(message, isLive));
  const body = make('div', 'prose');
  if (message.content) body.append(renderMarkdown(message.content));
  else if (isLive) body.append(typingDots());
  if (isLive) liveBody = body;
  article.append(body);

  if (message.error) {
    const error = make('div', 'msg-error');
    error.append(make('span', null, message.error));
    if (index === conv.messages.length - 1) {
      const retry = make('button', 'link-btn', 'Retry');
      retry.type = 'button';
      retry.dataset.action = 'retry';
      error.append(retry);
    }
    article.append(error);
  }

  if (!isLive && message.content) {
    const meta = make('div', 'msg-meta');
    if (message.model) meta.append(make('span', null, message.model));
    if (message.noThinking) meta.append(make('span', null, 'no thinking shared'));
    const copy = make('button', 'link-btn', 'Copy');
    copy.type = 'button';
    copy.dataset.action = 'copy';
    copy.dataset.index = String(index);
    meta.append(copy);
    article.append(meta);
  }
  return article;
}

function renderMessages() {
  const conv = activeConv();
  els.title.textContent = conv ? conv.title : 'New chat';
  document.title = conv ? `${conv.title} · Harness` : 'Harness';
  liveBody = null;
  liveThinking = null;
  const thread = make('div', 'thread');
  if (!conv || !conv.messages.length) thread.append(emptyState());
  else conv.messages.forEach((message, index) => thread.append(messageEl(message, index, conv)));
  els.messages.replaceChildren(thread);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function render() {
  renderSidebar();
  renderMessages();
  updateSend();
}

// While a reply streams, only its own node is repainted, at most once a frame.
// The view follows the text only if the reader has not scrolled up.
function queuePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (!active || !liveBody || state.activeId !== active.convId) return;
    const box = els.messages;
    const following = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const msg = active.msg;
    if (msg.reasoning) {
      // The row appears with the first thought; until the answer starts, the
      // waiting dots stay below it.
      if (!liveThinking) liveBody.before(thinkingEl(msg, true));
      else paintThinking(liveThinking, msg, !msg.content);
    }
    if (msg.content) liveBody.replaceChildren(renderMarkdown(msg.content));
    if (following) box.scrollTop = box.scrollHeight;
  });
}

function updateSend() {
  const busy = Boolean(active);
  els.send.classList.toggle('busy', busy);
  els.send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  els.send.disabled = !busy && !els.input.value.trim();
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 220)}px`;
}

/* ---------- talking to the model ---------- */

async function reply(conv) {
  const model = state.settings.model || DEFAULT_MODEL;
  const outgoing = buildMessages(conv.messages, state.settings.systemPrompt);
  const msg = appendMessage(conv, { role: 'assistant', content: '', model });
  const controller = new AbortController();
  active = { controller, convId: conv.id, msg };
  persist();
  render();

  const askedToThink = state.settings.thinking;
  let thinkingSince = null;
  const endThinking = () => {
    if (thinkingSince !== null && msg.thinkingMs === undefined) msg.thinkingMs = Math.round(performance.now() - thinkingSince);
  };
  let stopped = false;
  try {
    const stream = streamChat({ apiKey: state.settings.apiKey, model, messages: outgoing, reasoning: askedToThink, signal: controller.signal });
    // One model turn. When tools arrive (ADR-0001, QST-HARNESS-SCOPE = C) this
    // is where the loop goes: handle the new event kinds here, run the tool,
    // append its result to `outgoing`, and stream again until the model stops
    // asking.
    for await (const event of stream) {
      if (event.type === 'reasoning') {
        thinkingSince ??= performance.now();
        msg.reasoning = (msg.reasoning ?? '') + event.text;
      } else if (event.type === 'text') {
        endThinking(); // the thinking time ends when the answer starts
        msg.content += event.text;
      } else if (event.type === 'model') {
        msg.model = event.id;
      } else {
        continue;
      }
      queuePaint();
    }
  } catch (err) {
    if (err?.name === 'AbortError') stopped = true;
    else msg.error = describeError(err);
  } finally {
    active = null;
    endThinking();
    // Say so when thinking was asked for and the model shared none (it does
    // not reason, or keeps its reasoning encrypted) — otherwise a missing row
    // looks like a bug.
    if (askedToThink && !msg.reasoning && msg.content && !msg.error) msg.noThinking = true;
    // A reply stopped before its first word leaves nothing worth keeping.
    if (stopped && !msg.content) conv.messages = conv.messages.filter((m) => m !== msg);
    conv.updatedAt = Date.now();
    persist();
    render();
  }
}

function send(text) {
  let conv = activeConv();
  if (!conv) {
    conv = createConversation();
    state.conversations.push(conv);
    state.activeId = conv.id;
  }
  appendMessage(conv, { role: 'user', content: text });
  return reply(conv);
}

function retry() {
  const conv = activeConv();
  if (!conv || active) return;
  const last = conv.messages[conv.messages.length - 1];
  if (last?.role === 'assistant' && last.error) conv.messages.pop();
  return reply(conv);
}

function stop() {
  active?.controller.abort();
}

/* ---------- events ---------- */

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (active) return stop();
  const text = els.input.value.trim();
  if (!text) return;
  if (!state.settings.apiKey) return openSettings(); // the draft stays in the box
  els.input.value = '';
  autosize();
  send(text);
});

els.input.addEventListener('input', () => {
  autosize();
  updateSend();
});

els.input.addEventListener('keydown', (event) => {
  // Enter sends; Shift+Enter is a new line. Enter that confirms an IME
  // composition (Japanese, Chinese, Korean input) must not send.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!active) els.composer.requestSubmit();
});

$('new-chat').addEventListener('click', () => {
  state.activeId = null;
  persist();
  closeSidebar();
  render();
  els.input.focus();
});

els.conversations.addEventListener('click', (event) => {
  const open = event.target.closest('[data-open]');
  const del = event.target.closest('[data-del]');
  if (open) {
    state.activeId = open.dataset.open;
    persist();
    closeSidebar();
    render();
  } else if (del) {
    const conv = state.conversations.find((c) => c.id === del.dataset.del);
    if (!conv || !window.confirm(`Delete “${conv.title}”? This cannot be undone.`)) return;
    if (active?.convId === conv.id) stop();
    removeConversation(state, conv.id);
    persist();
    render();
  }
});

async function copyText(text, button) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Could not copy';
  }
  setTimeout(() => {
    button.textContent = label;
  }, 1400);
}

els.messages.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'settings') openSettings();
  else if (action === 'retry') retry();
  else if (action === 'copy') copyText(activeConv()?.messages[Number(button.dataset.index)]?.content ?? '', button);
  else if (action === 'copy-code') copyText(button.closest('.code')?.querySelector('pre code')?.textContent ?? '', button);
});

// Model picker: free text with suggestions. The list is fetched the first time
// the field is used, not on every page load.
let modelsRequested = false;
els.model.addEventListener('focus', async () => {
  els.model.select();
  if (modelsRequested) return;
  modelsRequested = true;
  try {
    const models = await fetchModels();
    els.modelList.replaceChildren(
      ...models.map((m) => {
        const option = document.createElement('option');
        option.value = m.id;
        option.label = m.name;
        return option;
      }),
    );
  } catch {
    modelsRequested = false; // typing a model id by hand still works; try again next time
  }
});
els.model.addEventListener('change', () => {
  state.settings.model = els.model.value.trim() || DEFAULT_MODEL;
  els.model.value = state.settings.model;
  persist();
});

/* ---------- settings ---------- */

function openSettings() {
  els.apiKey.value = state.settings.apiKey;
  els.apiKey.type = 'password';
  els.toggleKey.textContent = 'Show';
  els.systemPrompt.value = state.settings.systemPrompt;
  els.thinking.checked = state.settings.thinking;
  els.settings.showModal();
  if (!state.settings.apiKey) els.apiKey.focus();
}

$('open-settings').addEventListener('click', () => {
  closeSidebar();
  openSettings();
});
$('cancel-settings').addEventListener('click', () => els.settings.close());
els.toggleKey.addEventListener('click', () => {
  const reveal = els.apiKey.type === 'password';
  els.apiKey.type = reveal ? 'text' : 'password';
  els.toggleKey.textContent = reveal ? 'Hide' : 'Show';
});
$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.settings.apiKey = els.apiKey.value.trim();
  state.settings.systemPrompt = els.systemPrompt.value;
  state.settings.thinking = els.thinking.checked;
  persist();
  els.settings.close();
  render();
  els.input.focus();
});
$('clear-all').addEventListener('click', () => {
  if (!window.confirm('Delete every conversation saved in this browser? Your key and settings stay. This cannot be undone.')) return;
  stop();
  state.conversations = [];
  state.activeId = null;
  persist();
  els.settings.close();
  render();
});
// A click on the dimmed backdrop lands on the <dialog> element itself.
els.settings.addEventListener('click', (event) => {
  if (event.target === els.settings) els.settings.close();
});

/* ---------- sidebar drawer (narrow screens) ---------- */

function closeSidebar() {
  els.app.classList.remove('sidebar-open');
}
$('toggle-sidebar').addEventListener('click', () => els.app.classList.toggle('sidebar-open'));
$('scrim').addEventListener('click', closeSidebar);
$('notice-close').addEventListener('click', () => {
  els.notice.hidden = true;
});

/* ---------- other tabs ---------- */

// Another tab of this page saved: show its version, unless a reply is
// streaming here (that reply's save will be the newer one). See
// docs/TECHNICAL-DEBT.md, "Two tabs, one store".
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY || active) return;
  state = store.load().state;
  els.model.value = state.settings.model;
  render();
});

/* ---------- start ---------- */

if (loaded.problem === 'unreadable') {
  showNotice(
    loaded.backupKey
      ? `The saved conversations could not be read. They were set aside untouched in this browser’s storage as “${loaded.backupKey}”, and the page started fresh.`
      : 'The saved conversations could not be read, and the page started fresh.',
  );
} else if (loaded.problem === 'unavailable') {
  showNotice('This browser is blocking storage for the page, so conversations and your key will not be saved.');
}

els.model.value = state.settings.model;
render();
autosize();
