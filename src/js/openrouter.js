// The only network code in the page: OpenRouter's chat-completions and models
// endpoints, called straight from the browser (ADR-0001). OpenRouter answers
// CORS preflights with `access-control-allow-origin: *` (checked 2026-11-12).

export const API_BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.code = code;
  }
}

// What goes on the wire: an optional system prompt, then the turns. Only
// `role` and `content` are sent — stored messages also carry local fields
// (`model`, `error`). Empty turns are skipped: a reply that failed before its
// first token is stored empty, and providers reject empty assistant messages.
export function buildMessages(messages, systemPrompt = '') {
  const out = [];
  if (systemPrompt.trim()) out.push({ role: 'system', content: systemPrompt.trim() });
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content !== 'string' || !m.content.trim()) continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

// Yields the payload of each `data:` line of a server-sent-event body. Network
// chunks split anywhere — mid-line, mid-character — so bytes are decoded as a
// stream and lines are only cut at newlines. Comment lines (OpenRouter sends
// `: OPENROUTER PROCESSING` keep-alives) are ignored.
export async function* sseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dataOf = (line) => (line.startsWith('data:') ? line.slice(5).trim() : null);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const data = dataOf(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = buffer.slice(newline + 1);
        if (data !== null) yield data;
      }
    }
    buffer += decoder.decode();
    const data = dataOf(buffer.replace(/\r$/, ''));
    if (data !== null) yield data;
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function errorFromResponse(res) {
  let detail = '';
  let code = null;
  try {
    const body = await res.json();
    detail = body?.error?.message ?? '';
    code = body?.error?.code ?? null;
  } catch {
    // A non-JSON error body: the status alone has to do.
  }
  return new OpenRouterError(detail || `OpenRouter answered ${res.status}.`, { status: res.status, code });
}

// Streams one reply as a sequence of events. Today there is one kind,
// `{ type: 'text', text }`; the events are typed so that tool calls can be
// added as a second kind without changing how callers read the stream
// (ADR-0001, QST-HARNESS-SCOPE = C: chat now, tools next).
//
// Throws OpenRouterError for anything OpenRouter or the provider reports,
// including errors that arrive after the stream has started (those come as a
// chunk with an `error` field, on a 200 response).
export async function* streamChat({ apiKey, model, messages, signal, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${API_BASE}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Harness',
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) throw await errorFromResponse(res);

  for await (const payload of sseData(res.body)) {
    if (payload === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk.error) {
      throw new OpenRouterError(chunk.error.message || 'The model reported an error.', { code: chunk.error.code ?? null });
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) yield { type: 'text', text: delta };
  }
}

// The model list for the picker. Public endpoint, no key needed. Models that
// cannot produce text (speech, image-only) are left out.
export async function fetchModels({ fetchImpl = globalThis.fetch, signal } = {}) {
  const res = await fetchImpl(`${API_BASE}/models`, { signal });
  if (!res.ok) throw await errorFromResponse(res);
  const body = await res.json();
  return (Array.isArray(body?.data) ? body.data : [])
    .filter((m) => m && typeof m.id === 'string')
    .filter((m) => {
      const outputs = m.architecture?.output_modalities;
      return !Array.isArray(outputs) || outputs.includes('text');
    })
    .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// One sentence a person can act on.
export function describeError(err) {
  if (err instanceof OpenRouterError) {
    const detail = err.message ? ` (${err.message})` : '';
    switch (err.status) {
      case 401:
        return `OpenRouter did not accept the API key. Check it in Settings.${detail}`;
      case 402:
        return `This key is out of credits. Add credits at openrouter.ai, or pick a free model.${detail}`;
      case 404:
        return `OpenRouter does not know this model. Pick another one.${detail}`;
      case 429:
        return `Rate limited. Wait a moment, then retry.${detail}`;
      default:
        return err.message || 'OpenRouter reported an error.';
    }
  }
  if (err instanceof TypeError) return 'Could not reach OpenRouter. Check your connection, then retry.';
  return err?.message || 'Something went wrong.';
}
