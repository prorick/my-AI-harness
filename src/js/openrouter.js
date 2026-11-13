// The only network code in the page: OpenRouter's chat-completions and models
// endpoints, called straight from the browser (ADR-0001). OpenRouter answers
// CORS preflights with `access-control-allow-origin: *` (checked 2026-11-12).

export const API_BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterError extends Error {
  // `status` is the HTTP-style status of the failure whether it arrived as the
  // response's own status or inside a stream that had already answered 200.
  // `retryAfterMs` is the server's own "wait this long" hint, when it gave one.
  constructor(message, { status = null, code = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const httpStatus = (code) => (Number.isInteger(code) && code >= 400 && code <= 599 ? code : null);

// `Retry-After` is seconds or an HTTP date. A browser only shows this header
// to the page when the server lists it in Access-Control-Expose-Headers, so
// most of the time there is nothing here and the backoff below decides.
function retryAfterMs(res, now = Date.now()) {
  const value = res.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

// What goes on the wire: an optional system prompt, then the turns. Only
// `role` and `content` are sent — stored messages also carry local fields
// (`model`, `error`, `reasoning`, …). A reply's reasoning is not sent back:
// OpenRouter only needs that for tool calling. Empty turns are skipped: a reply that failed before its
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
  return new OpenRouterError(detail || `OpenRouter answered ${res.status}.`, { status: res.status, code, retryAfterMs: retryAfterMs(res) });
}

// The readable reasoning in one stream delta (ADR-0002). OpenRouter documents
// `delta.reasoning_details`: a list of items that are raw text
// (`reasoning.text` → `text`), a provider-written summary
// (`reasoning.summary` → `summary`), or encrypted (`reasoning.encrypted`, not
// readable). Chunks may also carry the same text as a plain `delta.reasoning`
// string, so that is only a fallback — reading both would show it twice.
export function readReasoning(delta) {
  let text = '';
  if (Array.isArray(delta?.reasoning_details)) {
    for (const item of delta.reasoning_details) {
      if (item?.type === 'reasoning.text' && typeof item.text === 'string') text += item.text;
      else if (item?.type === 'reasoning.summary' && typeof item.summary === 'string') text += item.summary;
    }
  }
  if (!text && typeof delta?.reasoning === 'string') text = delta.reasoning;
  return text === '[REDACTED]' ? '' : text;
}

// Streams one reply as a sequence of typed events:
//   { type: 'reasoning', text }  the model's thinking, when it shares any
//   { type: 'text', text }       the answer
//   { type: 'model', id }        the model that actually answered, when it is
//                                not the one asked for (e.g. `openrouter/auto`)
// The events are typed so that tool calls can be added as another kind
// without changing how callers read the stream (ADR-0001, QST-HARNESS-SCOPE = C).
//
// `reasoning: true` asks the model to think before answering (ADR-0002).
// Without it the model does whatever it does by default, and any thinking it
// shares still arrives as events.
//
// Throws OpenRouterError for anything OpenRouter or the provider reports,
// including errors that arrive after the stream has started (those come as a
// chunk with an `error` field, on a 200 response).
export async function* streamChat({ apiKey, model, messages, reasoning = false, signal, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${API_BASE}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Harness',
    },
    body: JSON.stringify({ model, messages, stream: true, ...(reasoning ? { reasoning: { enabled: true } } : {}) }),
  });
  if (!res.ok) throw await errorFromResponse(res);

  let servedModel = model;
  for await (const payload of sseData(res.body)) {
    if (payload === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk.error) {
      // Once a provider has accepted the request, OpenRouter has already
      // answered 200; a failure after that — a provider's rate limit included,
      // even before the first token — arrives here, with the status it would
      // have had in `error.code`.
      const code = chunk.error.code ?? null;
      throw new OpenRouterError(chunk.error.message || 'The model reported an error.', { status: httpStatus(code), code });
    }
    if (typeof chunk.model === 'string' && chunk.model && chunk.model !== servedModel) {
      servedModel = chunk.model;
      yield { type: 'model', id: servedModel };
    }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    const thought = readReasoning(delta);
    if (thought) yield { type: 'reasoning', text: thought };
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
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

/* ---------- automatic retry (ADR-0004) ---------- */

// Failures that waiting can fix: rate limits (429 — OpenRouter's or, more
// often, the provider's), timeouts (408) and provider trouble (5xx). A bad
// key, no credits, or an unknown model will fail the same way every time.
export function isRetryable(err) {
  return err instanceof OpenRouterError && (err.status === 408 || err.status === 429 || (err.status >= 500 && err.status <= 599));
}

const RETRY_BASE_MS = 1500;
const RETRY_CAP_MS = 20000;

// How long to wait before retry number `attempt` (1, 2, 3…): 1.5 s, 3 s, 6 s,
// each nudged up to 25 % either way so that many pages hitting the same limit
// do not all come back at the same instant. A server hint wins when it is
// longer, up to the cap — past that, failing and letting the person decide is
// kinder than a silent half-minute.
export function retryDelay(attempt, err, random = Math.random) {
  const backoff = RETRY_BASE_MS * 2 ** (attempt - 1) * (0.75 + random() * 0.5);
  return Math.round(Math.min(RETRY_CAP_MS, Math.max(backoff, err?.retryAfterMs ?? 0)));
}

// A sleep that Stop can end.
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// streamChat(), retried. Same events, plus one more kind:
//   { type: 'retry', attempt, of, status, delayMs }
// sent before each wait: "try number `attempt` failed with `status`; trying
// again in `delayMs`; `of` tries in all". Anything received from the failed
// try (thinking, the model's name) is void — the next try starts clean.
//
// A try is only repeated while none of its answer has been shown: once text
// has reached the reader, a retry would restart the answer under their eyes.
export async function* streamChatWithRetry({ maxRetries = 3, sleep = wait, random = Math.random, ...request }) {
  for (let attempt = 1; ; attempt++) {
    let answered = false;
    try {
      for await (const event of streamChat(request)) {
        if (event.type === 'text') answered = true;
        yield event;
      }
      return;
    } catch (err) {
      if (answered || attempt > maxRetries || !isRetryable(err)) {
        if (err instanceof OpenRouterError) err.attempts = attempt;
        throw err;
      }
      const delayMs = retryDelay(attempt, err, random);
      yield { type: 'retry', attempt, of: maxRetries + 1, status: err.status, delayMs };
      await sleep(delayMs, request.signal);
    }
  }
}

// A few words for the "trying again" note shown during a retry wait.
export function retryReason(status) {
  if (status === 429) return 'The model is rate-limited';
  if (status === 408 || status === 504) return 'The request timed out';
  return 'The provider had a problem';
}

// One sentence a person can act on.
export function describeError(err) {
  if (err instanceof OpenRouterError) {
    const detail = err.message ? ` (${err.message})` : '';
    const tried = err.attempts > 1 ? ` Tried ${err.attempts} times.` : '';
    switch (err.status) {
      case 401:
        return `OpenRouter did not accept the API key. Check it in Settings.${detail}`;
      case 402:
        return `This key is out of credits. Add credits at openrouter.ai, or pick a free model.${detail}`;
      case 404:
        return `OpenRouter does not know this model. Pick another one.${detail}`;
      case 429:
        // OpenRouter words a provider-side limit as "rate-limited upstream":
        // the provider is throttling OpenRouter's shared capacity for that
        // model. Worth saying, because the natural guess is "my key ran out".
        return /upstream/i.test(err.message)
          ? `The model’s provider is rate-limiting requests right now; this is not a limit on your key.${tried} Wait a moment, then retry.${detail}`
          : `Rate limited.${tried} Wait a moment, then retry.${detail}`;
      default:
        return `${err.message || 'OpenRouter reported an error.'}${tried}`;
    }
  }
  if (err instanceof TypeError) return 'Could not reach OpenRouter. Check your connection, then retry.';
  return err?.message || 'Something went wrong.';
}
