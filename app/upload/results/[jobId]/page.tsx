import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { describeFailureForUser } from "@/lib/failure-messages";
import DraftReplyButton from "@/components/DraftReplyButton";

// Positive/negative/mixed reuse the same semantic roles the job-status
// badges use (components/JobListView.tsx) - tertiary for a good outcome,
// error for a bad one, secondary for the in-between/notable one - so the
// app's color language stays one consistent vocabulary rather than a
// second, unrelated palette for sentiment specifically.
const SENTIMENT_STYLES: Record<string, string> = {
  positive: "bg-tertiary-container text-on-tertiary-container",
  negative: "bg-error-container text-on-error-container",
  mixed: "bg-secondary-container text-on-secondary-container",
};

export default async function ResultPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const user = await requireSession();

  // Both conditions in the same where, not id-then-check: a job that
  // exists but belongs to someone else must be structurally
  // indistinguishable from a job that doesn't exist at all - see the
  // report on why that's deliberate, not an oversight.
  const job = await prisma.job.findFirst({
    where: { id: jobId, userId: user.id },
    include: {
      results: {
        orderBy: { indexInFile: "asc" },
        include: { replyDrafts: { orderBy: { createdAt: "asc" } } },
      },
    },
  });

  if (!job) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-base">
      <Link href="/upload" className="text-body-medium text-primary">
        ← Back to your uploads
      </Link>
      <h1 className="text-headline-small">{job.originalFilename}</h1>

      {job.status === "pending" || job.status === "processing" ? (
        <p className="text-body-medium text-on-surface-variant">
          This file hasn&apos;t finished processing yet. Check its status from your uploads.
        </p>
      ) : job.status === "failed" ? (
        <p className="rounded-md bg-error-container p-small text-body-medium text-on-error-container">
          {job.errorMessage ? describeFailureForUser(job.errorMessage) : "This file could not be processed."}
        </p>
      ) : job.results.length === 0 ? (
        // Genuine, not a placeholder: the model looked at this file and
        // found nothing it could identify as a review. A done job can
        // reach zero results legitimately - the schema allows an empty
        // reviews array, and that's what "found none" looks like.
        <p className="text-body-medium text-on-surface-variant">No reviews were found in this file.</p>
      ) : (
        <ul className="flex flex-col gap-base">
          {job.results.map((result) => (
            <li key={result.id} className="flex flex-col gap-small rounded-md bg-surface-container p-base">
              <div className="flex items-center gap-small">
                <span
                  className={`rounded-md px-small py-extra-small text-label-medium ${SENTIMENT_STYLES[result.sentiment] ?? ""}`}
                >
                  {result.sentiment}
                </span>
                <span className="text-label-medium text-on-surface-variant">{result.rating}/5</span>
              </div>

              <p className="text-body-medium text-on-surface">
                <span className="text-label-medium text-on-surface-variant">Themes: </span>
                {result.themes.length > 0 ? result.themes.join(", ") : "None noted"}
              </p>

              <p className="text-body-medium text-on-surface">
                <span className="text-label-medium text-on-surface-variant">Complaints: </span>
                {result.complaints.length > 0 ? result.complaints.join(", ") : "None noted"}
              </p>

              {/* Not just "what the AI said" - the one fact this system
                  actually verifies, surfaced as such. quotedEvidence only
                  ever reaches this row because lib/ai/validate.ts already
                  confirmed it's a literal substring of the uploaded file;
                  a quote that didn't check out never became a
                  ReviewResult row at all. */}
              <blockquote className="flex flex-col gap-extra-small rounded-md bg-surface-container-high p-small">
                <span className="text-label-medium text-on-surface-variant">
                  Verified quote — confirmed to appear word-for-word in the uploaded file
                </span>
                <span className="text-body-medium text-on-surface">&ldquo;{result.quotedEvidence}&rdquo;</span>
              </blockquote>

              <DraftReplyButton
                reviewResultId={result.id}
                initialDrafts={result.replyDrafts.map((draft) => ({
                  id: draft.id,
                  replyText: draft.replyText,
                  createdAt: draft.createdAt.toISOString(),
                }))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
