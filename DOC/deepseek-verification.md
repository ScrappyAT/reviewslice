# DeepSeek Verification

Date checked: 2026-09-14. Sources are DeepSeek's own docs (api-docs.deepseek.com) fetched
live today — my training data ends January 2026, and DeepSeek retired its previous model
names in the gap between then and now, so nothing below is from memory. Every claim
below is what the docs said today; no code was written in this step.

## What you already had right

All of it checked out exactly as given:

- Base URL `https://api.deepseek.com`.
- Model IDs `deepseek-flash` (DeepSeek-V4.1-Flash) and `deepseek-v4-pro`
  (DeepSeek-V4-Pro-0813).
- Flash pricing per 1M tokens: cache-hit input $0.006 peak / $0.003 off-peak,
  cache-miss input $0.30 peak / $0.15 off-peak, output $1.20 peak / $0.60 off-peak.
  Concurrency 2,500.
- V4-Pro pricing per 1M tokens: cache-miss input $1.32 peak / $0.66 off-peak, output
  $3.96 peak / $1.98 off-peak. Concurrency 500.
- Peak window: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday. Off-peak (everything
  else, including all weekend hours) is exactly half of peak.
- Both models default to thinking mode on.
- Context length 1M tokens, max output 384K tokens, for both models.

One number you didn't have: **V4-Pro's cache-hit input price is $0.044 peak / $0.022
off-peak** — the docs don't headline it next to the cache-miss figure, easy to miss.

**Important context, not in your numbers:** `deepseek-chat` and `deepseek-reasoner` —
the names anyone would find in older tutorials, blog posts, or a model's own training
data — were retired 24 July 2026, 15:59 UTC. Calls to the old names are not routed
anywhere. `deepseek-flash` and `deepseek-v4-pro` are the only current IDs. This is
exactly the trap the brief's verification section exists to catch.

## 1. OpenAI SDK as the TypeScript path

Confirmed. DeepSeek's own "first API call" walkthrough installs the official `openai`
npm package (`npm install openai`) and points its `baseURL` at
`https://api.deepseek.com` — there is no DeepSeek-branded SDK for JS/TS, and the docs
don't suggest raw HTTP. This is the case the brief names explicitly: "where a provider
has none for your platform, use a compatible official SDK pointed at their endpoint."

DeepSeek's docs don't pin a version. `npm`'s current latest for `openai` is **7.15.0**
(checked today). When the provider module is actually built (step 5), pin an exact
version in `package.json` rather than a caret range — DeepSeek only guarantees
OpenAI-*request*-shape compatibility, not that every new SDK feature (e.g. newer
`Responses` API surface) behaves identically against their endpoint, so an unpinned
`^7.15.0` could silently pick up SDK behaviour never tested against DeepSeek.

## 2. Structured output mechanism

**`json_object` mode, not schema enforcement.** This is the load-bearing finding for
the whole validation design in AGENTS.MD.

The request sets `response_format: { type: "json_object" }`. There is no `json_schema`
parameter and no schema-parameter equivalent — DeepSeek's JSON Output guide describes
guiding the model with prompt content, not constraining it server-side:

- The word **"json" must appear** somewhere in the system or user message, or the API
  rejects the request.
- The docs recommend putting an **example of the desired JSON shape** directly in the
  prompt.
- `max_tokens` should be set generously enough that the JSON isn't cut off mid-object.
- DeepSeek's own docs warn: *"the API may occasionally return empty content. We are
  actively working on optimizing this issue."*

So: no, it cannot enforce a schema. Every field, type, and enum constraint in the
per-review shape (`sentiment`, `rating`, `themes`, `complaints`, `quotedEvidence`) is
carried entirely by the zod parse in step 6, not by anything DeepSeek does. The
"excellent" band's requirement — validate in your own code, don't rely on the
provider — isn't a stylistic preference here, it's the only validation that exists.
The documented empty-content quirk also argues for the retry path doing real work,
not just handling a hypothetical: an empty response is a schema failure (empty string
is not valid JSON), so it flows through the same one-retry-then-fail path as any other
validation miss.

## 3. Thinking mode: default, toggle, and billing

- **Default: on, at "high" effort**, for both models.
- **Toggle (OpenAI-format request, which is what this project uses):**
  `extra_body: { thinking: { type: "disabled" } }` to turn it off, or
  `{ type: "enabled" }` with a `reasoning_effort` of `"low" | "high" | "max"` to tune
  it. (The docs also show an Anthropic-format `reasoning: { effort: "none" | ... }` —
  irrelevant here since the OpenAI SDK is the chosen path.)
- **Billing: reasoning tokens are billed as output tokens.** They're reported inside
  `completion_tokens_details.reasoning_tokens`, which is a breakdown *of*
  `completion_tokens` — not additional to it, but not free either. A thinking-mode
  call that produces a short visible answer can still be expensive if the model reasons
  at length first; the visible reply is not a proxy for the bill.
- **Response shape:** the chain-of-thought is returned in a separate `reasoning_content`
  field, at the same level as `content`. One documented gotcha that doesn't affect this
  project but is worth recording: in multi-turn conversations, `reasoning_content` from
  a prior turn must be stripped before sending the next turn back, or the API 400s.
  Both this project's roles are single-shot (one file in, one structured result out;
  one review in, one reply out) — no conversation history is ever replayed, so this
  gotcha has nothing to attach to here.

## 4. Token usage in the response

Every `chat/completions` response includes a `usage` object:

- `prompt_tokens`, `completion_tokens`, `total_tokens` — the standard three.
- `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` — cached tokens **are**
  broken out separately, and `prompt_tokens = prompt_cache_hit_tokens +
  prompt_cache_miss_tokens`. This is exactly the split the cost model needs, since hit
  and miss tokens are priced roughly 50x apart.
- `completion_tokens_details.reasoning_tokens` — present when thinking mode produced
  reasoning content; a breakdown of `completion_tokens`, not separate from it (see
  above).

Recording token usage per job (an architectural decision already made) means storing
at minimum `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `completion_tokens`,
and `reasoning_tokens` when present — the flat `total_tokens` alone would blur cache
hits into cache misses and make the cost model in Section 5 wrong by roughly two
orders of magnitude on the input side.

## 5. Rate limits beyond concurrency

The docs specify **account-level concurrency only** — 2,500 for `deepseek-flash`, 500
for `deepseek-v4-pro` — counted as "in flight," i.e. a request holds its slot from
send until the response completes. There is no documented requests-per-minute or
tokens-per-minute ceiling on top of that. Exceeding the concurrency limit returns HTTP
429; the docs don't mention server-side queueing, so a request over the limit fails
rather than waiting. Higher limits are available on request ("capacity expansion") at
no listed extra cost.

This is a different thing from the app's own rate limiting (`RateLimitHit`, keyed by
user, on the upload-processing and reply endpoints) — that's a cost control on *our*
side, independent of DeepSeek's concurrency ceiling. The worker's own concurrency cap
(step 8, a small number — a handful of simultaneous provider calls) will sit far below
2,500 regardless of which model is chosen, so DeepSeek's ceiling is not something this
project's design needs to actively guard against; it's headroom, not a constraint.

## 6. Error responses

| HTTP status | Meaning | Retryable? |
|---|---|---|
| 400 | Invalid request body format | No — fix the request |
| 401 | Bad API key | No — fix the credential |
| 402 | Account out of balance | No — needs a human to top up |
| 422 | Invalid parameter value | No — fix the request |
| 429 | Rate/concurrency limit hit | Yes — back off and retry |
| 500 | DeepSeek server error | Yes — transient |
| 503 | DeepSeek overloaded | Yes — transient |

The 400/401/402/422 group is exactly the shape of error the retry-then-fail design in
AGENTS.MD should *not* retry — retrying a malformed request or an empty account balance
just spends the one retry on a call that will fail identically. The one-retry policy
already specified (validation failure, error fed back to the model) is about *our*
schema/hallucination check failing, which is a distinct failure mode from these
transport-level errors — a timeout or a 429/500/503 is a different, transient category
that a request-level retry legitimately helps with, while 400/401/402/422 are
terminal and should fail the job immediately with the real error message stored, not
consume the retry budget.

## Recommendation

**`deepseek-flash` for both roles.** The one real alternative is `deepseek-v4-pro`, and
the case against it is specific, not just "cheaper is better":

- **No documented capability gap for this task shape.** Both models support
  `json_object` mode, thinking mode, and the same 1M-token context / 384K-token output
  ceiling. V4-Pro isn't unlocking a schema mode or a longer context Flash lacks — the
  only differences the docs describe are price and concurrency.
- **Price gap is large and compounds with volume.** V4-Pro's cache-miss input is 4.4x
  Flash's peak-for-peak, and 4.4x off-peak-for-off-peak; output is 3.3x in both windows.
  The extractor runs on every uploaded file — this is the volume path, not the
  occasional one — so a 3–4x multiplier there is a 3–4x multiplier on the whole cost
  model in Section 5, for a task (classify sentiment, extract themes, find a literal
  quote) that doesn't need frontier-model reasoning depth to do reliably.
- **Lower concurrency ceiling (500 vs. 2,500) is a real downside, not just smaller
  headroom.** It doesn't bind today (the worker's own cap will be far below both
  numbers), but it's one less reason to pick the more expensive model when nothing
  about the task asks for it.

**Thinking mode: off for the extractor, on for the responder.** These are opposite
answers for a reason, not a default left alone in one case:

- **Extractor — off.** The role is explicitly "no prose": a single structured JSON
  object, following a shape already pinned down by the zod schema and the
  quoted-evidence check. Thinking mode doesn't help a model comply with a format it's
  already been told exactly how to fill in — it adds reasoning tokens (billed as
  output, per finding 3) and, per DeepSeek's own documented quirk, raises the odds of
  the exact failure mode this project can least afford quietly: an empty `content`
  field. An empty extraction response is indistinguishable from a truncated one and
  both cost a retry either way; turning off the more expensive, more failure-prone mode
  for a task it doesn't help is the straightforward call. If accuracy on the
  quoted-evidence check turns out to need it once real data is in front of it, this is
  a one-line config change (step 4), not a rebuild — flagging it now as one to revisit
  with evidence, not assuming the answer is permanent.
- **Responder — on (default).** The role is "prose": a short reply addressing what a
  specific reviewer actually said, triggered by one user click at a time and already
  rate-limited by that click, not by file volume. A reply that engages with the
  specific complaint rather than a generic template benefits from the model reasoning
  about what the review actually said before drafting — and the cost/latency of
  thinking mode on one short review at a time, gated behind a rate limit already, is a
  cost this project can afford in a way that "every review in every uploaded file"
  is not.

## Sources

- [Your First API Call](https://api-docs.deepseek.com/)
- [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [JSON Output](https://api-docs.deepseek.com/guides/json_mode)
- [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Rate Limits](https://api-docs.deepseek.com/quick_start/rate_limit)
- [Error Codes](https://api-docs.deepseek.com/quick_start/error_codes)
- [Change Log](https://api-docs.deepseek.com/updates/) (confirms the 24 July 2026
  retirement of `deepseek-chat` / `deepseek-reasoner`)
