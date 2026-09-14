// lib/ai/config.ts
//
// Every changeable value for the AI integration slice lives here, and
// nowhere else. A handler or the worker that needs a model name, a
// timeout, a token cap, or a rate limit imports it from here - hardcoding
// any of these in a route or the worker is the trap the brief names by
// name. Reasoning for each value is beside it, not in a separate doc,
// because "justify your temperature setting and your output token cap" is
// a defence question asked exactly as written, and the answer has to be
// right here when it's asked.
//
// Nothing outside this file reads process.env for anything AI-related.
// (The auth slice, imported "as committed," already reads
// process.env.NODE_ENV directly in lib/auth/session.ts and lib/prisma.ts -
// that predates this rule and isn't this project's code to refactor. The
// Prisma client itself also reads DATABASE_URL on its own. Neither is
// touched by or duplicated in this module.)

// ---------------------------------------------------------------------------
// DeepSeek credential and endpoint
// ---------------------------------------------------------------------------

// Read once, here, and never logged - not even in an error message. Empty
// is a real possibility right now (hard rule 1: written in by hand, not by
// an agent, and .env's DEEPSEEK_API_KEY is blank until that happens). Not
// validated here on purpose - throwing at import time would crash every
// page that happens to import this module, including ones with nothing to
// do with DeepSeek, before the key even matters. The provider module
// (step 5) is where a missing key actually matters enough to fail loudly,
// at the moment a call is attempted.
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "";

// Verified in DOC/deepseek-verification.md - the OpenAI SDK pointed at this
// base URL is DeepSeek's own documented TypeScript path. Not a secret, but
// still a changeable value, not a literal to bury in the provider module.
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// ---------------------------------------------------------------------------
// Models, per role
// ---------------------------------------------------------------------------

export const MODELS = {
  // Both roles: deepseek-flash. Per DOC/deepseek-verification.md,
  // deepseek-v4-pro has no documented capability this task shape needs
  // (same json_object mode, same 1M-token context / 384K-token output
  // ceiling) and costs 3.3-4.4x more - paid on every uploaded file for the
  // extractor, the higher-volume role.
  extractor: "deepseek-flash",
  responder: "deepseek-flash",
} as const;

// ---------------------------------------------------------------------------
// Thinking mode, per role
// ---------------------------------------------------------------------------

export const THINKING_ENABLED = {
  // Off. The extractor's job is "no prose" - a single JSON object already
  // pinned down by the zod schema. Thinking doesn't help a model comply
  // with a format it's already been told exactly how to fill in; it adds
  // reasoning tokens (billed as output, per the verification doc), and
  // DeepSeek's own docs warn thinking mode can return empty content - a
  // risk not worth taking on the role that runs on every file.
  extractor: false,
  // Off, for now - not a settled "no." A short reply could plausibly read
  // better with reasoning behind it, but I have no measured
  // reasoning-token overhead for this model/task to weigh against that
  // benefit, and inventing a number would be exactly the fabrication the
  // brief warns against, just moved into a config comment instead of a
  // cost table. Starting guess; revisit once the provider module (step 5)
  // can run real calls both ways and compare.
  responder: false,
} as const;

// ---------------------------------------------------------------------------
// Timeouts (ms) and output caps (tokens), per role
// ---------------------------------------------------------------------------

export const TIMEOUT_MS = {
  // A whole file's worth of reviews in one call can legitimately take a
  // while even with thinking off. Generous, to avoid timing out a
  // slow-but-working large file rather than a genuinely stuck one.
  // Starting guess - no real call latency measured yet.
  extractor: 60_000,
  // One review in, one short reply out, thinking off - should be quick.
  // Starting guess, same caveat.
  responder: 20_000,
} as const;

export const MAX_OUTPUT_TOKENS = {
  // Sized to comfortably fit several dozen small per-review JSON objects.
  // Starting guess - no real uploaded file has been run through this yet
  // to size it against; revisit once step 7 has real files to measure.
  extractor: 8192,
  // A short reply is a few sentences. This caps it well above what a
  // genuine reply needs, so it isn't cut off mid-sentence, without
  // inviting a runaway generation that just costs money for no benefit.
  responder: 512,
} as const;

// ---------------------------------------------------------------------------
// Temperature, per role
// ---------------------------------------------------------------------------

export const TEMPERATURE = {
  // 0. The extractor classifies (sentiment, rating, themes) and quotes
  // verbatim text - determinism is the goal, not variety. The same review
  // should get the same sentiment every time it's read, and any
  // randomness here only adds surface area for the model to drift off the
  // literal quote quotedEvidence depends on.
  extractor: 0,
  // 0.7. The responder writes prose meant to read like it was actually
  // written for this reviewer, not a template - some variability is
  // wanted, since 0 would make every reply sound identical regardless of
  // the review's tone. Kept well under 1 - it still has to stay on-topic
  // and short, not wander.
  responder: 0.7,
} as const;

// ---------------------------------------------------------------------------
// Concurrency cap
// ---------------------------------------------------------------------------

// Simultaneous provider calls the worker will hold at once, across both
// roles. Small on purpose, not derived from load: uploading enough files
// to exceed 3 has to visibly show the 4th file waiting, not racing ahead -
// that visible pattern is the evidence the brief asks for. DeepSeek's own
// account concurrency ceiling (2,500 for deepseek-flash, verified in
// DOC/deepseek-verification.md) isn't a real constraint at this scale;
// this cap exists for cost control and demonstrability, not because
// DeepSeek would otherwise throttle us.
export const CONCURRENCY_CAP = 3;

// ---------------------------------------------------------------------------
// Retry count
// ---------------------------------------------------------------------------

// Fixed by AGENTS.MD, not a guess: "One retry, with the validation error
// fed back to the model as context." Total model calls per job is at most
// RETRY_COUNT + 1 - which is exactly why RawModelResponse.attemptNumber
// (prisma/schema.prisma) is capped at 2 in practice, not a separately
// chosen number.
export const RETRY_COUNT = 1;

// ---------------------------------------------------------------------------
// Rate limits - a cost control, not an abuse control (every processed file
// or drafted reply costs real money). Both keyed by user, both checked
// with the RateLimitHit table and checkRateLimit() already in the imported
// auth slice (lib/rate-limit.ts) - not a second mechanism. That file's own
// RATE_LIMITS (signin/signup/forgotPassword/verifyResend) is untouched: it
// was imported "as committed," and those values aren't this project's to
// change. These two are new, and distinct from the concurrency cap above -
// this bounds how often a user can trigger processing or a reply at all;
// the concurrency cap bounds simultaneous provider calls once triggered.
// ---------------------------------------------------------------------------

export const AI_RATE_LIMITS = {
  // The endpoint that triggers processing (upload). Bounds repeated
  // uploads over time, independent of how many files are in one
  // submission - fifty files in a single upload is a concurrency-cap
  // question (above), not a rate-limit question. Starting guess - no real
  // usage pattern to size this against yet.
  uploadProcessing: { limit: 20, windowSeconds: 60 * 60 },
  // The follow-up action: one drafted reply per click, on one review.
  // Same reasoning, same caveat.
  reviewReply: { limit: 20, windowSeconds: 60 * 60 },
} as const;

// ---------------------------------------------------------------------------
// Upload constraints
// ---------------------------------------------------------------------------

// ~1MB. DeepSeek's ~1M-token context (DOC/deepseek-verification.md) is
// roughly 4MB of English text by the usual ~4-characters-per-token rule of
// thumb - capping well under that leaves headroom for the system prompt
// and the output, on a file format (plain text reviews) that doesn't need
// to be anywhere near this large to hold a realistic test file.
// Conservative by choice, not measured against a real large file yet -
// revisit once step 7 has one to test against.
export const MAX_UPLOAD_SIZE_BYTES = 1 * 1024 * 1024;

// Plain text only. Not a guess - it's the brief's own flow description:
// "a user uploads one or more plain-text files of customer product
// reviews."
export const ACCEPTED_MIME_TYPES = ["text/plain"] as const;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

// How often the worker checks for pending jobs. Starting guess, balancing
// "a user waits noticeably long after upload before anything visibly
// happens" against "hammering the database with empty polls between real
// work" - no real feel for this yet, revisit once the worker (step 8)
// actually runs against real uploads.
export const WORKER_POLL_INTERVAL_MS = 2_000;
