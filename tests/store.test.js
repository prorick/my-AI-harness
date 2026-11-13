import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  DEFAULT_MODEL,
  createStore,
  createConversation,
  appendMessage,
  removeConversation,
  recentFirst,
  titleFrom,
} from '../src/js/store.js';

// A stand-in for window.localStorage: same three methods, same string-only
// values, and an optional byte budget so it can fill up the way a real one does.
class MemoryStorage {
  constructor({ quota = Infinity } = {}) {
    this.items = new Map();
    this.quota = quota;
  }
  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }
  setItem(key, value) {
    if (String(value).length > this.quota) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.items.set(key, String(value));
  }
  removeItem(key) {
    this.items.delete(key);
  }
}

test('conversations, settings, the key and each reply’s thinking are still there after a reload', () => {
  const storage = new MemoryStorage();
  const { state } = createStore(storage).load();
  state.settings.apiKey = 'sk-or-test';
  state.settings.model = 'some/model';
  const conv = createConversation({ id: 'c1', now: 1000 });
  appendMessage(conv, { role: 'user', content: 'Why is the sky blue?' }, 2000);
  appendMessage(conv, { role: 'assistant', content: 'Rayleigh scattering.', model: 'some/model', reasoning: 'Short wavelengths scatter more.', thinkingMs: 2300 }, 3000);
  appendMessage(conv, { role: 'user', content: 'And at sunset?' }, 4000);
  appendMessage(conv, { role: 'assistant', content: 'A longer path through the air.', model: 'some/model', noThinking: true }, 5000);
  state.settings.thinking = false;
  state.conversations.push(conv);
  state.activeId = 'c1';
  assert.deepEqual(createStore(storage).save(state), { ok: true });

  // A new store over the same storage is what a page reload is.
  const reloaded = createStore(storage).load();
  assert.equal(reloaded.problem, null);
  assert.deepEqual(reloaded.state, state);
});

test('a first visit starts empty with the default model', () => {
  const { state, problem } = createStore(new MemoryStorage()).load();
  assert.equal(problem, null);
  assert.deepEqual(state.conversations, []);
  assert.equal(state.settings.model, DEFAULT_MODEL);
});

test('an unreadable entry is set aside, not overwritten, so its conversations can be recovered', () => {
  const storage = new MemoryStorage();
  const damaged = '{"version":1,"conversations":[{"id":"c1","title":"Thesis notes","mess';
  storage.setItem(STORAGE_KEY, damaged);

  const store = createStore(storage);
  const { state, problem, backupKey } = store.load();
  assert.equal(problem, 'unreadable');
  assert.deepEqual(state.conversations, []);

  // The page keeps working and saves over the main entry…
  store.save(state);
  // …but the damaged text is still there, byte for byte.
  assert.equal(storage.getItem(backupKey), damaged);
});

test('a full browser store is reported instead of thrown', () => {
  const storage = new MemoryStorage({ quota: 400 });
  const store = createStore(storage);
  const { state } = store.load();
  const conv = createConversation({ id: 'c1' });
  appendMessage(conv, { role: 'user', content: 'x'.repeat(1000) });
  state.conversations.push(conv);
  assert.deepEqual(store.save(state), { ok: false, reason: 'full' });
});

test('a browser that blocks storage still opens the page', () => {
  // Safari with "Block all cookies", and some embedded webviews, throw on any access.
  const blocked = {
    getItem() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
    setItem() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  };
  const store = createStore(blocked);
  const { state, problem } = store.load();
  assert.equal(problem, 'unavailable');
  assert.deepEqual(store.save(state), { ok: false, reason: 'unavailable' });
});

test('an entry with missing or damaged parts loads what is sound and drops the rest', () => {
  const storage = new MemoryStorage();
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      settings: { apiKey: 'sk-or-test' }, // no model, no system prompt
      activeId: 'gone',
      conversations: [
        { id: 'ok', title: 'Kept', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'x' }, null] },
        { title: 'no id', messages: [] },
        'not a conversation',
      ],
    }),
  );
  const { state, problem } = createStore(storage).load();
  assert.equal(problem, null);
  assert.equal(state.settings.apiKey, 'sk-or-test');
  assert.equal(state.settings.model, DEFAULT_MODEL);
  assert.equal(state.settings.thinking, true, 'an entry saved before the thinking switch existed gets it switched on');
  assert.equal(state.activeId, null, 'an active id that points nowhere is cleared');
  assert.deepEqual(state.conversations, [{ id: 'ok', title: 'Kept', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'hi' }] }]);
});

test('a conversation is titled from the first message, on one line, cut at a word', () => {
  const conv = createConversation({ id: 'c1' });
  appendMessage(conv, { role: 'user', content: 'Explain\n  how   TCP slow start works and why it was needed in the first place' });
  assert.equal(conv.title, 'Explain how TCP slow start works and why it was…');

  appendMessage(conv, { role: 'user', content: 'And congestion avoidance?' });
  assert.equal(conv.title, 'Explain how TCP slow start works and why it was…', 'later messages do not rename it');

  assert.equal(titleFrom('Hi'), 'Hi');
  assert.equal(titleFrom('a'.repeat(80)), `${'a'.repeat(48)}…`, 'one long word is cut hard');
});

test('deleting the open conversation opens the most recently used one that is left', () => {
  const { state } = createStore(new MemoryStorage()).load();
  const older = createConversation({ id: 'older', now: 100 });
  const newer = createConversation({ id: 'newer', now: 200 });
  const open = createConversation({ id: 'open', now: 300 });
  state.conversations.push(older, newer, open);
  state.activeId = 'open';

  removeConversation(state, 'open');
  assert.equal(state.activeId, 'newer');
  assert.deepEqual(recentFirst(state.conversations).map((c) => c.id), ['newer', 'older']);

  removeConversation(state, 'older');
  assert.equal(state.activeId, 'newer', 'deleting a different conversation leaves the open one alone');

  removeConversation(state, 'newer');
  assert.equal(state.activeId, null);
});
