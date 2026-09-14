# Project Context

## What this repository is

A single AI integration slice, built for Assessment 3 of a product engineering bootcamp.
The full brief is at `DOC/assessment-3-brief.md`. Read it before starting any task.

This is **not** an application. It is one flow, built properly, with nothing around it.
Anything outside the brief is a liability, not a bonus.

## The flow

A user uploads one or more plain-text files of customer product reviews. Each file
becomes a background job. A model reads the reviews and returns structured data — one
object per review. The user sees the structured result. From the result, the user can
trigger one follow-up action on a single review: draft a reply to that reviewer.

The reviews themselves are input documents. Where an uploaded file came from is not a
property of this system, the same way it is not for any upload flow.

## Stack

- Next.js (App Router), Prisma, PostgreSQL, TypeScript
- Auth reused from Assessment 1, imported by hand and committed as such
- Model provider: **DeepSeek**
- A separate worker process, run alongside the web server

Do not introduce new frameworks or ORMs. Do not add a queue library — no Redis, no
BullMQ, no Inngest. The job table is the queue.

## Hard rules

1. **Never create, write to, or modify `.env`.** I write API keys by hand. You may edit
   `.env.example` with commented placeholders only.
2. **Never put a secret, key or credential in a source file**, including in a test, a
   comment, or an example. The brief names letting an agent write API keys as a trap.
3. **No uploaded file is ever stored in the database.** Only the storage key.
4. **Do not build anything in the "Do not build" list.** No landing page, no account
   system beyond the imported auth, no editing, sharing or exporting.
5. **One step at a time.** Complete the single step I asked for, then stop and explain
   what you did. Do not proceed unprompted.
6. **Small commits.** Each step is its own commit.
7. **No placeholder or fake data anywhere.** Empty states must be genuine. Never
   fabricate model output, never seed a job row, never write an example structured
   result by hand and present it as something the model returned.

## DeepSeek — verify before you build

My training data may be out of date on this provider. Before writing any integration
code, read the current DeepSeek documentation and tell me what you found for each of
these. Do not assume. Record the findings in `DOC/deepseek-verification.md` with the
date checked.

- The base URL, and whether the official OpenAI SDK pointed at it is still the supported
  path for TypeScript. The brief permits this explicitly: "where a provider has none for
  your platform, use a compatible official SDK pointed at their endpoint, and explain
  that in your documentation." This must be explained in Section 5, not glossed over.
- The current model identifiers, and which is appropriate for extraction versus short
  generation.
- Whether structured output is supported, and by what mechanism — a JSON mode, a schema
  parameter, or neither. If the mechanism differs from OpenAI's, say so plainly rather
  than assuming compatibility.
- Current pricing per million input and output tokens. The cost model in Section 5 needs
  real numbers, and they must be the numbers in force when I submit.
- Rate limits and any concurrency limits on the account tier I am using.
- Whether the response includes token usage, and under what field. The cost model
  depends on it.

## Architectural decisions — do not change these without asking

### Provider boundary

- **One module owns every call to DeepSeek.** Nothing else in the codebase imports the
  SDK. Both roles go through it, both get a timeout, both record token usage.

- **Two roles, two system prompts, one provider module.** The roles are genuinely
  different jobs, not the same prompt reworded:
  - **Extractor** — reads a file of reviews, returns structured objects. No prose.
  - **Responder** — reads one review, writes a short reply to that reviewer. Prose.

  Each system prompt is written out in a file, not inlined as a string literal in a
  handler, and every parameter set on the call is justified in one line beside it.

### Configuration

- **Every changeable value lives in one config module**, not scattered through handlers.
  That means: model identifiers, timeout in milliseconds, max output tokens,
  temperature, the concurrency cap, the retry count, rate limit windows and limits, the
  maximum upload size and the accepted MIME types.

- **Hardcoding a model name or a token limit in a handler is a named trap in the brief.**
  If a value can be tuned, it is in config.

### Structured output

- **The schema is declared once and validated in my own code on receipt.** Provider-side
  schema enforcement, if it exists, is a helpful first line — it is not the check. The
  brief's "excellent" band requires validation in my own code, so a zod schema parses
  every response before anything is persisted.

- **The per-review shape is:**
  `sentiment` (one of `positive`, `negative`, `mixed`), `rating` (integer 1 to 5),
  `themes` (array of strings), `complaints` (array of strings), `quotedEvidence`
  (string).

- **`quotedEvidence` must be a literal substring of the source file.** This is checked in
  my own code after the schema parses. A model that returns a fluent, plausible,
  schema-valid quote that does not appear in the input has hallucinated, and no schema
  can catch that. This check is the reason the field exists and it is the strongest
  example of validation the provider cannot do for me.

- **Validation failure has a defined retry and a defined graceful failure.** One retry,
  with the validation error fed back to the model as context. If the retry also fails,
  the job is marked failed with the error message stored, and the user is told the
  truth. No silent partial results, no falling back to a hand-written object.

### Jobs and the worker

- **One uploaded file is one job.** Uploading five files creates five job rows.

- **The upload request never calls the model.** It writes the file, writes the job rows,
  and returns. A request that blocks on a provider call is the thing the brief is asking
  me not to build.

- **The worker is a separate process**, started with its own command and documented in
  Section 2. It polls for pending jobs. It is not an API route, not a `setTimeout`, and
  not something that runs inside a request.

- **Job claiming is race-safe.** A worker claims a job with a conditional update — set
  `processing` where the row is still `pending` — and only proceeds if it actually
  claimed the row. Not select-then-update.

- **The concurrency cap is on simultaneous provider calls**, held by the worker, read
  from config. The brief requires it to be demonstrated rather than asserted: uploading
  more files than the cap must visibly produce a request pattern that respects it.

- **`Job` holds status, attempts and the error message on failure.** Status is one of
  `pending`, `processing`, `done`, `failed`, constrained by a check constraint. A failed
  job keeps its error message; it is not cleared on retry.

- **Believing a 200 means the work succeeded is a named trap.** The upload returns 200
  because the job was accepted. Success or failure lives on the job row.

### Storage

- **Uploaded files go to the local filesystem**, in a directory outside the repository
  and outside `public/`. Only the storage key is stored in the database. This is the
  documented local equivalent the brief permits.

- **Section 5 must say what changes in production** — object storage, a signed URL, no
  shared filesystem between processes — rather than pretending the local path is the
  final design.

- **Size and type restrictions are enforced on the server**, not only in the file input's
  `accept` attribute. A client-side restriction is a convenience, not a control.

### Rate limiting and cost

- **Rate limiting on the endpoint that triggers processing and on the follow-up action.**
  Both are authenticated, so the limit is keyed by user. Reuse the `RateLimitHit` table
  from the imported auth slice rather than adding a second mechanism.

- **Rate limiting here is a cost control, not an abuse control.** Every processed file
  costs money. That framing belongs in Section 5.

- **Token usage is recorded per job** from the provider's response, so the cost model in
  Section 5 is computed from real numbers rather than estimated.

### Failure is a designed experience

- **The processing state tells the truth.** Pending, processing, done and failed are four
  distinct things the user can see. A spinner that never resolves is a lie.

- **A failed job shows the user what happened** in language they can act on, with the
  underlying error stored on the row for me. Never a raw stack trace, never a blank
  screen.

## Build order

Work through these in sequence. Do not skip ahead.

1. Project scaffold, `.env.example`, auth imported from Assessment 1, signed-in shell
2. DeepSeek verification, written to `DOC/deepseek-verification.md`
3. Prisma schema and migration: `Job`, `ReviewResult`, with constraints
4. The config module, with every changeable value and a one-line justification each
5. The provider module: both roles, both system prompts, timeout, token usage recorded
6. The zod schema and the validation layer, including the `quotedEvidence` substring
   check, with unit tests covering a valid response, a schema-invalid response and a
   hallucinated quote
7. Upload: server-side size and type enforcement, file written to disk, job rows created,
   rate limited
8. The worker: polling, race-safe claiming, the concurrency cap, retry and graceful
   failure
9. The processing state view, honestly reflecting pending, processing, done and failed
10. The result view
11. The follow-up action: draft a reply to one reviewer, rate limited
12. Evidence capture
13. `DOCUMENTATION.md`
14. LinkedIn post

**Evidence is captured at the step that produces it, not at the end.** Keep a running
scratch file of every wrong turn as it happens — Section 6 needs three real problems with
the dead ends included.

## Evidence the brief requires

Plan for these while building, not afterwards:

- The jobs table showing a successful run and a failed run, with the error message
  visible on the failure
- The raw model output for one request alongside the validated, parsed result
- What happens when validation fails, produced by deliberately breaking the schema or the
  response
- The concurrency cap holding, demonstrated by uploading more files than the cap and
  showing the provider request pattern
- The database holding only a storage key, not the file

## How to help me

I have to defend every line of this out loud, and answer questions like "justify your
temperature setting and your output token cap" and "I upload fifty files and press the
button — what exactly happens, and what stops it costing me fifty simultaneous calls?"
So:

- Explain the reasoning behind what you write, briefly, as you write it.
- When there was a real alternative, name it and say why you did not take it.
- If I ask you to do something that contradicts the brief, say so instead of complying.
- Do not add error handling, abstraction, or features I did not ask for.
- Test the unhappy paths, not just the happy one. An empty file, a corrupted file, a file
  at the size limit, a provider timeout, a response that fails the schema, a response
  with a quote that is not in the source, and more files uploaded at once than the
  concurrency cap allows.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
