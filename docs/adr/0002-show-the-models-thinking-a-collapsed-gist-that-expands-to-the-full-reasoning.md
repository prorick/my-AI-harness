<!-- adr template version: "adr 3.12.0" -->
<!--
adr teaching map: the example is not the teaching — these are the up-links from this file to what teaches its form; load them rather than winging it. (Sibling: the template-version marker dates the mold this file was minted from.)
  skill: adr-authoring
  mcp: adrs4ai
  plugin: adr@adrs4ai
-->

# Show the model's thinking: a collapsed gist that expands to the full reasoning

- **Date**: 2026-11-12
- **Iteration**: 1
- **Status**: Partially Implemented
- **Scope Remaining**: one real reply from a reasoning model on the deployed page. The thinking view has only been exercised against a scripted stream shaped after OpenRouter's documentation; no reasoning from a real model has been seen in it yet.
- **Deciders**: prorick (human), Keel 5.2 (claude-fable-5-2)

**TL;DR**: Each reply gets a "Thought for…" row — duration plus a one-line gist — that opens to the model's own reasoning as OpenRouter returns it; the page asks models to think by default, and says so plainly when a model shares nothing.

---

## Originating Context

**Source**: Human dump (below) — conversation, 2026-11-12, right after the first real conversation on the deployed page worked.

> I was able to get it to work! I want the chat to give a summary of why it got to the answer. There should be a button where you can expand and see what the agent thought when coming to the answer

**Agency Grant**: Not stated. Keel read it as "build it" and built the recommended option of each question below; both are one-setting or one-line changes if the answer goes the other way.

---

## Explicitation

**What I understand**:

1. **One feature, two states.** Collapsed: a short summary of the reasoning behind the answer. Expanded (the button): what the model thought, in full. I did not read it as two separate features.
2. **"What the agent thought" means the model's own reasoning**, not an explanation composed afterwards. OpenRouter passes reasoning through when the model produces it: raw thinking text for some models, a provider-written summary for others, nothing readable for the rest.
3. **The summary is the model's words too.** The collapsed line is the first line of that reasoning (for summarising providers this is the summary's title), cleaned of markdown. Nothing on the page writes a summary on the model's behalf.

**Assumptions**:

- The thinking is saved with the reply in localStorage, so it is still there after a reload. It is not sent back to the model on later turns (OpenRouter needs that only for tool calling).
- Rows start collapsed, including after a reload.
- A reply now names the model that actually answered. With `openrouter/auto` the label used to say `openrouter/auto` for every reply; which model answered decides whether there is any thinking to show, so the label now says. *(Not asked for; added because the feature is hard to understand without it.)*
- **A caution worth keeping in view**: what a provider shares as "reasoning" is the provider's account of the model's thinking — sometimes raw, sometimes summarised by another pass. It is the best available record of how the answer was reached; it is not a guarantee.

**Confirm**: prorick — reading 1 (one feature, not two), and the two questions.

---

## Questions

### QST-THINKING-DEFAULT: Should the page ask every model to think before answering, by default?
- Status: unanswered
- Why asking: Most models only produce reasoning when asked (the request carries `reasoning: { enabled: true }`), and thinking costs extra tokens and seconds on every message — including "what is 5 + 5". Of the 475 models OpenRouter lists today, 152 think by default and 147 cannot have it switched off; the rest think only on request or not at all. The page as built asks by default and has a switch in Settings.
- Need: pick a letter (or override — any shape answers)

Options:
- **A — on by default, switch in Settings**: Every message asks the model to think. A checkbox in Settings turns it off. Built today.
- **B — off by default**: The page never asks. The row still appears for models that think on their own. Cheapest; the row is absent for many models.
- **C — a switch next to the message box**: Thinking is chosen per message, so quick questions stay quick and hard ones get thought. One more control on a page that is meant to stay plain.

**Recommendation**: (by Keel 5.2, claude-fable-5-2, 2026-11-12)

**A — on by default, switch in Settings.** *Rationale*: the request was to see what the model thought, and with the default off most replies would have nothing to show (the `/api/v1/models` counts above, read 2026-11-12); the Settings switch covers the cost without adding a control to the main page. *Confidence*: 0.7 — because the cost side is unmeasured: I have not seen a real bill or a real latency for a thinking reply on this page. *If wrong*: if thinking on small questions feels slow or shows up in the OpenRouter bill, this flips to C.

**ANS:** (by [name])
[Fill this in]   <!-- literal placeholder — parser-significant, do not paraphrase -->

---

### QST-NO-THINKING: When a model shares no thinking, what should the reply show?
- Status: unanswered
- Why asking: Some models do not reason at all, and some keep their reasoning encrypted. With `openrouter/auto` this varies from one reply to the next. Today such a reply shows a quiet "no thinking shared" beside the model name and no row. The alternatives produce something to read every time, but what they produce is an explanation written after the answer, not a record of how the answer was reached.
- Need: pick a letter (or override — any shape answers)

Options:
- **A — say so, quietly**: The reply shows "no thinking shared" next to the model name. Nothing is invented. Built today.
- **B — ask for an explanation afterwards**: When no thinking arrives, the page sends a second request asking the same model to explain its answer, and shows that in the row, labelled as written afterwards. Every such reply costs a second request, and the text is a rationale, not the thinking.
- **C — ask for a "why" inside every answer**: A standing instruction tells the model to end each answer with a short reasoning summary, which the page lifts into the row. No second request, but it changes every answer the model gives, and it is also written for the reader rather than recorded.

**Recommendation**: (by Keel 5.2, claude-fable-5-2, 2026-11-12)

**A — say so, quietly.** *Rationale*: the request names "what the agent thought when coming to the answer"; B and C would fill the row with a plausible account produced after the fact, under the same label as real thinking, and a reader could not tell the two apart. With QST-THINKING-DEFAULT = A, the 353 of 475 listed models that carry reasoning metadata will usually have something real to show. *Confidence*: 0.75 — because I do not know which models prorick will actually use; the first real conversation was answered by one that shared nothing. *If wrong*: if the row turns out to be missing on most replies in everyday use, this flips to B, with the label kept honest.

**ANS:** (by [name])
[Fill this in]   <!-- literal placeholder — parser-significant, do not paraphrase -->

---

## Supporting Materials

### API: reasoning-in-a-stream
What the page relies on, from OpenRouter's reasoning-tokens and streaming documentation (read 2026-11-12):

**Request** (only when thinking is asked for):
```json
{ "model": "…", "messages": [], "stream": true, "reasoning": { "enabled": true } }
```

**Stream chunks** — reasoning arrives in `choices[0].delta.reasoning_details`, a list of items:
```json
{ "type": "reasoning.text", "text": "…" }
{ "type": "reasoning.summary", "summary": "…" }
{ "type": "reasoning.encrypted", "data": "…" }
```
The page reads `text` and `summary`, ignores `encrypted`, and falls back to a plain `delta.reasoning` string only when a chunk has no readable items (chunks can carry both, with the same text).

### FIL: where it lives
- `src/js/openrouter.js` — `readReasoning()` and the `reasoning` / `model` stream events
- `src/js/thinking.js` — the duration label and the one-line gist
- `src/js/app.js` — `thinkingEl()` / `paintThinking()`, the row itself (a native `<details>`)
- `tests/openrouter.test.js`, `tests/thinking.test.js`, `tests/store.test.js`

---

## Decision

### Context
The first real conversation on the page worked, and the next thing wanted was to see why the model answered as it did.

### Chosen: show the model's own reasoning, collapsed to a gist

**Rationale**: it is what was asked for, it needs no second request and no server, and it never puts words in the model's mouth.

**Trade-offs accepted**:
- **Not every reply has a row.** Models that share nothing get "no thinking shared" (QST-NO-THINKING).
- **Thinking costs tokens and time** while the default is on (QST-THINKING-DEFAULT).
- **The gist is only as good as the reasoning's first line.** For summarising providers that is a title; for raw thinking it is the opening sentence, which may be scene-setting rather than a conclusion.
- **Saved thinking takes space.** It is stored with each reply, and localStorage holds about 5 MB in all. The page already reports a full store.

### Consequences
- The stream now has three event kinds (`reasoning`, `text`, `model`); tool calls will be a fourth (ADR-0001, scope C).
- Reasoning is rendered through the same text-only markdown path as answers, so the page's safety rules hold for it unchanged.

---

## Open Follow-ups

- [ ] Unverified: a real reasoning stream. Three things rest on documentation or common practice rather than on something seen: that `reasoning: { enabled: true }` is harmless for models without reasoning (the docs say providers "ignore unknown parameters" under default routing, but do not name `reasoning`); the exact chunk shapes; and that each chunk's `model` field names the model that answered (observed practice, not documented). If the first is wrong, non-reasoning models will return an error on every message until the Settings switch is turned off.
- [ ] Concern: a reply stopped while the model is still thinking is discarded along with its thinking, as any reply stopped before its first word is.

---

## Action Items

- [ ] Try the deployed page with a reasoning model and with a non-reasoning one; report what the row shows - Owner: prorick
- [ ] Answer QST-THINKING-DEFAULT and QST-NO-THINKING - Owner: prorick

---

## Iterations

### Iteration 1 (2026-11-12)
- Trigger: human dump in conversation after the first working real conversation
- Contributors: prorick, Keel 5.2
- Changes: feature built per the two recommendations; 9 tests added (33 in all); the browser driver extended to 30 checks, all passing against a scripted stream
- Outcome: `Partially Implemented` (built and deployed; not yet seen with real reasoning)

---

## Links

- Related ADRs: [ADR-0001](0001-mission-and-architecture-a-static-chat-harness-on-github-pages.md) — mission, architecture, safety rules
- Related code: see "FIL: where it lives" above
- OpenRouter documentation: https://openrouter.ai/docs/use-cases/reasoning-tokens
