<!-- adr template version: "adr 3.12.0" -->
<!--
adr teaching map: the example is not the teaching — these are the up-links from this file to what teaches its form; load them rather than winging it. (Sibling: the template-version marker dates the mold this file was minted from.)
  skill: adr-authoring
  mcp: adrs4ai
  plugin: adr@adrs4ai
-->

# Mission and architecture: a static chat harness on GitHub Pages

- **Date**: 2026-11-12
- **Iteration**: 2
- **Status**: Partially Implemented
- **Scope Remaining**: one real conversation on the deployed page with a real OpenRouter key (so far the reply stream has only been exercised with a scripted stand-in). Tools are a separate, later ADR, not remaining scope of this one.
- **Deciders**: prorick (human), Keel 5.2 (claude-fable-5-2)

**TL;DR**: The project is a clean, static chat page served by GitHub Pages that calls OpenRouter directly from the browser with the visitor's own API key and keeps everything in localStorage — no server, no build step.

---

## Originating Context

**Source**: Human dump (below) — the founding conversation, 2026-11-12, answering Keel's "what is this project for?" after the seat was founded (`docs/inbox/2026-11-12-2308-founding-brief-interactive.md` deferred the mission to this conversation).

> This project is for creating a simple harness. This will be a chat page interface online that is clean vibes in terms of aesthetic. Use github pages only. OpenRouter API keys through CORS on the front end. storage is in local storage.

**Agency Grant**: Not stated. Keel read the dump as "build it", and built a first version under the four stated constraints; everything the dump left open is either a question below or a default listed under Assumptions.

---

## Explicitation

**What I understand**:

1. **A chat page, online** — a single web page where someone types a message and a model answers. "Simple" is a constraint, not a placeholder: few features, done well.
2. **Clean aesthetic** — quiet typography, lots of whitespace, one accent color, light and dark themes, nothing decorative.
3. **GitHub Pages only** — static hosting is the whole backend. No server, no serverless function, no proxy. Anything the page needs at runtime it gets from the browser or from OpenRouter.
4. **OpenRouter from the front end** — the browser calls `https://openrouter.ai/api/v1` directly (OpenRouter answers CORS preflights with `access-control-allow-origin: *`; checked 2026-11-12). The key is the visitor's own, typed into the page; it is never in the repo.
5. **localStorage** — conversations, settings, and the API key live in the visitor's browser and nowhere else.

**Assumptions** (defaults Keel chose; each is cheap to change):

- No build step and no dependencies: plain HTML, CSS, and ES modules. Tests run on Node's built-in test runner.
- The default model is `openrouter/auto`; the picker is filled from OpenRouter's live model list, so no model id is hard-coded to go stale.
- Responses stream. A reply can be stopped mid-stream and the partial text is kept.
- Model output is rendered through DOM text nodes only, never as HTML, and the page ships a Content-Security-Policy that allows network calls to `openrouter.ai` alone. The key sits in localStorage, so a script-injection hole would be a key-theft hole.
- "Harness" means a chat client for now — see QST-HARNESS-SCOPE.

**Confirm**: prorick — mainly assumption 5 and the two questions below.

---

## Questions

### QST-HARNESS-SCOPE: Does "harness" mean a chat client only, or should the model also be able to use tools?
- Status: answered
- Why asking: "Harness" usually means the loop around a model that lets it call tools and act on the results; the dump describes only a chat page. The first version is chat only. If tools are wanted, the message format, the storage schema, and the streaming code all grow, and it is cheaper to know before more is built on the chat-only shape.
- Need: pick a letter (or override — any shape answers)

Options:
- **A — chat only**: The page sends the conversation and shows the reply. No tool calls. This is what is built today.
- **B — chat plus browser tools**: The model can call a small set of tools that run in the page itself (for example a calculator, a fetch of a public URL, a notes store in localStorage), and the page loops until the model stops asking for tools. Still static, still GitHub Pages only.
- **C — chat now, tools as the next milestone**: Ship A, then design B in its own ADR once the chat page has been used.

**Recommendation**: (by Keel 5.2, claude-fable-5-2, 2026-11-12)

**C — chat now, tools as the next milestone.** *Rationale*: the dump lists four constraints and none mentions tools, so A is the literal reading; but the word "harness" and the course setting (`cis7000`) make B a plausible intent, and B is a superset that reuses A's streaming and storage (`src/js/openrouter.js`, `src/js/store.js`). *Confidence*: 0.6 — because the guess about intent rests on one word and a directory name; I have not seen the assignment. *If wrong*: if the course deliverable requires tool use, this flips to B and the tools ADR comes first; if the page is only ever meant to chat, it flips to A and no follow-up is owed.

**ANS:** (by prorick)
C. Let's go with C for now, chat should work, but make sure we can build on top of it so we can add tools so the harness is useful.

---

### QST-PAGES-SOURCE: Which GitHub Pages publishing mode — an Actions workflow that publishes `src/`, or "deploy from branch"?
- Status: answered
- Why asking: Both are "GitHub Pages only". The repo also holds ADRs, the inbox, and the crew registry, and the mode decides whether those get published alongside the chat page. The first version is laid out for option A; switching later means moving files or changing one setting.
- Need: pick a letter (or override — any shape answers)

Options:
- **A — Actions workflow publishing `src/`**: `.github/workflows/pages.yml` runs the tests, then publishes only the `src/` folder. Needs one setting: Settings → Pages → Source → "GitHub Actions". A failing test blocks the deploy.
- **B — deploy from branch, repo root**: Pages serves the whole `main` branch; `index.html` moves to the repo root. No workflow file, but every file in the repo (CLAUDE.md, ADRs, inbox briefs) becomes a public URL on the site, and tests do not gate the deploy.
- **C — deploy from branch, `/docs`**: Pages serves the `docs/` folder; the app moves in beside `docs/adr/` and `docs/inbox/`, which are then also served.

**Recommendation**: (by Keel 5.2, claude-fable-5-2, 2026-11-12)

**A — Actions workflow publishing `src/`.** *Rationale*: it is the only mode that publishes the app and nothing else, and the only one where the gate (`just gate`) also guards the live site; `docs/` is already taken by the method's own files, which rules out C without a reshuffle. *Confidence*: 0.8 — because the workflow is written but has not run yet (nothing is pushed), and the action versions in it are the ones I know, not ones I checked today. *If wrong*: if Actions is unavailable on this account or the workflow cannot be made to pass, this flips to B.

**ANS:** (by prorick)
Use A if you can. Just make sure that my website link still works: https://prorick.github.io/
If not go with B.

---

## Decision

### Context
The project needed a mission; the founder gave one in five sentences. This record fixes those sentences so later seats do not have to reconstruct them.

### Chosen: static page + browser-side OpenRouter + localStorage

**Rationale**: decided by the human in the originating dump; not deliberated.

**Trade-offs accepted**:
- **The API key lives in the browser.** Anyone with access to the browser profile can read it, and so can any script that runs on the same origin. On GitHub Pages the origin is `<user>.github.io`, shared by every project site of that account, so another of the account's own project pages could read this page's localStorage. Mitigations in the first version: a strict Content-Security-Policy, no third-party scripts, no HTML rendering of model output, storage keys prefixed `my-ai-harness:`.
- **No sync.** Conversations stay on the device and browser they were written in; clearing site data deletes them.
- **About 5 MB of storage.** localStorage is small; the page reports a full store instead of failing silently.

### Refinements from the answers (Iteration 2)

- **Scope — C: chat now, tools next** (QST-HARNESS-SCOPE). Chat has to work; the code has to be something tools can be added to. Three seams are in place for that, and nothing else was built ahead of need:
  1. `streamChat()` in `src/js/openrouter.js` yields typed events (`{ type: 'text', text }`), so a tool-call event is a second kind, not a new interface.
  2. One function, `reply()` in `src/js/app.js`, runs a model turn; the tool loop goes inside it (a comment marks the spot).
  3. The stored state carries `version: 1`, and `buildMessages()` is the single place stored messages become wire messages — the place a `tool` role would be added.

  One constraint the tools ADR will have to face: the page's Content-Security-Policy allows network calls to `openrouter.ai` only, so a tool that fetches other URLs means loosening it on purpose.
- **Publishing — A: Actions workflow publishing `src/`** (QST-PAGES-SOURCE), with the condition that `https://prorick.github.io/` keeps working. It does: this is a project site at `https://prorick.github.io/my-AI-harness/`, served beside the account's own site, not in place of it. Checked after the deploy: both URLs answer 200, the deployed `index.html` and `app.js` are byte-identical to the repo's, and nothing outside `src/` is served.

### Consequences
- The site can be hosted for free and forked by anyone; each visitor brings their own key and pays their own usage.
- There is nothing to operate: no secrets in the repo, no server to keep alive.
- Features that need a server (shared history, hiding a key, rate limiting) are out of scope by construction.

---

## Open Follow-ups

- [ ] Unverified: a real chat completion from the deployed page. The request path is tested against a fake `fetch`, and the whole page was driven in headless Chrome with a scripted reply stream (`scripts/ephemeral/2026-11-12-drive-chat-flow.mjs`, 18/18); no API key was available to test against OpenRouter itself. This is why the status is Partially Implemented and not Implemented.
- [ ] Future task: the tools milestone gets its own ADR (which tools, where they run, what the CSP has to allow).
- [ ] Concern: `README.md` is still the template's README; it describes the method, not this project. It is a template-maintained file (`kintsugi.yaml` class `stencil`), so it was left alone.
- [ ] Future task: OpenRouter's OAuth (PKCE) sign-in would let visitors connect without pasting a key. Not built; the dump says "API keys".
- [ ] Concern: tables and images in model output render as plain text in the first version.

---

## Action Items

- [x] Answer QST-HARNESS-SCOPE and QST-PAGES-SOURCE - Owner: prorick (2026-11-12)
- [x] Push `main` and set Pages source to "GitHub Actions" - Owner: Keel, on the answer to QST-PAGES-SOURCE (2026-11-12)
- [ ] First real conversation on the deployed page with a real key - Owner: prorick
- [ ] Open the tools ADR - Owner: Keel, when prorick says the chat page is good enough to build on

---

## Iterations

### Iteration 1 (2026-11-12)
- Trigger: initial draft from the human dump in the founding conversation
- Contributors: prorick, Keel 5.2
- Changes: mission and four constraints recorded; two questions opened; defaults listed as assumptions
- Outcome: `Accepted` (the core decision is the human's and is made; the questions refine it)

### Iteration 2 (2026-11-12)
- Trigger: prorick answered both questions in the ADR (commit `e76513f`)
- Contributors: prorick, Keel 5.2
- Changes: QST-HARNESS-SCOPE = C and QST-PAGES-SOURCE = A recorded under Decision; the stream was reshaped into typed events so tools can be added; the page was built, tested, pushed, and deployed to `https://prorick.github.io/my-AI-harness/`; the answer bylines, which the editor had stamped with the unfilled template placeholder, now read `prorick` (the name was taken from the git identity — correct it if it should be something else)
- Outcome: `Accepted → Partially Implemented` (deployed and working against a scripted stream; not yet tried with a real key)

---

## Links

- Live page: https://prorick.github.io/my-AI-harness/
- Related code: `src/` (the page), `tests/`, `.github/workflows/pages.yml`
- Known compromises: `docs/TECHNICAL-DEBT.md`
- Founding brief: `docs/inbox/2026-11-12-2308-founding-brief-interactive.md`
