import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { AI_RATE_LIMITS, MODELS } from "@/lib/ai/config";
import { runResponder } from "@/lib/ai/provider";

// The follow-up action (AGENTS.MD): draft a reply to one reviewer. A
// synchronous request, not a job - see this step's report for why. This
// route is the only caller of runResponder() for a real review; nothing
// else in the codebase reaches it.

// Safe, generic messages only - never result.message (the raw provider
// string) or anything else that could carry provider/system internals
// back to the browser. Distinct from lib/failure-messages.ts's mapping:
// that one matches the specific strings worker/index.ts stores for the
// extractor's failure modes, which don't apply here - the responder has
// no validation-failure or file-read-failure path at all, only these
// three transport-level outcomes.
function describeResponderFailure(outcome: "timeout" | "error" | "empty_content"): string {
  if (outcome === "timeout") return "This took too long. Please try again.";
  if (outcome === "empty_content") return "The AI didn't return a reply. Please try again.";
  return "Our AI provider had a problem. Please try again in a few minutes.";
}

export async function POST(request: Request, { params }: { params: Promise<{ reviewResultId: string }> }) {
  const { reviewResultId } = await params;

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const userId = session.user.id;

  const { limit, windowSeconds } = AI_RATE_LIMITS.reviewReply;
  const rateLimit = await checkRateLimit(`reply:user:${userId}`, limit, windowSeconds);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many replies drafted. Try again later." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  // Scoped through the relation in one query, not fetched then checked -
  // the same reasoning as app/upload/results/[jobId]/page.tsx: a review
  // belonging to another user and a review id that doesn't exist at all
  // both return null here, identically. Only the fields the responder is
  // allowed to see (ReviewContext) are selected - not the job, not the
  // storage key, nothing this action has no business touching.
  const review = await prisma.reviewResult.findFirst({
    where: { id: reviewResultId, job: { userId } },
    select: { id: true, sentiment: true, rating: true, themes: true, complaints: true, quotedEvidence: true },
  });

  if (!review) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const result = await runResponder({
    sentiment: review.sentiment,
    rating: review.rating,
    themes: review.themes,
    complaints: review.complaints,
    quotedEvidence: review.quotedEvidence,
  });

  if (result.outcome !== "success") {
    // No row is ever written for a failed attempt - see the schema
    // comment on ReplyDraft. The user is looking at this request right
    // now; a second click is the retry, not stored state.
    return NextResponse.json({ error: describeResponderFailure(result.outcome) }, { status: 502 });
  }

  const draft = await prisma.replyDraft.create({
    data: {
      reviewResultId: review.id,
      // Identical today: unlike the extractor, nothing is parsed out of
      // the responder's output - it's prose in, prose stored, no
      // transformation step to make the two diverge. Kept as separate
      // columns anyway, matching RawModelResponse's raw-vs-derived
      // distinction, in case that ever changes (e.g. a wrapper the
      // system prompt asks for and this route strips before display).
      replyText: result.content,
      rawResponse: result.content,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      cachedTokens: result.usage.cachedTokens,
      // Whatever config says today - an audit trail, same reasoning as
      // Job.model (prisma/schema.prisma), not a literal duplicated here.
      model: MODELS.responder,
    },
  });

  return NextResponse.json(
    { id: draft.id, replyText: draft.replyText, createdAt: draft.createdAt },
    { status: 200 },
  );
}
