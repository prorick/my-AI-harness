<!-- adr template version: "adr-madr 3.12.0" -->
<!-- kept in deliberate homage to MADR — Markdown Architectural Decision Records, the lineage this template family descends from. This is the simple-decisions form: use it when a decision needs recording, not discussion. The deliberation-native form is adr.md. Mint with `just adr "<title>" madr`. (Ruling: QST-MADR-FATE, 2026-08-13 — "keeping the template, acknowledging it, is good form.") -->

# Make the chat page an installable PWA that opens offline

- **Date**: 2026-11-12
- **Status**: Partially Implemented
- **Scope Remaining**: install it for real once — on a phone or from desktop Chrome — and confirm it opens in its own window and reopens offline. Built, deployed, and passing Chrome's own installability check; not yet installed by a person.
- **Deciders**: prorick (human — asked for it), Keel 5.2 (claude-fable-5-2 — chose how)

**TL;DR**: The page is now installable (manifest, icons, service worker) and opens without a network; the worker fetches from the network first and falls back to its saved copy, so a deploy is never hidden by a cache, and it never touches requests to OpenRouter.

Technical Story: "Can you make this a PWA (progressive web app)." — prorick, in conversation, 2026-11-12.

## Context and Problem Statement

The chat page works in a browser tab. prorick asked for it to be a progressive web app: something that can be installed and opened like an app. That needs three things the page did not have — a manifest, icons, and a service worker — and each had to fit the rules already set in ADR-0001: GitHub Pages only, no build step, a strict Content-Security-Policy, and an API key that must never end up anywhere but localStorage.

The request did not say what the app should do offline. The one useful thing an offline chat page can do is open, so that saved conversations can be read. How the service worker caches was the real decision.

## Decision Drivers

* A deploy must reach installed apps without anyone managing versions by hand — there is no build step to stamp file names.
* Nothing that carries the API key or a conversation may be cached.
* The page lives in a folder (`/my-AI-harness/`) of an origin it shares with prorick's own site and any other project pages; it must not disturb them.
* Stay small: no library, no generated code in the repo beyond the icon images.

## Considered Options

* Network first, cache as the offline fallback
* Cache first, with a version number bumped on every release
* Manifest and icons only — installable, no offline support

## Decision Outcome

Chosen option: "Network first, cache as the offline fallback", because it is the only one that gives offline opening without creating a way for an installed app to get stuck on old code. Online, the worker fetches every file from the network exactly as the browser would have; offline, it serves the last copy it saw.

What was built:

* `src/manifest.webmanifest` — name, standalone display, relative `start_url` and `scope` (so the app opens at `/my-AI-harness/`, and at whatever path a fork is served from).
* `src/icons/` — one SVG drawing and four PNGs made from it (192, 512, a maskable 512, and a 180 for iOS). They were generated once by `scripts/ephemeral/2026-11-12-make-pwa-icons.mjs` and committed.
* `src/sw.js` — the service worker. It answers only GET requests for this site's own files. Requests to OpenRouter never pass through it. On activation it deletes only caches whose names start with `my-ai-harness-shell-`.
* `src/index.html` — the manifest link, theme colours for light and dark, the iOS tags, and two additions to the security policy: `manifest-src 'self'` and `worker-src 'self'`. The network rule is unchanged: `openrouter.ai` only.
* An "Install app" button in the sidebar, shown only when the browser announces the page can be installed (Chrome, Edge). Safari and Firefox install from their own menus.

### Positive Consequences

* The page can be installed on desktop and phone and opens in its own window.
* With no network it still opens, and saved conversations can be read. Sending a message offline gives the existing "Could not reach OpenRouter" error.
* A deploy is live on the next online load. There is no version to bump.
* prorick's site at the origin root is untouched: the worker's scope is this project's folder, and it leaves other caches alone.

### Negative Consequences

* No speed gain: online, every load still goes to the network.
* The list of files to save for offline use is kept by hand in `src/sw.js`. A test (`tests/pwa.test.js`) fails if a file in `src/` is missing from it, so the gap cannot ship unnoticed, but it is one more place to edit when a file is added.
* The splash screen is dark in both colour schemes: a manifest has one background colour.
* Uninstalling the app does not delete the conversations; they stay in the browser's storage for the site.

## Pros and Cons of the Options

### Network first, cache as the offline fallback

* Good, because a deploy can never be hidden by a stale cache.
* Good, because nothing has to be versioned by hand.
* Bad, because loads are no faster than without a worker.

### Cache first, with a version number bumped on every release

* Good, because loads are instant after the first.
* Bad, because every release must bump the version, and a forgotten bump leaves installed apps on old code with no error anywhere — on a project with no build step to do it automatically.
* Bad, because the page's safety fixes would reach people only after the worker updates, one load late at best.

### Manifest and icons only

* Good, because it is the least code.
* Bad, because the installed app shows a browser error page when opened without a network, which is the opposite of what installing suggests.
* Bad, because some browsers have required a service worker before offering to install.

## Questions

NOT: no open questions — the request was a single instruction, the one real choice (how to cache) is recorded above with what would change it, and both it and the icon design are cheap to revisit. If loads feel slow on a phone, the caching choice flips to cache-first and gains a version step in the deploy workflow.

## Verification

* `tests/pwa.test.js` (7 tests) runs the real `src/sw.js` against a stand-in for the browser's cache: the offline list matches the files on disk, OpenRouter requests are never handled, offline requests are served from the saved copy, online requests are served fresh, and only this project's old caches are deleted. It also checks the manifest's icons exist at the sizes claimed and that the security policy lets the manifest and worker load.
* In headless Chrome (`scripts/ephemeral/2026-11-12-drive-chat-flow.mjs`, 38/38): the worker took control of the page, Chrome reported no manifest errors and no installability errors, and with the web server shut down a reload still opened the page with its saved conversation.
* Not verified: installing on a real phone or desktop, and how the installed app looks on iOS.

## Links

* Builds on [ADR-0001](0001-mission-and-architecture-a-static-chat-harness-on-github-pages.md) — the hosting, storage and safety rules this had to fit.
