"use client";

import { useState } from "react";

interface ReplyDraftSummary {
  id: string;
  replyText: string;
  createdAt: string;
}

interface DraftReplyButtonProps {
  reviewResultId: string;
  initialDrafts: ReplyDraftSummary[];
}

// User triggered, never automatic - nothing calls
// POST /api/results/[reviewResultId]/reply except this button's own click
// handler. Each click is independent: there's no "already have one"
// check, so a second click always makes a fresh call and, on success,
// adds a second draft rather than replacing the first - see this step's
// report on what a second click does.
export default function DraftReplyButton({ reviewResultId, initialDrafts }: DraftReplyButtonProps) {
  const [drafts, setDrafts] = useState(initialDrafts);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/results/${reviewResultId}/reply`, { method: "POST" });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        setError(
          retryAfter
            ? `Too many replies drafted. Try again in ${retryAfter} seconds.`
            : "Too many replies drafted. Try again later.",
        );
        return;
      }

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setError(body?.error ?? "Something went wrong. Please try again.");
        return;
      }

      setDrafts((prev) => [...prev, body]);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-small">
      <button
        type="button"
        onClick={handleClick}
        disabled={submitting}
        className="self-start rounded-md bg-primary px-base py-small text-label-large text-on-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Drafting…" : "Draft a reply to this reviewer"}
      </button>

      {error ? (
        <p role="alert" className="rounded-md bg-error-container p-small text-body-medium text-on-error-container">
          {error}
        </p>
      ) : null}

      {drafts.length > 0 ? (
        <ul className="flex flex-col gap-small">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              className="rounded-md bg-surface-container-high p-small text-body-medium text-on-surface"
            >
              {draft.replyText}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
