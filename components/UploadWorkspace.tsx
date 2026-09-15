"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JobSummary } from "@/lib/jobs";
import UploadForm from "./UploadForm";
import JobListView from "./JobListView";

interface UploadWorkspaceProps {
  initialJobs: JobSummary[];
  maxSizeBytes: number;
  acceptedTypes: readonly string[];
  // Passed down rather than imported (JOBS_POLL_INTERVAL_MS lives in
  // lib/ai/config.ts, alongside DEEPSEEK_API_KEY) - same reason
  // UploadForm takes maxSizeBytes/acceptedTypes as props instead of
  // reading config itself.
  pollIntervalMs: number;
}

function hasActiveJobs(jobs: JobSummary[]): boolean {
  return jobs.some((job) => job.status === "pending" || job.status === "processing");
}

export default function UploadWorkspace({
  initialJobs,
  maxSizeBytes,
  acceptedTypes,
  pollIntervalMs,
}: UploadWorkspaceProps) {
  const [jobs, setJobs] = useState(initialJobs);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One self-scheduling poll: fetch, update state, and - only if
  // something is still pending or processing - schedule itself again.
  // Jobs can't change state faster than the worker itself acts, so once
  // nothing is pending or processing, there's nothing left that can
  // change and the loop simply stops, rather than polling forever.
  const poll = useCallback(async () => {
    try {
      const response = await fetch("/api/jobs");
      if (!response.ok) return; // a transient failure just stops - reload the page to recover, not worth a bespoke retry here
      const body: { jobs: JobSummary[] } = await response.json();
      setJobs(body.jobs);
      if (hasActiveJobs(body.jobs)) {
        timerRef.current = setTimeout(poll, pollIntervalMs);
      }
    } catch {
      // Same reasoning as the !response.ok branch above.
    }
  }, [pollIntervalMs]);

  useEffect(() => {
    if (hasActiveJobs(initialJobs)) {
      timerRef.current = setTimeout(poll, pollIntervalMs);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // Only the mount/pollIntervalMs pair should (re)arm this - poll()
    // already re-schedules itself for as long as there's active work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollIntervalMs]);

  // A fresh upload always creates at least one pending job, so the poll
  // loop needs to (re)start even if it had already stopped because the
  // previous batch all reached done/failed.
  function handleUploaded() {
    if (timerRef.current) clearTimeout(timerRef.current);
    void poll();
  }

  return (
    <div className="flex flex-col gap-large">
      <UploadForm maxSizeBytes={maxSizeBytes} acceptedTypes={acceptedTypes} onUploaded={handleUploaded} />
      <div className="flex flex-col gap-small">
        <h2 className="text-title-medium">Your uploads</h2>
        <JobListView jobs={jobs} />
      </div>
    </div>
  );
}
