"use client";

import { useState, type FormEvent } from "react";

interface FileOutcome {
  filename: string;
  status: "queued" | "rejected";
  jobId?: string;
  reason?: string;
}

interface UploadFormProps {
  // Passed down from the server component that renders this (app/upload/page.tsx)
  // rather than imported here directly - lib/ai/config.ts also holds
  // DEEPSEEK_API_KEY, and a client component has no business importing that
  // module at all, even for the unrelated, non-secret values in it.
  maxSizeBytes: number;
  acceptedTypes: readonly string[];
  // Called once, after a request that actually reached the server and got
  // a 200 back (new Job rows may exist now) - not on a client rejection,
  // a 401/429, or a network failure, none of which created anything new
  // for the jobs list (components/UploadWorkspace.tsx) to show.
  onUploaded?: () => void;
}

// Convenience only, not a control - the server (app/api/upload/route.ts)
// re-checks every one of these independently and is what actually
// enforces them. This exists so a user sees a fast, specific reason
// before a round trip, not so the server can trust it.
function clientRejectionReason(file: File, maxSizeBytes: number): string | null {
  if (file.size === 0) return "This file is empty.";
  if (file.size > maxSizeBytes) return `Larger than the ${(maxSizeBytes / (1024 * 1024)).toFixed(1)}MB limit.`;
  if (!/\.txt$/i.test(file.name)) return "Only .txt files are accepted.";
  return null;
}

export default function UploadForm({ maxSizeBytes, acceptedTypes, onUploaded }: UploadFormProps) {
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<FileOutcome[] | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setOutcomes(null);

    const form = event.currentTarget;
    const formData = new FormData(form);
    const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);

    if (files.length === 0) {
      setFormError("Choose at least one .txt file to upload.");
      return;
    }

    // A same-request, client-visible preview of what the server will
    // decide - not a substitute for its check. A file that slips past
    // this (a hidden character in the name the regex above doesn't
    // catch, a file picked via drag-and-drop that bypasses the input's
    // accept filter entirely, or simply a raw POST built outside this
    // form) still gets caught by app/api/upload/route.ts, which repeats
    // every one of these checks itself against the actual file bytes.
    const clientRejections = files
      .map((file) => ({ file, reason: clientRejectionReason(file, maxSizeBytes) }))
      .filter((entry): entry is { file: File; reason: string } => entry.reason !== null);

    if (clientRejections.length > 0) {
      setOutcomes(
        clientRejections.map(({ file, reason }) => ({ filename: file.name, status: "rejected" as const, reason })),
      );
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/upload", { method: "POST", body: formData });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        setFormError(
          retryAfter ? `Too many uploads. Try again in ${retryAfter} seconds.` : "Too many uploads. Try again later.",
        );
        return;
      }

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setFormError(body?.error ?? "Something went wrong. Please try again.");
        return;
      }

      setOutcomes(body.files);
      form.reset();
      onUploaded?.();
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-base">
      <div className="flex flex-col gap-small">
        <label htmlFor="files" className="text-label-large text-on-surface-variant">
          Review files (.txt, up to {(maxSizeBytes / (1024 * 1024)).toFixed(1)}MB each)
        </label>
        <input
          id="files"
          name="files"
          type="file"
          multiple
          accept={[...acceptedTypes, ".txt"].join(",")}
          className="text-body-medium"
        />
      </div>

      {formError ? (
        <p role="alert" className="rounded-md bg-error-container p-small text-body-medium text-on-error-container">
          {formError}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="self-start rounded-md bg-primary px-base py-small text-label-large text-on-primary disabled:opacity-50"
      >
        {submitting ? "Uploading…" : "Upload"}
      </button>

      {outcomes ? (
        <ul className="flex flex-col gap-small">
          {outcomes.map((outcome, index) => (
            <li
              key={`${outcome.filename}-${index}`}
              className={
                "rounded-md p-small text-body-medium " +
                (outcome.status === "queued"
                  ? "bg-surface-container-high text-on-surface"
                  : "bg-error-container text-on-error-container")
              }
            >
              {outcome.filename}:{" "}
              {outcome.status === "queued" ? "queued for processing" : `not accepted — ${outcome.reason}`}
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
