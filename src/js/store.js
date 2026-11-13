// Persistence for the chat page. Everything — settings, the API key, and all
// conversations — lives in ONE localStorage entry, so a save is atomic and the
// whole state can be inspected or deleted in one place (ADR-0001).
//
// The key is prefixed with the project name because GitHub Pages serves every
// project site of an account from the same origin, and localStorage is shared
// per origin.

export const STORAGE_KEY = 'my-ai-harness:v1';
export const DEFAULT_MODEL = 'openrouter/auto';
const UNTITLED = 'New chat';

export function emptyState() {
  return {
    version: 1,
    settings: { apiKey: '', model: DEFAULT_MODEL, systemPrompt: '', thinking: true },
    conversations: [],
    activeId: null,
  };
}

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

// Coerce whatever was stored into the current shape. Anything unrecognisable is
// dropped rather than trusted: the page must still open if the entry was
// written by an older version or edited by hand.
function normalize(raw) {
  const state = emptyState();
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  state.settings.apiKey = str(s.apiKey);
  state.settings.model = str(s.model).trim() || DEFAULT_MODEL;
  state.settings.systemPrompt = str(s.systemPrompt);
  state.settings.thinking = s.thinking !== false; // on unless switched off; entries saved before ADR-0002 have no value

  const now = Date.now();
  for (const c of Array.isArray(raw.conversations) ? raw.conversations : []) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !Array.isArray(c.messages)) continue;
    const messages = [];
    for (const m of c.messages) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
      const msg = { role: m.role, content: m.content };
      if (typeof m.model === 'string') msg.model = m.model;
      if (typeof m.error === 'string') msg.error = m.error;
      // The model's thinking for this reply, how long it took, and whether
      // thinking was asked for but none was shared (ADR-0002).
      if (typeof m.reasoning === 'string' && m.reasoning) msg.reasoning = m.reasoning;
      if (Number.isFinite(m.thinkingMs)) msg.thinkingMs = m.thinkingMs;
      if (m.noThinking === true) msg.noThinking = true;
      messages.push(msg);
    }
    state.conversations.push({
      id: c.id,
      title: str(c.title).trim() || UNTITLED,
      createdAt: num(c.createdAt, now),
      updatedAt: num(c.updatedAt, now),
      messages,
    });
  }
  const active = str(raw.activeId, null);
  state.activeId = state.conversations.some((c) => c.id === active) ? active : null;
  return state;
}

function isQuotaError(err) {
  return Boolean(err) && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22);
}

// `storage` is anything with the Web Storage shape (getItem/setItem/removeItem).
export function createStore(storage) {
  return {
    // -> { state, problem: null | 'unavailable' | 'unreadable', backupKey? }
    load() {
      let text;
      try {
        text = storage.getItem(STORAGE_KEY);
      } catch {
        return { state: emptyState(), problem: 'unavailable' };
      }
      if (text == null) return { state: emptyState(), problem: null };
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        return { state: normalize(parsed), problem: null };
      } catch {
        // Never overwrite what we could not read: set the raw text aside so
        // the next save does not destroy someone's conversations.
        const backupKey = `${STORAGE_KEY}:unreadable-${Date.now()}`;
        try {
          storage.setItem(backupKey, text);
        } catch {
          return { state: emptyState(), problem: 'unreadable', backupKey: null };
        }
        return { state: emptyState(), problem: 'unreadable', backupKey };
      }
    },

    // -> { ok: true } | { ok: false, reason: 'full' | 'unavailable' }
    save(state) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: isQuotaError(err) ? 'full' : 'unavailable' };
      }
    },
  };
}

export function createConversation({ id = globalThis.crypto.randomUUID(), now = Date.now() } = {}) {
  return { id, title: UNTITLED, createdAt: now, updatedAt: now, messages: [] };
}

// A sidebar title from the first thing the person typed: one line, cut at a
// word boundary.
export function titleFrom(text, max = 48) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return UNTITLED;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function appendMessage(conv, message, now = Date.now()) {
  const firstUserMessage = message.role === 'user' && !conv.messages.some((m) => m.role === 'user');
  conv.messages.push(message);
  conv.updatedAt = now;
  if (firstUserMessage) conv.title = titleFrom(message.content);
  return message;
}

export function recentFirst(conversations) {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Removes a conversation. If it was the one on screen, the most recently used
// remaining conversation takes its place (or none, which shows a blank chat).
export function removeConversation(state, id) {
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.activeId === id) state.activeId = recentFirst(state.conversations)[0]?.id ?? null;
}
