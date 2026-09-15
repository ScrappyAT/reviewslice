import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { toJobSummary } from "@/lib/jobs";

// What the jobs list polls. Scoped in the query itself (where: { userId })
// - never fetched broadly and filtered after, which would both be slower
// and a real risk of leaking another user's jobs if that filter were ever
// dropped by mistake.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const jobs = await prisma.job.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ jobs: jobs.map(toJobSummary) }, { status: 200 });
}
