import { ACCEPTED_MIME_TYPES, JOBS_POLL_INTERVAL_MS, MAX_UPLOAD_SIZE_BYTES } from "@/lib/ai/config";
import { requireSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { toJobSummary } from "@/lib/jobs";
import UploadWorkspace from "@/components/UploadWorkspace";

// A server component: it reads config (safe here, server-side only) and
// hands the display-relevant values down as props. lib/ai/config.ts also
// holds DEEPSEEK_API_KEY - it's never imported by a client component,
// even for the unrelated, non-secret values in it. Fetching the initial
// jobs list here too (rather than leaving the client to fetch on mount)
// means the list is already on the page for the first paint, not a
// loading flash the client fills in afterward.
export default async function UploadPage() {
  const user = await requireSession();

  const jobs = await prisma.job.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="flex flex-col gap-base">
      <h1 className="text-headline-small">Upload reviews</h1>
      <p className="text-body-medium text-on-surface-variant">
        Each file becomes a job. Uploading queues it - processing happens separately.
      </p>
      <UploadWorkspace
        initialJobs={jobs.map(toJobSummary)}
        maxSizeBytes={MAX_UPLOAD_SIZE_BYTES}
        acceptedTypes={ACCEPTED_MIME_TYPES}
        pollIntervalMs={JOBS_POLL_INTERVAL_MS}
      />
    </div>
  );
}
