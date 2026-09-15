// lib/jobs.ts
//
// Server-only: reads lib/ai/config.ts (which also holds DEEPSEEK_API_KEY),
// so this module is imported by the jobs list's server component and API
// route only - never by a client component. The JobSummary *type* is safe
// to import client-side (a TypeScript type is erased at compile time, so
// `import type` pulls in none of this file's runtime code); the display
// logic that actually needs to run client-side (mapping errorMessage to
// something a user can read) lives in lib/failure-messages.ts instead,
// which has no config import at all.

import type { Job } from "@prisma/client";
import { STUCK_PROCESSING_THRESHOLD_MS } from "./ai/config";

export interface JobSummary {
  id: string;
  originalFilename: string;
  status: string;
  createdAt: string;
  errorMessage: string | null;
  // True only when status is "processing" and it has been that way far
  // longer than any legitimate attempt sequence could take - see
  // STUCK_PROCESSING_THRESHOLD_MS for the derivation. Computed once, here,
  // rather than left to the client to compute from raw timestamps, so
  // there is one definition of "stuck," not a server one and a client one
  // that could drift apart.
  isStuck: boolean;
}

export function toJobSummary(job: Job): JobSummary {
  const isStuck =
    job.status === "processing" &&
    job.startedAt !== null &&
    Date.now() - job.startedAt.getTime() > STUCK_PROCESSING_THRESHOLD_MS;

  return {
    id: job.id,
    originalFilename: job.originalFilename,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    errorMessage: job.errorMessage,
    isStuck,
  };
}
