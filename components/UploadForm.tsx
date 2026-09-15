"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";

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
  // Display only - the native input (kept in the DOM, just visually
  // hidden) remains the actual source of truth handleSubmit reads from
  // via FormData, unchanged from before this control was restyled.
  const [selectedFileNames, setSelectedFileNames] = useState<string[]>([]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFileNames(event.target.files ? Array.from(event.target.files).map((file) => file.name) : []);
  }

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
      setSelectedFileNames([]);
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
        {/* Descriptive text, not the input's label - the styled trigger
            below is. Linked via aria-describedby instead, so the input's
            accessible name stays just "Choose files" rather than every
            associated label's text concatenated together. */}
        <p id="files-description" className="text-label-large text-on-surface-variant">
          Review files (.txt, up to {(maxSizeBytes / (1024 * 1024)).toFixed(1)}MB each)
        </p>

        {/* Native input: kept in the DOM and in tab order (sr-only clips
            it visually, it does not remove it, unlike display:none/
            hidden - a keyboard user still Tabs to this exact element and
            opens the picker with Enter/Space, same as ever). `peer` lets
            the styled label below react to *this* element's focus state. */}
        <input
          id="files"
          name="files"
          type="file"
          multiple
          accept={[...acceptedTypes, ".txt"].join(",")}
          aria-describedby="files-description"
          onChange={handleFileChange}
          className="peer sr-only"
        />

        {/* The actual trigger. A <label htmlFor> associated with a file
            input opens the native picker on click/tap with no JS - real
            browser behaviour, not simulated - and screen readers announce
            it as the input's accessible name ("Choose files") because of
            that same association, exactly as the native control would
            have been announced by its own text. peer-focus-visible
            carries a visible focus ring onto this label when the
            (invisible) input is focused via keyboard, so keyboard users
            still get to see where focus is even though the real focused
            element is visually hidden. */}
        <label
          htmlFor="files"
          className="self-start rounded-md bg-secondary-container px-base py-small text-label-large text-on-secondary-container cursor-pointer peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2"
        >
          Choose files
        </label>

        {/* aria-live: the native control's own "N files" text is always
            available to assistive tech on focus; this replacement text is
            a separate element the input's focus doesn't carry, so without
            an explicit live region a screen reader user who just closed
            the file picker would hear nothing confirming what got
            selected. */}
        <div aria-live="polite" className="flex flex-col gap-extra-small">
          <p className="text-body-medium text-on-surface-variant">
            {selectedFileNames.length === 0
              ? "No files selected"
              : `${selectedFileNames.length} file${selectedFileNames.length === 1 ? "" : "s"} selected`}
          </p>
          {selectedFileNames.length > 0 ? (
            <ul className="flex flex-col gap-extra-small text-label-medium text-on-surface-variant">
              {selectedFileNames.map((name, index) => (
                <li key={`${name}-${index}`}>{name}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {formError ? (
        <p role="alert" className="rounded-md bg-error-container p-small text-body-medium text-on-error-container">
          {formError}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="self-start rounded-md bg-primary px-base py-small text-label-large text-on-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
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
