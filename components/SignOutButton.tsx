"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// A client component because it needs an onClick handler and local
// pending state - the layout that renders it stays a server component so
// it can call requireSession() directly. Posts to the existing
// /api/auth/signout route (imported auth, untouched) rather than
// reimplementing cookie clearing here.
export default function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    await fetch("/api/auth/signout", { method: "POST" });
    // A full navigation, not router.refresh() alone: the upload layout
    // above this button re-runs requireSession() on the next request
    // regardless, but pushing to /signin explicitly is what actually
    // moves the user off a page they're no longer authorized to see.
    router.push("/signin");
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={pending}
      className="rounded-md bg-secondary-container px-base py-small text-label-large text-on-secondary-container disabled:opacity-50"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
