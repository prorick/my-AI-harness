<!-- adr template version: "adr-madr 3.12.0" -->
<!-- kept in deliberate homage to MADR — Markdown Architectural Decision Records, the lineage this template family descends from. This is the simple-decisions form: use it when a decision needs recording, not discussion. The deliberation-native form is adr.md. Mint with `just adr "<title>" madr`. (Ruling: QST-MADR-FATE, 2026-08-13 — "keeping the template, acknowledging it, is good form.") -->

# Retry transient OpenRouter failures automatically

- **Date**: 2026-11-12
- **Status**: Partially Implemented
- **Scope Remaining**: see it work once on the deployed page against a real rate limit. The retry has been exercised against scripted failures only; a real one cannot be produced on demand.
- **Deciders**: prorick (human — asked for a default retry), Keel 5.2 (claude-fable-5-2 — chose the policy)

**TL;DR**: Rate limits, timeouts and provider errors are now retried up to three times with growing waits before the reader sees an error; the error prorick hit is the provider throttling OpenRouter's shared capacity for one model, not a limit on his key.

Technical Story: prorick, in conversation, 2026-11-12, with a screenshot — "Getting this error: openai/gpt-6-luna is temporarily rate-limited upstream. Please retry shortly, or add your own provider key to use your own limits […] Can you add a default retry. And also look into why I am getting this error now sometimes".

## Context and Problem Statement

A reply on the deployed page failed with OpenRouter's "temporarily rate-limited upstream" message. The page showed the raw message and a Retry link; nothing was retried. Two things were asked: retry by default, and find out why the error appears.

## What the investigation found

* **It is the provider's limit, not the key's.** OpenRouter's limits documentation says a 429 "can come from two places": OpenRouter's own platform limits, or "the upstream provider, when the provider serving your request is rate limiting or at capacity." The message names the second ("rate-limited upstream") and offers the remedy for it (your own provider key, with your own limits). On OpenRouter credits, "your rate limits for each provider are managed by OpenRouter" — everyone using that model through OpenRouter shares them.
* **OpenRouter had already tried the alternatives.** Its documentation says fallback routing "retries other providers for the same model automatically before the error reaches you." `openai/gpt-6-luna` is served from 8 endpoints (OpenAI, Azure, Amazon Bedrock); all 8 reported 100 % uptime over the previous 30 minutes when checked (public endpoints API, 2026-11-12). So this was a moment of exhausted shared capacity, not an outage — which is exactly the case a short wait fixes.
* **The error arrived inside a successful response.** OpenRouter answers 200 "as soon as the provider accepts the request", and a provider failure after that — even before the first token — arrives as an error event in the stream, with the status in `error.code`. The page only looked at the HTTP status, so it did not recognise this as a rate limit. That is why the screenshot shows the bare message with none of the page's own wording. This was a bug, fixed here, with a regression test.
* **Why "now, sometimes" — likely, not proven.** The model is about seven weeks old, cheap, and the one `openrouter/auto` is currently choosing for these messages, so demand on its shared capacity is high. The Think switch (ADR-0002) plausibly adds to it from this side: thinking makes each request use more tokens and run longer, and provider limits count tokens per minute as well as requests. I could not test that — it needs the account's own request history.
* **What I could not see.** Whether the key or its workspace has limits of its own. The message does not suggest it, and the docs state no shared request limit for workspace keys, but only the account can show it: the Activity page lists each provider's response per request, and `GET /api/v1/key` reports the key's limits and usage.

## Decision Drivers

* The common failure (a momentary provider limit) should not need the reader to do anything.
* A retry must never restart an answer that is already on screen.
* Failures that will fail again the same way (bad key, no credits, unknown model) must be reported at once.
* The reader stays in control: the wait is visible and Stop ends it.

## Considered Options

* Retry in the page, with backoff, before any answer text has arrived
* Leave it to the reader (the existing Retry link)
* Ask OpenRouter to fall back to other models (`models` list, or restricting the auto router)

## Decision Outcome

Chosen option: "Retry in the page, with backoff, before any answer text has arrived", because it handles the failure that was reported without changing which model answers, and it is what OpenRouter's own guidance asks of clients ("Retry with exponential backoff. Rate limits are transient").

The policy, in `src/js/openrouter.js` (`streamChatWithRetry`):

* **Retried**: 429, 408, and any 5xx — whether it arrives as the response status or inside the stream.
* **Not retried**: everything else (400, 401, 402, 403, 404), and anything at all once part of the answer has been shown.
* **How often**: up to 3 retries, so 4 tries in all.
* **How long**: about 1.5 s, 3 s, then 6 s, each varied by up to a quarter either way. If the server sends a `Retry-After` longer than that, it is honoured up to 20 s.
* **What the reader sees**: a muted line in place of the reply — "The model is rate-limited. Trying again (attempt 2 of 4)…" — and, if every try fails, the error with "Tried 4 times." An upstream limit is now described as the provider's, "not a limit on your key".
* **What is discarded**: thinking received from a failed try, and the model name it reported.
* Stop cancels the wait and the retry.

### Positive Consequences

* A momentary rate limit costs a few seconds instead of an error.
* Rate limits that arrive inside the stream are now recognised as such.
* With `openrouter/auto`, each retry is a fresh routing decision, so it may land on a different model.

### Negative Consequences

* When the limit lasts longer than about ten seconds, the reader waits those ten seconds and still gets the error.
* A failed try that had already produced thinking may have been billed for it; the retry bills again. Failed requests that produced nothing are not billed.
* Browsers hide `Retry-After` from the page unless the server exposes it to cross-origin scripts, and OpenRouter's CORS headers (checked 2026-11-12) do not list it. In practice the page's own backoff decides the wait.

## Pros and Cons of the Options

### Retry in the page, with backoff

* Good, because it fixes the reported case with no change to settings, cost model, or which model answers.
* Good, because the policy is one small function with no dependencies, tested against scripted failures.
* Bad, because it cannot help when the provider's limit lasts longer than the retries.

### Leave it to the reader

* Good, because it is already there and costs nothing.
* Bad, because it is what prorick asked to stop doing.

### Ask OpenRouter to fall back to other models

* Good, because a different model has different limits, so it works even when one model stays throttled.
* Bad, because it changes which model answers, silently, and the docs do not say whether a `models` list can be combined with `openrouter/auto`.
* Bad, because choosing the fallback list is a preference the page would have to ask for. Worth revisiting if retries turn out not to be enough.

## Questions

NOT: no open questions — the request was specific, and the choices made (which failures, how many tries, how long) are recorded above and are constants in one file. If rate limits keep getting through after four tries, the next step is a decision for prorick and would get its own question: a fallback model list, pinning a less contended default model, or a provider key of his own.

## Verification

* `tests/openrouter.test.js`: 7 tests on the retry policy and a regression test for the reported failure (a 429 inside a 200 stream, preceded by thinking). The regression test was confirmed to fail with the fix removed.
* In headless Chrome (`scripts/ephemeral/2026-11-12-drive-chat-flow.mjs`, 40/40): a reply that is rate-limited inside the stream on its first try shows the "trying again" note, then the answer, with two requests made and nothing kept from the failed try.
* Not verified: a real rate limit on the deployed page.

## Links

* Builds on [ADR-0001](0001-mission-and-architecture-a-static-chat-harness-on-github-pages.md) (the stream) and [ADR-0002](0002-show-the-models-thinking-a-collapsed-gist-that-expands-to-the-full-reasoning.md) (thinking, which a retry has to discard).
* OpenRouter documentation read 2026-11-12: https://openrouter.ai/docs/api-reference/limits , https://openrouter.ai/docs/api-reference/errors , https://openrouter.ai/docs/use-cases/byok
