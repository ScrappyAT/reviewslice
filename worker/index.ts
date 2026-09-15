// worker/index.ts
//
// The separate worker process AGENTS.MD requires: started with its own
// command (`npm run worker`), not an API route, not a setTimeout inside a
// request. It polls for pending jobs, claims them race-safely, and is the
// only thing in this codebase that ever calls runExtractor() for a real
// upload (app/api/upload/route.ts never does - see its own comment).
//
// Run: `npm run worker` (see package.json). Separately from `npm run dev`
// - the web server and the worker are two processes, as the brief
// requires; neither can do the other's job.

import type { Job } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { CONCURRENCY_CAP, MODELS, RETRY_COUNT, WORKER_POLL_INTERVAL_MS } from "../lib/ai/config";
import { runExtractor, type ProviderCallResult } from "../lib/ai/provider";
import { validateExtractorResponse } from "../lib/ai/validate";
import type { Review } from "../lib/ai/schema";
import { readUploadedFile } from "../lib/storage";

const MAX_ATTEMPTS = RETRY_COUNT + 1;

// ---------------------------------------------------------------------------
// Concurrency cap
//
// Enforced in exactly one place: how many *new* jobs pollOnce() is willing
// to claim on a given cycle. activeCount is incremented synchronously as
// the very first line of processJob(), before any `await` - so by the time
// the claiming loop below has fired off N jobs, activeCount already
// reflects all N, and the *next* poll cycle's freeSlots calculation sees
// the true number of simultaneous provider calls in flight. Nothing about
// this is a query-level LIMIT on the database; it's a bound on how many
// runExtractor() calls this process is willing to have outstanding at
// once, which is exactly what AGENTS.MD asks the cap to bound.
// ---------------------------------------------------------------------------
let activeCount = 0;
let shuttingDown = false;

function log(message: string) {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

// ---------------------------------------------------------------------------
// Claiming: race-safe, FIFO
// ---------------------------------------------------------------------------

async function claimNextJobs(limit: number): Promise<Job[]> {
  if (limit <= 0) return [];

  // Oldest pending first - FIFO. This is a plain read, not itself the
  // claim; the claim is the conditional update below, per job.
  const candidates = await prisma.job.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const claimed: Job[] = [];
  for (const candidate of candidates) {
    // The conditional update from step 3: set processing where the row is
    // still pending, and only proceed if this call actually flipped it.
    // Not select-then-update - the WHERE clause carries the "still
    // pending" condition into the same statement that writes the change,
    // so two workers racing on the same row can't both win.
    const result = await prisma.job.updateMany({
      where: { id: candidate.id, status: "pending" },
      data: { status: "processing", startedAt: new Date(), attempts: 1 },
    });
    if (result.count === 1) {
      claimed.push({ ...candidate, status: "processing", attempts: 1 });
    }
    // count === 0: something else claimed it between the read above and
    // this update (another worker process, in principle - this codebase
    // only runs one, but the check is correct regardless of how many
    // run). Not an error - just move on to the next candidate.
  }
  return claimed;
}

// ---------------------------------------------------------------------------
// Per-attempt bookkeeping
// ---------------------------------------------------------------------------

interface Totals {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

function addUsage(totals: Totals, usage: Totals): Totals {
  return {
    promptTokens: totals.promptTokens + usage.promptTokens,
    completionTokens: totals.completionTokens + usage.completionTokens,
    cachedTokens: totals.cachedTokens + usage.cachedTokens,
  };
}

function describeProviderFailure(result: Extract<ProviderCallResult, { outcome: "timeout" | "error" }>): string {
  if (result.outcome === "timeout") {
    return "The request to the model timed out.";
  }
  return `The model provider returned an error: ${result.message}`;
}

function buildRetryMessage(originalFileContent: string, validationError: string): string {
  return [
    originalFileContent,
    "",
    "---",
    "Your previous response did not pass validation:",
    validationError,
    "",
    "Return the corrected JSON object.",
  ].join("\n");
}

async function markDone(jobId: string, reviews: Review[], totals: Totals) {
  // One transaction: the result rows and the job's "done" status appear
  // together, or not at all. Never a done job with no results, or result
  // rows attached to a job that still says processing.
  await prisma.$transaction([
    prisma.reviewResult.createMany({
      data: reviews.map((review, index) => ({
        jobId,
        indexInFile: index,
        sentiment: review.sentiment,
        rating: review.rating,
        themes: review.themes,
        complaints: review.complaints,
        quotedEvidence: review.quotedEvidence,
      })),
    }),
    prisma.job.update({
      where: { id: jobId },
      data: {
        status: "done",
        completedAt: new Date(),
        model: MODELS.extractor,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        cachedTokens: totals.cachedTokens,
      },
    }),
  ]);
}

async function markFailed(jobId: string, errorMessage: string, totals: Totals | null) {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "failed",
      completedAt: new Date(),
      errorMessage,
      // totals is null only when no attempt ever got a response back at
      // all (e.g. the file itself couldn't be read) - real null, not 0,
      // for a call that never happened. Any attempt that did get a
      // completion response (even an empty or invalid one) contributes
      // real, billed tokens, and a failed job that spent money is exactly
      // the number the cost model needs, not just a successful one.
      ...(totals && {
        model: MODELS.extractor,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        cachedTokens: totals.cachedTokens,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// The pipeline for one job: read the file, call the model (up to
// MAX_ATTEMPTS times), validate, and resolve to done or failed.
// ---------------------------------------------------------------------------

async function runPipeline(job: Job): Promise<void> {
  let fileContent: string;
  try {
    fileContent = await readUploadedFile(job.storageKey);
  } catch {
    // Nothing to retry here - if the file is gone, trying again won't
    // make it reappear. No RawModelResponse row either: no call was ever
    // made, so there's nothing "raw" to record.
    await markFailed(job.id, "Could not read the uploaded file.", null);
    return;
  }

  let userMessage = fileContent;
  let attemptNumber = 1;
  let totals: Totals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

  while (true) {
    const isLastAttempt = attemptNumber >= MAX_ATTEMPTS;
    log(`job ${job.id} attempt ${attemptNumber}/${MAX_ATTEMPTS}: calling model`);
    const result = await runExtractor(userMessage);

    if (result.outcome === "timeout" || result.outcome === "error") {
      // Transport-level: no completion object came back, so there is
      // nothing to write to RawModelResponse (a row existing at all means
      // the provider actually replied - see lib/ai/schema.ts's sibling
      // decision in step 5). A terminal error (400/401/402/422) is not
      // retried even if attempts remain - retrying it would fail
      // identically and spend the shared budget for nothing (see the
      // retry-budget note below). A retryable one (429/500/503, a
      // timeout, or an unrecognized status) shares the SAME budget as a
      // validation failure - see the note below MAX_ATTEMPTS.
      const terminal = result.outcome === "error" && !result.retryable;
      if (terminal || isLastAttempt) {
        log(`job ${job.id} failed at attempt ${attemptNumber}: ${result.outcome}${terminal ? " (terminal)" : ""}`);
        await markFailed(job.id, describeProviderFailure(result), totals.promptTokens > 0 ? totals : null);
        return;
      }
      attemptNumber += 1;
      await prisma.job.update({ where: { id: job.id }, data: { attempts: attemptNumber } });
      // userMessage is unchanged: nothing about the model's output needs
      // correcting, because there was no output - this is a plain resend.
      continue;
    }

    // "success" or "empty_content": a real completion object came back,
    // so a RawModelResponse row is written either way.
    const content = result.outcome === "success" ? result.content : "";
    totals = addUsage(totals, result.usage);

    const validation = validateExtractorResponse(content, fileContent);

    await prisma.rawModelResponse.create({
      data: {
        jobId: job.id,
        attemptNumber,
        rawResponse: content,
        validationError: validation.valid ? null : validation.error,
      },
    });

    if (validation.valid) {
      log(`job ${job.id} done at attempt ${attemptNumber}: ${validation.reviews.length} review(s)`);
      await markDone(job.id, validation.reviews, totals);
      return;
    }

    if (isLastAttempt) {
      log(`job ${job.id} failed at attempt ${attemptNumber}: validation (${validation.reason})`);
      await markFailed(job.id, validation.error, totals);
      return;
    }

    // Validation failure, budget remains: retry with the error fed back
    // as context, per AGENTS.MD.
    attemptNumber += 1;
    await prisma.job.update({ where: { id: job.id }, data: { attempts: attemptNumber } });
    userMessage = buildRetryMessage(fileContent, validation.error);
  }
}

// A retryable provider error and a validation failure share ONE retry
// budget (MAX_ATTEMPTS = RETRY_COUNT + 1 = 2 total attempts), not separate
// ones. This isn't an arbitrary simplification: Job.attempts and
// RawModelResponse.attemptNumber (prisma/schema.prisma, @@unique([jobId,
// attemptNumber])) were designed - and confirmed - around "at most 2"
// attempts per job, for any reason. A separate, larger budget for
// transient infrastructure errors would mean more than 2 real attempts
// per job, which the schema doesn't have room for. It's also the right
// call on its own terms: one retry policy, one number, no second budget
// to justify - building a bigger retry allowance specifically for
// 429/500/503 is exactly the unrequested robustness AGENTS.MD warns
// against, and the shared budget still gives a transient error real
// resilience (one more try), just not an unbounded one.

async function processJob(job: Job): Promise<void> {
  activeCount++;
  try {
    await runPipeline(job);
  } catch (error) {
    // Anything not already handled by a specific branch in runPipeline -
    // e.g. a database write itself failing - lands here. Still marks the
    // job failed rather than leaving it silently stuck at "processing"
    // for a reason a real crash wouldn't have caused. A genuine process
    // crash (see step 7's question) is the one thing this can't catch, by
    // definition - there's no code running to catch it with.
    const message = error instanceof Error ? error.message : String(error);
    await prisma.job
      .update({
        where: { id: job.id },
        data: { status: "failed", completedAt: new Date(), errorMessage: `Unexpected error: ${message}` },
      })
      .catch(() => {
        // If even this fails, there's nothing left this process can do.
      });
  } finally {
    activeCount--;
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function pollOnce(): Promise<void> {
  const freeSlots = CONCURRENCY_CAP - activeCount;
  if (freeSlots <= 0) {
    // At the cap: claim nothing new this cycle. Already-claimed jobs keep
    // running; anything still pending stays pending, untouched, until a
    // slot frees up on a later cycle. This is the whole enforcement -
    // there's no separate gate anywhere else.
    return;
  }

  const jobs = await claimNextJobs(freeSlots);
  for (const job of jobs) {
    log(`claimed job ${job.id} (${activeCount + 1}/${CONCURRENCY_CAP} active after this one)`);
    // Not awaited: this is what lets up to CONCURRENCY_CAP jobs run at
    // once. activeCount++ happens synchronously inside processJob before
    // its first await, so it's already accounted for by the time this
    // loop moves to the next job.
    void processJob(job);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mainLoop(): Promise<void> {
  log(`started. poll interval ${WORKER_POLL_INTERVAL_MS}ms, concurrency cap ${CONCURRENCY_CAP}, model ${MODELS.extractor}`);
  while (!shuttingDown) {
    try {
      await pollOnce();
    } catch (error) {
      log(`poll cycle failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(WORKER_POLL_INTERVAL_MS);
  }
  log("stopping: no new jobs will be claimed. Already-running jobs will finish on their own.");
}

// SIGINT/SIGTERM only flip a flag - they don't call process.exit(). The
// main loop's while condition stops claiming new work on the next check,
// and any processJob() calls already in flight are ordinary pending
// promises that keep running; Node exits naturally once they resolve and
// nothing else is scheduled. This is "asked to stop," not "died" - see
// step 7 for the difference and what a real crash leaves behind instead.
process.on("SIGINT", () => {
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  shuttingDown = true;
});

mainLoop();
