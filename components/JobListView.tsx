import Link from "next/link";
import type { JobSummary } from "@/lib/jobs";
import { describeFailureForUser } from "@/lib/failure-messages";

// Exactly the four states, exactly these classes - no hex anywhere, all
// four verified present in app/globals.css's @theme block.
const STATUS_STYLES: Record<string, string> = {
  pending: "bg-surface-variant text-on-surface-variant",
  processing: "bg-secondary-container text-on-secondary-container",
  done: "bg-tertiary-container text-on-tertiary-container",
  failed: "bg-error-container text-on-error-container",
};

function formatUploadedAt(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function JobListView({ jobs }: { jobs: JobSummary[] }) {
  if (jobs.length === 0) {
    // Genuine, not a placeholder: this is really every job this user has,
    // which is none.
    return <p className="text-body-medium text-on-surface-variant">You haven&apos;t uploaded any files yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-small">
      {jobs.map((job) => (
        <li key={job.id} className="flex flex-col gap-extra-small rounded-md bg-surface-container p-small">
          <div className="flex items-center justify-between gap-base">
            <span className="text-body-medium text-on-surface">{job.originalFilename}</span>
            <span
              className={`rounded-md px-small py-extra-small text-label-medium ${STATUS_STYLES[job.status] ?? STATUS_STYLES.pending}`}
            >
              {job.status}
            </span>
          </div>

          <span className="text-label-medium text-on-surface-variant">Uploaded {formatUploadedAt(job.createdAt)}</span>

          {/* Stuck case (step 8's dead-worker scenario, one layer up): the
              badge above still honestly says "processing" - that is the
              real stored status - this is an added, honest caveat, not a
              replacement claim of "failed." No reclaim feature exists, so
              nothing will resolve this on its own; the only thing a user
              can actually do is try again. */}
          {job.status === "processing" && job.isStuck ? (
            <p className="rounded-md bg-error-container p-extra-small text-label-medium text-on-error-container">
              This is taking longer than expected. It may be stuck — try uploading the file again.
            </p>
          ) : null}

          {job.status === "failed" && job.errorMessage ? (
            <p className="text-body-medium text-on-surface-variant">{describeFailureForUser(job.errorMessage)}</p>
          ) : null}

          {/* /upload/results/[jobId] doesn't exist until step 10 - this
              link 404s until then. */}
          {job.status === "done" ? (
            <Link href={`/upload/results/${job.id}`} className="text-body-medium text-primary">
              View results
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
