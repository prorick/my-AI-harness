# Technical Debt

Architectural issues, workarounds, and design compromises found during development (see CLAUDE.md, "Technical Debt Tracking"). Each entry: issue, location, impact, workaround, fix, priority.

---

## Two tabs, one store

- **Issue**: The whole state is one localStorage entry, saved whole. Each open tab holds its own copy in memory. A tab adopts another tab's save through the `storage` event — except while it is streaming a reply, when it ignores the event and then saves its own copy when the reply ends.
- **Location**: `src/js/app.js` (the `storage` listener and `persist()`), `src/js/store.js` (`save`).
- **Impact**: With the page open in two tabs, a change made in tab B (a new message, a deleted conversation, a new key) while tab A is mid-reply is overwritten when A's reply finishes. Nothing is lost with one tab.
- **Workaround**: None in code. Use one tab while a reply is streaming.
- **Fix**: Save per conversation (one entry each, plus one for settings) and merge on the `storage` event instead of replacing; or coordinate tabs with a `BroadcastChannel` / Web Lock.
- **Priority**: Low — a single-user page, and the window is one reply long. Raise it if conversations move to IndexedDB or tools start writing to the store.

## Every streamed token re-renders the whole reply

- **Issue**: While a reply streams, its markdown is re-parsed and its DOM rebuilt from the full text on each animation frame.
- **Location**: `src/js/app.js` (`queuePaint`), `src/js/render.js`.
- **Impact**: Work per frame grows with reply length; a text selection inside the streaming reply is lost on each repaint. Not noticeable at ordinary reply sizes; not measured on very long ones.
- **Workaround**: Repaints are capped at one per frame.
- **Fix**: Re-render only the last block (earlier blocks are final once a blank line follows them).
- **Priority**: Low until someone reports a slow or janky long reply.

## The gate does not open a browser

- **Issue**: `just gate` runs the logic tests only. The page's wiring (`src/js/app.js`) and layout are checked by a hand-run driver, not by the gate or the deploy workflow.
- **Location**: `justfile` (`gate`), `.github/workflows/pages.yml`, `scripts/ephemeral/2026-11-12-drive-chat-flow.mjs`.
- **Impact**: A change that breaks sending, stopping, retrying or reloading can pass the gate and deploy.
- **Workaround**: Run the driver before changing `app.js` or `index.html` (instructions in its header). It needs Chrome and a local server.
- **Fix**: Promote the driver to a real test (it has no dependencies beyond Chrome, which GitHub's runners have) and add it to the workflow.
- **Priority**: Medium — do it before the page grows a second feature.
