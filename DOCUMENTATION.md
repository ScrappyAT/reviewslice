# Reviewslice — Documentation

## Section 1: What This Is

Reviewslice is a small AI integration slice built around one flow. A signed-in user uploads one or more plain-text files of customer reviews; each file becomes a background job, and a worker sends the content to DeepSeek for analysis. The model returns structured data for each review — sentiment, a 1–5 rating, themes, complaints and a direct quote — and I don't trust any of it until my own application has validated it, including checking that the quote actually appears in the uploaded file. The user watches each job move through pending, processing, done or failed on a live-updating list. From a completed job they can pick one review and ask the model to draft a reply to that customer, which is a separate AI task running synchronously while they wait.

The scope is deliberately small. There is no landing page, no separate account system, no editing, sharing or exporting, and no manual retry button — if a user wants another analysis they upload the file again, and that is the only retry flow by design. Authentication is not rebuilt here either: I reused the auth system from Assessment 1, including the auth pages, verification codes and password reset, as the brief allows. The goal was never a complete review-management product. It was to build one AI workflow properly, including the parts that are easy to skip — background processing, validating what the model returns, honest job state, and what happens when it fails.

## Section 2: How To Run It

**Install:** Node.js — `node_modules/next/package.json` declares
`"engines": { "node": ">=20.9.0" }`, Next 16.3.4's own stated minimum; built and tested
on Node 24.16.0. Docker Desktop (or another way to run `docker compose`), and `npm`.

1. Clone the repository and install dependencies:
   ```
   npm install
   ```
2. Start the local Postgres database:
   ```
   docker compose up -d
   ```
   This starts a `postgres:17` container named `reviewslice-db`, exposed on host port
   **5436** (mapped to the container's 5432), with the user, password, and database
   name set in `docker-compose.yml`.
3. Copy the environment file and fill in the one real secret:
   ```
   cp .env.example .env
   ```
   Two variables, by name:
   - `DATABASE_URL` — the Postgres connection string. Already correct as copied: it
     matches the credentials `docker-compose.yml` sets for the container started in
     step 2, so no edit is needed for local development.
   - `DEEPSEEK_API_KEY` — from the DeepSeek platform
     ([platform.deepseek.com](https://platform.deepseek.com), account settings → API
     keys). Written in by hand, never generated or committed. The processing worker
     will fail every job until this is filled in; the web app itself runs without it
     (only the worker and the reply endpoint ever call DeepSeek).
4. Run the database migrations:
   ```
   npx prisma migrate dev
   ```
   This applies the three migrations in `prisma/migrations/` (the five imported auth
   tables, then `Job`/`ReviewResult`/`RawModelResponse`, then `ReplyDraft`) against the
   database from step 2, and generates the Prisma client — there is no
   `postinstall` hook that does this automatically (see Section 6, problem 4), so this
   step cannot be skipped even if `npm install` already ran.
5. Start the web server:
   ```
   npm run dev
   ```
6. In a **second terminal**, start the worker — the slice does not work without both
   processes running at once, since the web server never calls DeepSeek itself:
   ```
   npm run worker
   ```
7. Visit **http://localhost:3000/signup**, create an account, and verify it with the
   code printed to the terminal running `npm run dev` (this project's `sendEmail()`
   logs to the console instead of sending real email — see `lib/email.ts`). After
   verifying, you land on **http://localhost:3000/upload**, the signed-in shell.

`.env` is git-ignored (`.gitignore`, `.env*` with `!.env.example`) and is never
committed; `.env.example` carries the two variables above with commented placeholders
and no real values.

## Section 3: The Flow, Step By Step

**Sign up and sign in.** Imported from Assessment 1, untouched:
`app/(auth)/signup/page.tsx` posts to `app/api/auth/signup/route.ts`, which creates a
`User` row and a `VerificationCode`, and logs the code via `lib/email.ts`.
`app/(auth)/verify/page.tsx` posts the code to `app/api/auth/verify/route.ts`, which
creates a `Session` (`lib/auth/session.ts`'s `createSession`) and redirects to
`/upload`. Every route under `/upload` is protected by `app/upload/layout.tsx`, which
calls `requireSession()` once; a signed-out request redirects to `/signin` before any
page content renders.

**Upload.** `app/upload/page.tsx` (a server component) reads the signed-in user's
existing jobs and renders `components/UploadWorkspace.tsx`, which renders
`components/UploadForm.tsx`. Choosing files and clicking Upload sends a
`multipart/form-data` `POST` to `app/api/upload/route.ts`. That route checks the
session, checks the per-user rate limit (`AI_RATE_LIMITS.uploadProcessing`,
`lib/ai/config.ts`), then loops over the files **independently**: each one is checked
for size (`MAX_UPLOAD_SIZE_BYTES`), emptiness, and type (`lib/storage.ts`'s
`isAcceptedFile` check inside the route), written to disk via
`lib/storage.ts`'s `writeUploadedFile` under a random storage key, and inserted as a
`Job` row with `status: "pending"` (the schema default). The route returns `200` with
a per-file breakdown — `queued` or `rejected` and why — never a claim that any file
has been processed. `UploadForm`'s `onUploaded` callback tells `UploadWorkspace` to
refresh the jobs list immediately.

**Processing (the worker).** `worker/index.ts` runs as its own process
(`npm run worker`), entirely separate from the web server. Every
`WORKER_POLL_INTERVAL_MS` (2 seconds) it calls `pollOnce()`, which computes how many
free concurrency slots it has (`CONCURRENCY_CAP` minus jobs currently in flight),
reads that many oldest-`pending` jobs (`claimNextJobs`, ordered by `createdAt`), and
claims each with a conditional `updateMany` (`status: "pending"` in the `where`) so
two workers racing on the same row can't both win. For each claimed job, `runPipeline`
reads the file (`lib/storage.ts`'s `readUploadedFile`) and calls `runExtractor()`
(`lib/ai/provider.ts`) up to twice. Each real response is validated
(`lib/ai/validate.ts`'s `validateExtractorResponse`) and recorded as a
`RawModelResponse` row; a valid response writes `ReviewResult` rows and marks the
`Job` `done` in one transaction; an invalid one on the first attempt retries with the
validation error appended to the prompt; a second failure — or a terminal provider
error — marks the `Job` `failed` with `errorMessage` set.

**Watching it happen.** `components/UploadWorkspace.tsx` polls
`app/api/jobs/route.ts`'s `GET` handler every `JOBS_POLL_INTERVAL_MS` (3 seconds) while any job
is `pending` or `processing`, and stops on its own once nothing is. Each job renders
via `components/JobListView.tsx` with one of four token-styled badges.

**The result.** Once a job is `done`, its row in the list links to
`app/upload/results/[jobId]/page.tsx`, which fetches the job **and its results**
scoped to the signed-in user in one query and renders each `ReviewResult` — sentiment,
rating, themes, complaints, and the quoted evidence, labeled as verified.

**The follow-up action.** On any review, `components/DraftReplyButton.tsx` posts to
`app/api/results/[reviewResultId]/reply/route.ts`, which checks the session, checks
the per-user rate limit (`AI_RATE_LIMITS.reviewReply`), fetches the review scoped to
the signed-in user, and calls `runResponder()` synchronously. A successful call is
persisted as a `ReplyDraft`; the response returns directly to the button, which
appends it to the list on the page — no job, no polling.

## Section 4: The Data Model

**Imported from Assessment 1** (`prisma/schema.prisma`, `prisma/migrations/20260914203957_init_auth`),
unmodified: `User` (email/password/name, `emailVerifiedAt` nullable until verified),
`Session` (a hash of the cookie token, never the raw token, with an indexed `userId`
and an `expiresAt` the lookup itself filters on), `VerificationCode` and
`PasswordResetToken` (both hashed-or-random, both time-boxed), and `RateLimitHit` (a
bare `key` + `createdAt`, reused by this project's own rate limits, not just the
imported auth's).

**`Job`** — one row per uploaded file.
- `storageKey String @unique` — the filesystem key, never the file. Unique because
  two jobs must never silently point at the same bytes on disk.
- `status String @default("pending")`, constrained by a hand-written `CHECK` (not a
  Prisma enum) to exactly `pending`/`processing`/`done`/`failed` — see below.
- `attempts Int @default(0)` — model-call attempts within one processing pass (the
  one allowed retry), capped at 2 in practice; not a whole-job re-run counter.
- `errorMessage String?` — null until failure, never cleared afterward.
- `promptTokens`/`completionTokens`/`cachedTokens Int?` — **nullable**, because a job
  can fail before any call ever completes (e.g. the file can't be read); `0` there
  would be a false claim about a call that never happened.
- `model String?` — the model ID actually used, an audit trail independent of
  whatever `lib/ai/config.ts` says today.
- `startedAt`/`completedAt DateTime?` — set at claim time and at done/failed
  respectively; both null on a still-`pending` row.

**`ReviewResult`** — one row per review extracted from a file, in `indexInFile` order.
- `sentiment String`, CHECK-constrained to `positive`/`negative`/`mixed`; `rating Int`,
  CHECK-constrained `BETWEEN 1 AND 5` — the same string-plus-check pattern as
  `Job.status`, for consistency, rather than a second native enum type.
- `themes String[]` / `complaints String[]` — Postgres native arrays, not JSON and not
  a separate table: the shape is already a validated array of strings before it
  reaches the database, and nothing in this project queries across reviews by theme.
- `quotedEvidence String` — checked in application code (`lib/ai/validate.ts`) against
  the uploaded file before this row is ever written; the database cannot verify a fact
  about a file that lives outside it.
- `@@unique([jobId, indexInFile])` — no two rows can claim the same position in the
  same file; this index doubles as "fetch all results for a job."

**`RawModelResponse`** — the unvalidated artifact a model call actually returned, kept
separate from `ReviewResult` so the trust boundary is structural. One row per
model-call attempt (up to 2), not one per job — a row existing at all means the
provider actually replied (nothing is written for a timeout); `validationError` is
null for the attempt that passed, populated for the one(s) that didn't.
`@@unique([jobId, attemptNumber])` prevents two rows claiming the same attempt.

**`ReplyDraft`** — the follow-up action's output, FK'd to `ReviewResult` (per review,
not per job — this action never touches the file). No status column and no `CHECK`
constraint: a row only ever exists after a successful synchronous call, so there is no
enum-like or range-bound value to constrain, and token columns are `NOT NULL` (unlike
`Job`'s) since a row that exists always has real usage behind it.

**Which constraints make an invalid state impossible:** a `Job` can never carry a
status outside the four defined ones, and a `ReviewResult` can never carry a sentiment
outside the three defined ones or a rating outside 1–5 — all three enforced by
Postgres `CHECK` constraints (`ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)`, added
by hand to the generated migration SQL), not application code alone. Two jobs can
never point at the same file (`Job.storageKey UNIQUE`). Two rows can never claim the
same position in a file, or the same attempt number for a job
(`@@unique([jobId, indexInFile])`, `@@unique([jobId, attemptNumber])`). No `Job`,
`ReviewResult`, `RawModelResponse`, or `ReplyDraft` row can exist without its required
parent — every foreign key is `NOT NULL` with `onDelete: Cascade`.

## Section 5: The Concepts

### What an API endpoint is

**What it is.** A URL plus an HTTP method that a client can call to make a server do
something and get a structured response back — in this project, a Next.js Route
Handler such as `app/api/upload/route.ts` exporting a `POST` function.

**Why it's needed.** The browser can't write files to disk, insert database rows, or
hold an API key; it needs a defined boundary to ask a trusted server to do those
things on its behalf, with the server deciding what's allowed.

**How I implemented it.** Every server action in this slice is one Route Handler:
`app/api/upload/route.ts` (`POST`), `app/api/jobs/route.ts` (`GET`), and
`app/api/results/[reviewResultId]/reply/route.ts` (`POST`), alongside the imported
auth endpoints under `app/api/auth/`. Each checks the session first, then does its one
job, then returns a JSON body and a real HTTP status — `401` signed out, `429` rate
limited, `404` not found, `200`/`502` for the reply action's outcome.

**What I chose against, and why.** A single catch-all API route dispatching on a body
field, which some smaller apps use to avoid route-file sprawl. Rejected: it would mean
one file mixing upload validation, job-list querying, and reply-drafting logic behind
a string switch, instead of three files each doing one thing — worse for exactly the
kind of "explain why this line exists" scrutiny this project is built for.

### SDKs versus raw HTTP, and why official SDKs

**What it is.** An SDK is a library that wraps a provider's raw HTTP API — building
request bodies, parsing responses, retrying transport failures — so calling code
works with typed functions instead of hand-built `fetch` calls and manual JSON
parsing.

**Why it's needed.** Raw HTTP means reimplementing request-shape details, auth
headers, retry/backoff, and error-body parsing by hand, and re-discovering the
provider's exact conventions every time something changes. An official SDK carries
that maintenance burden instead of this codebase.

**How I implemented it.** DeepSeek has no branded TypeScript SDK. The brief permits
using "a compatible official SDK pointed at their endpoint" where a provider has none
for the platform, and DeepSeek's own documentation confirms this is the supported
path: their quick-start installs the official OpenAI SDK and points its `baseURL` at
`https://api.deepseek.com` (verified live against `api-docs.deepseek.com`,
`DOC/deepseek-verification.md`). `lib/ai/provider.ts` is the only file that imports
`openai` — confirmed by search, nothing else in the codebase does — and `openai` is
pinned to an exact version (`7.15.0`, `package.json`), not a caret range, since
DeepSeek only guarantees request-*shape* compatibility, not that every new SDK
behavior has been tested against their endpoint. One concrete consequence of using a
generic SDK against a specific provider: it ships its own default retry policy
(`maxRetries: 2`) for transient failures, which would silently run underneath the
worker's own retry decision if left alone. Every call disables it explicitly:

```ts
const NO_SDK_RETRY = { maxRetries: 0 } as const;
// ...
const response = await client.chat.completions.create(params, {
  timeout: TIMEOUT_MS.extractor,
  ...NO_SDK_RETRY,
});
```

Without this, a single `runExtractor()` call could silently make up to three real
HTTP requests before the worker even sees an outcome to classify — invisible retries
underneath the one the worker is actually deciding on. `lib/ai/provider.ts` also
patches around one more gap the SDK's own types don't cover: `thinking`, DeepSeek's
own parameter, isn't declared on `ChatCompletionCreateParamsNonStreaming` at all
(confirmed by reading the installed SDK's own `.d.ts` files, not assumed) — handled by
building a typed superset of the SDK's params and passing it as a variable, so
TypeScript's excess-property check (which only fires on object literals) doesn't force
a blanket `any`.

**What I chose against, and why.** Raw `fetch` calls against DeepSeek's HTTP API
directly. Rejected because the brief explicitly permits the SDK path and DeepSeek's
own docs confirm it as their intended integration for this platform — raw HTTP would
mean reimplementing request/response handling the SDK already does correctly, for no
benefit, and would be exactly the kind of unofficial, unsupported path the brief warns
against ("Official SDKs only").

### System prompts versus user prompts

**What it is.** The system prompt is fixed instruction text describing the model's
role and output contract for every call of that kind; the user prompt (here, the
uploaded file's text, or a structured summary of one review) is the actual input the
role is asked to act on for one specific call.

**Why it's needed.** Without a stable, separately-authored system prompt, the "rules"
of the task would have to be re-stated or re-inferred inside every user message, and
inlining them as a string literal inside a handler would mean the actual instructions
given to the model are buried in call-site code rather than reviewable on their own.

**How I implemented it.** Two roles, two files, both plain exported string constants:
`lib/ai/prompts/extractor.ts` (`EXTRACTOR_SYSTEM_PROMPT`) and
`lib/ai/prompts/responder.ts` (`RESPONDER_SYSTEM_PROMPT`) — neither inlined into
`lib/ai/provider.ts`, the module that actually calls the model. The extractor's system
prompt spells out the exact JSON shape and an example; the user message is just the
uploaded file's raw text. The responder's system prompt describes the reply-writing
role; its user message is a formatted summary built from the already-validated review
fields (`lib/ai/provider.ts`'s `formatReviewContext`), never the original review text.

**What I chose against, and why.** A single shared system prompt with a "mode" flag
the code switches on, which would be less duplication on paper. Rejected: the brief is
explicit that the two roles are "genuinely different jobs, not the same prompt
reworded" — extraction is classification with no prose, replying is prose with no
structure — and a single prompt trying to serve both would be vaguer at both jobs than
two short, purpose-built ones.

### Model parameters

**What it is.** The per-call settings that shape how a model generates: how much
randomness (temperature), how many tokens it's allowed to spend (the output cap), and
whether it reasons before answering (thinking mode).

**Why it's needed.** The same model can behave very differently depending on these —
left at defaults, a classification task can drift non-deterministically and a
short-reply task can ramble or reason at length for no visible benefit, at real
token cost either way.

**How I implemented it.** All in `lib/ai/config.ts`, one value per role, each with its
own one-line reason beside it — never hardcoded in a handler:

```ts
export const TEMPERATURE = {
  extractor: 0,    // classification + verbatim quoting want determinism
  responder: 0.7,  // template-identical replies are worse than varied ones
} as const;
```

`temperature: 0` for the extractor because it classifies (sentiment, rating, themes)
and quotes text verbatim — the goal is the same review getting the same answer every
time, and any randomness only adds surface area for the model to drift off the literal
quote `quotedEvidence` depends on. `0.7` for the responder because a reply is prose
meant to read like it was actually written for this reviewer — at `0`, every reply to
a similar complaint would come out sounding identical, which is a worse outcome than
some natural variation, while staying well under `1` so it doesn't wander off-topic.
Thinking mode is **off for both roles** (`THINKING_ENABLED`, same file): off for the
extractor because its job is "no prose" — a single JSON object already pinned down by
a schema, which thinking doesn't help comply with, while adding billed reasoning
tokens and, per DeepSeek's own documented quirk, raising the odds of empty content.
`MAX_OUTPUT_TOKENS` is `8192` for the extractor (sized for several dozen small
per-review objects) and `512` for the responder (a few sentences, capped well above
what's needed without inviting a runaway generation).

**What I chose against, and why.** Thinking mode **on** for the responder was
seriously considered, not dismissed by default — DeepSeek's own docs suggest reasoning
can improve a model's engagement with a specific complaint before drafting. It was
dropped for one reason, stated plainly: I have no measured reasoning-token overhead
for this model on this task, and inventing a plausible-sounding number to justify it
would be exactly the fabrication the brief warns against, just moved into a
config comment instead of a cost table. `THINKING_ENABLED.responder` stays `false`
until a real measurement exists to weigh against the cost.

### Structured output and schema validation

**What it is.** Asking the model for output in a specific machine-readable shape, then
independently checking that what came back actually matches that shape before trusting
it — as opposed to parsing free text with string operations and hoping.

**Why it's needed.** A model returning `positive`/`negative`/`mixed` and a 1–5 integer
as fields in JSON gives code something to parse deterministically; a model asked to
"describe the sentiment in a sentence" gives code prose to guess at. But requesting
JSON is not the same as guaranteeing it: DeepSeek's JSON mode (verified against their
own docs, `DOC/deepseek-verification.md`) is **`json_object` mode only** —
`response_format: { type: "json_object" }` — with no `json_schema` parameter and no
schema-enforcement mechanism of any kind. It guides the model toward valid JSON; it
does not constrain the shape, types, or values inside it. So the zod validation in
this project's own code (`lib/ai/schema.ts`, `lib/ai/validate.ts`) is not a backstop
behind provider-side enforcement — it is the *only* check that exists.

**How I implemented it.** The schema, declared once:

```ts
export const ReviewSchema = z.object({
  sentiment: z.enum(["positive", "negative", "mixed"]),
  rating: z.number().int().min(1).max(5),
  themes: z.array(z.string().min(1)),
  complaints: z.array(z.string().min(1)),
  quotedEvidence: z.string().min(1),
});
```

`validateExtractorResponse()` (`lib/ai/validate.ts`) runs it after checking the
response isn't empty and is parseable JSON, and distinguishes five failure reasons —
`empty`, `not_json`, `shape_invalid`, `out_of_range`, `hallucinated_quote` — because
the retry message fed back to the model differs by reason. The last one is the check
no schema of any kind could perform: `quotedEvidence` must be a **literal substring**
of the uploaded file, verified by re-reading the file (never trusted from the model's
own claim). The comparison normalizes exactly two things before comparing — whitespace
runs (a review that wraps across lines and comes back as one line hasn't been
paraphrased) and curly/smart quotes (a common, cosmetic model habit) — and nothing
else: not case, not spelling, not any other punctuation, because those two are the
only differences that are about how text is *encoded* rather than what it *says*. What
that tolerance costs: in principle a fabricated quote that happened to differ from
real text only by whitespace or quote style could slip through as "close enough." In
practice a hallucinated quote is invented content, not a reformatted real one — the
cost is theoretical, not an observed failure mode.

**When validation fails:** exactly one retry, with the validation error text appended
to the original file as additional context (`worker/index.ts`'s `buildRetryMessage`);
a second failure marks the job `failed` with that error stored on the row, never a
hand-written fallback object.

**What I chose against, and why.** Trusting `response_format: json_object` alone and
skipping the zod pass, since DeepSeek nominally requests JSON. Rejected outright:
DeepSeek's own docs warn the API can return empty content even in this mode, and
nothing about the mode stops a well-formed JSON object from containing an out-of-range
rating or an invented quote — the brief's "excellent" band exists specifically to
reward not making this mistake.

### Jobs and workers

**What it is.** A job is a database row representing one unit of background work with
its own status; a worker is a separate, long-running process that finds pending jobs
and does the actual work, independently of any web request.

**Why it's needed.** A model call can take from a couple of seconds to the better part
of a minute. Doing it inside the HTTP request that triggered it means that request —
and the browser tab waiting on it — blocks for that whole time, for every file in a
multi-file upload; a background job means the upload request can return immediately
and the actual processing happens on its own schedule.

**How I implemented it.** `app/api/upload/route.ts` never imports or calls
`runExtractor()` — the loop inside it only validates, writes the file to disk, and
creates a `Job` row with `status: "pending"` (the schema default), then returns. The
only code that ever calls `runExtractor()` for a real upload is `worker/index.ts`, a
separate process started with its own command (`npm run worker`), polling on
`WORKER_POLL_INTERVAL_MS` (2 seconds). It claims a job with a conditional update — `set
processing where the row is still pending`, checking the returned count — not a
`SELECT` followed by a trusted `UPDATE`:

```ts
const result = await prisma.job.updateMany({
  where: { id: candidate.id, status: "pending" },
  data: { status: "processing", startedAt: new Date(), attempts: 1 },
});
if (result.count === 1) { /* this call actually won the claim */ }
```

The `WHERE` clause carries the "still pending" condition into the same statement that
writes the change, so two workers racing on the same row can't both believe they won.

**What I chose against, and why.** A `setTimeout` or an in-request "fire and forget"
call from the upload route, which would technically return before the model call
finishes. Rejected: that pattern ties the background work to the lifetime of the
request/server process that happened to receive the upload, with no separate
observable state, no restart-safety, and no way to bound concurrency across multiple
uploads — exactly the shape the brief names as the thing not to build.

### Queues, FIFO, and why concurrency is capped

**What it is.** A queue is an ordered backlog of work waiting to be done; FIFO
(first-in, first-out) means the oldest waiting item is served next. A concurrency cap
bounds how many items are worked on *at once*, independent of how many are queued.

**Why it's needed.** Without a cap, uploading many files at once would fire one
provider call per file simultaneously — fifty files, fifty concurrent calls, fifty
times the instantaneous cost and load. A queue with no ordering guarantee could also
starve early uploads behind later ones indefinitely.

**How I implemented it.** The `Job` table *is* the queue — no separate queue library,
per the brief's own instruction. FIFO ordering comes from `claimNextJobs()`
(`worker/index.ts`) reading candidates `orderBy: { createdAt: "asc" }` before claiming
any of them. The cap is enforced in exactly one place, `pollOnce()`:

```ts
const freeSlots = CONCURRENCY_CAP - activeCount;
if (freeSlots <= 0) return; // claim nothing new this cycle
const jobs = await claimNextJobs(freeSlots);
```

`activeCount` increments synchronously as the first line of `processJob()`, before any
`await`, so by the time a poll cycle finishes claiming, the count is accurate for the
*next* cycle's `freeSlots` calculation. At the cap, the worker simply claims nothing
new that cycle — already-running jobs continue, everything else stays `pending`,
untouched, until a slot frees up. This was demonstrated, not asserted: uploading six
files at once against `CONCURRENCY_CAP = 3` produced `evidence/concurrency-cap-holding.png`,
three status snapshots taken seconds apart showing exactly 3 jobs `processing` and 3
still `pending`, then the second three starting only once the first three completed.

**What I chose against, and why.** A cap derived from DeepSeek's own account
concurrency ceiling (2,500 requests for `deepseek-flash`, per
`DOC/deepseek-verification.md`). Rejected: that number is nowhere near a real
constraint at this project's scale, and using it as the cap would mean uploading fifty
files fires fifty simultaneous calls — technically under DeepSeek's ceiling, but
exactly the cost-and-load problem this cap exists to prevent. `CONCURRENCY_CAP = 3` is
deliberately small so the cap's effect is visible and demonstrable, not just true in
principle.

### Rate limiting as a cost control

**What it is.** A ceiling on how many times an action can be triggered by one
identity within a time window, independent of whether any single call is expensive on
its own.

**Why it's needed.** Every processed file and every drafted reply costs real money.
Concurrency caps bound *simultaneous* cost; rate limiting bounds *repeated* cost over
time — a user (or a script acting as one) hammering the upload button a thousand times
in an hour is a cost problem the concurrency cap alone doesn't address, since each
individual request is well-formed and eventually gets its turn.

**How I implemented it.** Both the upload endpoint and the follow-up action are
authenticated, so both are rate-limited by user, reusing the `RateLimitHit` table and
`checkRateLimit()` already in the imported auth slice (`lib/rate-limit.ts`) — not a
second mechanism. The limits themselves live in `lib/ai/config.ts`
(`AI_RATE_LIMITS.uploadProcessing` and `.reviewReply`, both `20` per rolling hour, keyed
`upload:user:<id>` / `reply:user:<id>` in `app/api/upload/route.ts` and
`app/api/results/[reviewResultId]/reply/route.ts` respectively) — distinct from the
imported auth slice's own `RATE_LIMITS` (signin/signup/etc.), which is untouched, since
those values were imported "as committed" and aren't this project's to change. A
blocked request gets `429` with a `Retry-After` header naming the real number of
seconds until the oldest hit in the window ages out.

**What I chose against, and why.** Keying the limit by IP instead of, or in addition
to, user — the pattern the imported signin/signup endpoints use, for a different
reason (an unauthenticated endpoint has no user yet to key by). Both the upload and
reply endpoints require a session, so the user ID is already a stable, spoof-resistant
identity; adding an IP dimension on top would only matter for multi-tenant abuse
scenarios (one IP, many accounts) that aren't this project's threat model — this is a
cost control on a known, authenticated caller, not an anti-abuse system for anonymous
traffic.

### Why files live in object storage rather than the database

**What it is.** Object storage means uploaded file bytes live in a storage system
built for holding files (a cloud bucket in production; this project's documented local
equivalent is the filesystem), and the database holds only a reference — a storage key
— that resolves to that file, never the bytes themselves.

**Why it's needed.** Databases are built to index and query structured rows quickly;
they are not designed to serve or stream large binary or text blobs efficiently, and
every backup, replica, and query touching that table would carry the weight of every
file ever uploaded. Keeping files out of the database entirely, rather than storing
them and hoping nothing depends on that, was one of the brief's own named traps.

**How I implemented it.** `lib/storage.ts` is the only module that writes, reads, or
deletes an uploaded file, using a directory computed as a sibling of the project
(`UPLOAD_STORAGE_DIR`, `lib/ai/config.ts`: `path.resolve(process.cwd(), "..",
"reviewslice-uploads")`) — outside the repository and outside `public/`, the
documented local-development equivalent of object storage the brief explicitly
permits. The storage key format is `<userId>/<32 random hex characters>.txt`:

```ts
export function buildStorageKey(userId: string): string {
  return `${userId}/${randomBytes(16).toString("hex")}.txt`;
}
```

Random, not the original filename, so a hostile filename — `../../etc/passwd`, say —
can never influence the disk path; the original name is kept separately, as
`Job.originalFilename`, purely for display. `Job.storageKey` is `@unique` in the
schema: two jobs can never point at the same file. That the database really holds
only this key, and never file content, is what `evidence/jobs-table-success-and-failure.png`
shows directly in the `Job` table's `storageKey` column.

**What I chose against, and why.** Storing the file as a `bytea`/text column on `Job`
directly, which would have been less code. Rejected as exactly the trap the brief
names by name ("Storing the uploaded file in the database"), and for a concrete
reason beyond the rule itself: uploaded reviews are customer-authored text that could
contain anything a real customer wrote, and minimizing where that content lives (one
filesystem directory, not every database backup and replica) is a real property worth
having independent of the brief's instruction.

### Your cost model

**What it is.** A concrete accounting of what one unit of work costs in real provider
billing, and what mechanisms bound the total the system could ever cost.

**Why it's needed.** "It calls an API" is not a cost model; a number is. Provider
pricing usually varies by time of day, cache state, and token volume, and none of that
is visible without actually measuring it against real calls.

**How I implemented it.** Real numbers, not estimates, from `DOC/deepseek-verification.md`
(verified against DeepSeek's pricing page on 14 September 2026) and this project's own
live calls. `deepseek-flash` (both roles, `MODELS`, `lib/ai/config.ts`) prices per 1M
tokens: cache-miss input **$0.30 peak / $0.15 off-peak**; output **$1.20 peak / $0.60
off-peak**; cache-hit input **$0.006 peak / $0.003 off-peak**. Peak is 01:00–04:00 and
06:00–10:00 UTC, Monday–Friday; off-peak is everything else, including all weekend
hours, at exactly half of peak. Real, observed extraction cost: a genuine four-review
file cost **505 prompt tokens and 263 completion tokens** in one recorded call — within
the roughly 500 prompt / 260–370 completion range seen across several similar test
files, the range reflecting ordinary variation in review length and count, not a
different code path. A drafted reply cost **243 prompt tokens and 53 completion
tokens** — at off-peak pricing, **≈ $0.000068**. A second, near-identical call hit the
cache at **256 cached tokens**, priced at the roughly 50x-cheaper cache-hit rate for
that portion — cache hits are real and measured here, not assumed.

What caps the total, concretely: `AI_RATE_LIMITS` bounds how often any one user can
trigger an extraction or a reply at all (20/hour each, `lib/ai/config.ts`);
`CONCURRENCY_CAP` (3) bounds how many calls can be in flight, and therefore billed,
simultaneously; `MAX_UPLOAD_SIZE_BYTES` (1MB) bounds how large — and therefore how
token-expensive — any single extraction call can be. Together these bound worst-case
spend per user per hour to a small, calculable multiple of one file's real cost, not
an open-ended number.

**What I chose against, and why.** Estimating cost from published per-token prices
alone, without ever making a real call. Rejected: `DOC/deepseek-verification.md`
found that DeepSeek's cache-hit discount is roughly 50x the cache-miss rate — a real
number that only shows up by actually triggering a cache hit and reading the usage
object back, not by reading a pricing page and assuming a flat per-token cost.

## Section 6: What Went Wrong

**1. Every tutorial's model name was wrong, and training data wouldn't have caught it.**

*Symptom:* none, yet — this was caught before it became one, because AGENTS.MD
required verifying the provider against live documentation before writing any
integration code, rather than trusting recalled model names.

*Investigation:* fetched `api-docs.deepseek.com` live and cross-checked the model
identifiers against what would otherwise have been assumed (`deepseek-chat`,
`deepseek-reasoner` — the names in effectively every existing tutorial, and in
training data itself).

*Cause:* `deepseek-chat` and `deepseek-reasoner` were retired 24 July 2026, 15:59 UTC.
Calls to the old names aren't routed anywhere.

*Fix:* `deepseek-flash` and `deepseek-v4-pro` are the only current model IDs
(`DOC/deepseek-verification.md`), and are what `lib/ai/config.ts`'s `MODELS` actually
uses. The dead end that mattered here was implicit, not a wasted attempt: without the
explicit instruction to verify, the natural path was to just use the familiar names
and discover the failure only once a real call was attempted.

**2. The usage object lied about where the numbers were, by omission.**

*Symptom:* the field `lib/ai/provider.ts` reads for cached tokens
(`prompt_cache_hit_tokens`) worked, but a review of the OpenAI SDK's own installed
type definitions (`node_modules/openai/resources/completions.d.ts`) showed no such
field declared anywhere on `CompletionUsage` — only its own convention,
`prompt_tokens_details.cached_tokens`.

*Investigation:* the dead end was assuming the SDK's own types described DeepSeek's
actual response payload, since the SDK is "compatible." Logging one real, live
response (not reading documentation) showed the truth: DeepSeek sends the cache-hit
count in **both** places at once — its own top-level `prompt_cache_hit_tokens` *and*
mirrored into OpenAI's nested `prompt_tokens_details.cached_tokens`. Separately, the
same live response showed `completion_tokens_details` **absent from the payload
entirely** when thinking mode produced no reasoning content — not present with
`reasoning_tokens: 0`, simply not there as a key.

*Cause:* "compatible" SDK types describe the request/response *shape* the SDK
expects to send and parse; they don't describe every field a differently-behaved
provider actually returns.

*Fix:* `lib/ai/provider.ts` reads the top-level field with its own narrow
`DeepSeekUsage` type rather than trusting `OpenAI.CompletionUsage` to have one, and
both `DOC/deepseek-verification.md` and the code comment were corrected after the
live call, not left describing only what the docs implied.

**3. A stale worker process, still alive from an earlier terminal, silently
invalidated a test — and then proved its own fix.**

*Symptom:* a deliberately-forced retry test (temporarily lowering the extractor's
output-token cap to force a real truncated-JSON failure) came back showing the job had
succeeded normally, with no truncation at all.

*Investigation:* the first assumption was a bug in the retry logic itself. It wasn't:
checking running processes showed **two** `worker/index.ts` processes alive at once —
an earlier one that a `pkill` command had failed to actually terminate on Windows,
still holding the *old*, un-truncated config, and a freshly-started one holding the
new, forced-failure config. The stale process won the race to claim the test job
before the new one could.

*Cause:* `pkill -f "worker/index.ts"` did not reliably match/kill the process tree
`npm run worker` spawns on Windows; a second worker was accidentally running.

*Fix:* stopped every matching `node.exe` process explicitly by PID via PowerShell,
confirmed exactly one worker was running, and reran the test — which then reproduced
the real forced-failure sequence correctly (two `RawModelResponse` rows, `attempts:
2`, job marked `failed`; see `evidence/worker-retry-then-fail.png`). This is also, by
accident, a live demonstration of exactly the property the race-safe conditional
claim (`worker/index.ts`'s `claimNextJobs`) exists to protect against: two workers
racing on the same row, with only one allowed to win.

**4. A stale, unregenerated Prisma client produced a type error that looked like a
real code bug.**

*Symptom:* `npx tsc --noEmit`, run early in the project on the freshly-imported auth
code, reported `Property 'PrismaClientKnownRequestError' does not exist on type
'typeof Prisma'` inside `app/api/auth/signup/route.ts` — code that had not been
touched and was imported as working.

*Investigation:* the dead end was suspecting the imported route itself, or a Prisma
version mismatch in `package.json`. Neither was true. Inspecting the actual generated
client on disk (`node_modules/.prisma/client/default.js`) showed a **65-line stub** —
far too small to be a real generated client for a five-model schema.

*Cause:* the committed `node_modules` (or an earlier partial install) had a
`@prisma/client` generated against an incomplete or absent schema state, before the
auth models existed in `prisma/schema.prisma` in this repository.

*Fix:* running the first migration (`npx prisma migrate dev`) regenerates the client
as its final step; the error disappeared without touching the route file at all,
confirming it was never a code bug.

## Section 7: What This Slice Does Not Handle

**Outside the brief, by design:**

- No editing, sharing, exporting, or manual retry/reprocessing — the brief names all
  of these explicitly as out of scope, and re-uploading a file is the only "retry"
  this project offers.
- The responder never receives the original review text, only the validated fields
  (`ReviewContext`: sentiment, rating, themes, complaints, `quotedEvidence` —
  `lib/ai/provider.ts`) — this was a deliberate step 5 decision, confirmed unchanged at
  step 11 by reading the code, not assumed. What it costs: a reply can only ever be as
  specific as what survived extraction into those five fields — a detail the
  extractor didn't turn into a theme or complaint is invisible to the responder, no
  matter how present it was in the original review.
- Auth (signup, signin, verification, password reset) is imported by hand from
  Assessment 1, stated plainly, not rebuilt. One visible seam from that: the
  signin and signup pages (and the rest of `app/(auth)/`) use their own Tailwind
  utility classes (`bg-blue-600`, plain grays) rather than this project's Material
  design-token system — two palettes exist side by side in the repository, on
  purpose, because the auth pages were committed "as such." One further, purely
  cosmetic change was made in those five files anyway: `cursor-pointer` was added to
  their buttons, fixing a Tailwind v4 default change (v3's automatic pointer cursor on
  buttons was removed), and nothing else in those files was touched.

**Ran out of scope for a slice this size, or genuinely untested:**

- A worker process that dies mid-job leaves that job's row at `status: "processing"`
  forever — there is no reclaim mechanism (not built, deliberately, per AGENTS.MD).
  The jobs list view (`components/JobListView.tsx`, `lib/jobs.ts`) flags a
  `processing` job as possibly stuck once it's been that way far longer than any
  genuine attempt sequence could take (`STUCK_PROCESSING_THRESHOLD_MS`, derived from
  the timeout and retry count, not guessed) — which is the honest limit of what a
  view can say without a reclaim feature behind it. Before real users, this would need
  a heartbeat or staleness-based reclaim so a dead worker's jobs actually recover.
- `Job.errorMessage` is free text, and the user-facing mapping
  (`lib/failure-messages.ts`) matches it by string prefix, because there is no
  structured failure-reason column. A future wording change in `worker/index.ts` or
  `lib/ai/validate.ts` would silently fall through to the generic "something
  unexpected went wrong" message rather than erroring loudly. A structured
  `failureReason` enum column on `Job` would fix this properly; it wasn't built here.
- The reviews in this project's evidence are synthetic — written for testing, not
  scraped or real customer data. Real reviews would be messier in ways this slice has
  never been tested against: inconsistent formatting, mixed or non-English language,
  spam, or text that isn't about the product at all.
- The upload storage directory is a sibling of the project directory, computed from
  `process.cwd()` — a fresh clone writes files into a folder next to itself on first
  upload, which is fine for local development but is explicitly documented
  (`lib/ai/config.ts`) as the local equivalent of object storage, not a production
  design.
- Two of the documented provider outcomes were never actually observed against the
  live API in this project: a genuine empty-content response occurring naturally
  (only reproduced by deliberately forcing it with an artificially tiny token cap),
  and a real `429`/`500`/`503` from DeepSeek. Both code paths exist and are reasoned
  through from DeepSeek's own documentation (`DOC/deepseek-verification.md`), not from
  having actually triggered them.

## Section 8: If I Built This Again

The main thing I would change is how I store job failures. Right now, `Job` has an `errorMessage` field that stores the failure as free text. That seemed reasonable when I first built it — one field could hold the error I needed for debugging as well as the message I wanted to show the user. The problem showed up later, when I needed to turn those errors into safe, user-friendly messages. I ended up checking the beginning of the error string in `lib/failure-messages.ts` and mapping different prefixes to different messages. That works, but it's fragile: if the wording of one of those errors changes somewhere upstream, the mapping can stop matching and quietly fall back to the generic message without making it obvious. If I were building this again, I'd add a separate `failureReason` field from the start — `file_read`, `timeout`, `provider_error`, `empty_content`, `schema_invalid`, `hallucinated_quote` — so `errorMessage` could stay as the detailed technical information while `failureReason` told the application exactly what kind of failure happened. The user-facing code could then switch over known reasons instead of trying to work out what happened by reading the wording of an error message. It's a small change, but it would make the failure handling far more predictable. Looking back, I should have made that decision at the same time I introduced the `status` field. Status is structured because the application makes decisions based on it. The failure reason should have been treated the same way.

---

## Evidence

The seven files in `evidence/` map to the brief's five required items as follows:

| Brief requirement | File(s) |
|---|---|
| Jobs table showing a successful run and a failed run, error message visible on failure | `evidence/jobs-table-success-and-failure.png`, `evidence/failed-job-error-message.png` |
| Raw model output for one request alongside the validated, parsed result | `evidence/raw-model-output.png`, `evidence/validated-review-results.png` |
| What happens when validation fails, deliberately produced | `evidence/raw-model-responses-retry.png`, `evidence/worker-retry-then-fail.png` |
| Concurrency cap holding, provider request pattern | `evidence/concurrency-cap-holding.png` |
| Database holds only a storage key, not the file | `evidence/jobs-table-success-and-failure.png` (the `storageKey` column) |

`jobs-table-success-and-failure.png` does double duty, honestly: it's the same table
view that shows both the pass/fail evidence and the storage-key-only evidence at once,
not two separate captures contrived to look distinct.
