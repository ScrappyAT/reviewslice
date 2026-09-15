import Link from "next/link";

// Reached from page.tsx's notFound() for two different underlying
// reasons - a job id that doesn't exist, and a job id that belongs to
// another user - which render identically on purpose. Distinguishing
// them would mean telling a signed-in user "that id exists, it's just
// not yours," confirming which ids are real to someone with no business
// knowing that. Renders inside app/upload/layout.tsx's shell, same as
// every other page under /upload - not a bare framework error page.
export default function ResultNotFound() {
  return (
    <div className="flex flex-col gap-base">
      <p className="text-body-medium text-on-surface-variant">
        We couldn&apos;t find that result. It may not exist, or it may belong to someone else.
      </p>
      <Link href="/upload" className="text-body-medium text-primary">
        ← Back to your uploads
      </Link>
    </div>
  );
}
