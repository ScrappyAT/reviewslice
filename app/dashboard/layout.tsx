import Link from "next/link";
import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth/session";
import SignOutButton from "@/components/SignOutButton";

// The route protection boundary for everything under /dashboard. A server
// component, not middleware: requireSession() does a Prisma lookup to
// confirm the session row is still valid (not just that a cookie is
// present), and Prisma doesn't run on the edge runtime middleware uses -
// see the comment on requireSession() in lib/auth/session.ts. Putting the
// call here, once, means every route nested under /dashboard (this shell
// today, the upload view and result view later) is protected without
// repeating the check per page.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="flex items-center justify-between gap-base border-b border-outline-variant bg-surface-container p-base shadow-soft">
        <nav className="flex items-center gap-large">
          <span className="text-title-medium">{user.name}</span>
          <Link href="/dashboard/upload" className="text-body-medium text-primary">
            Upload reviews
          </Link>
        </nav>
        <SignOutButton />
      </header>
      <main className="p-base">{children}</main>
    </div>
  );
}
