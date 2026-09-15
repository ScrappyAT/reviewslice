import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { ACCEPTED_MIME_TYPES, AI_RATE_LIMITS, MAX_UPLOAD_SIZE_BYTES } from "@/lib/ai/config";
import { buildStorageKey, deleteUploadedFile, writeUploadedFile } from "@/lib/storage";

// This endpoint triggers processing - it's the one AGENTS.MD's rate
// limiting section names. It never calls DeepSeek itself (see the loop
// below): it writes files, writes Job rows, and returns. A 200 here means
// "queued," not "done" - the trap the brief names by name.

interface FileOutcome {
  filename: string;
  status: "queued" | "rejected";
  jobId?: string;
  reason?: string;
}

// Extension is the primary gate: it's always present and doesn't depend
// on the browser's (sometimes absent, sometimes wrong) MIME sniffing for
// a plain .txt file. The declared type is checked too, but only rejects
// when the browser explicitly claims something other than text/plain -
// an empty/absent type (common for .txt across browsers and OSes) is not
// treated as a rejection on its own.
function isAcceptedFile(file: File): boolean {
  const hasAcceptedExtension = /\.txt$/i.test(file.name);
  const hasAcceptedType = file.type === "" || (ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type);
  return hasAcceptedExtension && hasAcceptedType;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    // A route handler, not a page - getSession()'s caller elsewhere
    // (requireSession) redirects, but that's wrong here: a fetch() caller
    // needs a real 401 to act on, not a redirect response it would have
    // to follow and then guess about.
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const userId = session.user.id;

  // Keyed by user only, per AGENTS.MD: a cost control on an authenticated
  // endpoint, not an abuse control that would also need an IP dimension.
  // One hit per request regardless of how many files it contains - fifty
  // files in one submission is a concurrency-cap question for the worker
  // (not built yet), not a question this limit answers.
  const { limit, windowSeconds } = AI_RATE_LIMITS.uploadProcessing;
  const rateLimit = await checkRateLimit(`upload:user:${userId}`, limit, windowSeconds);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many uploads. Try again later." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Invalid upload." }, { status: 400 });
  }

  const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No file selected." }, { status: 400 });
  }

  const outcomes: FileOutcome[] = [];

  // Each file is independent: one file's rejection or storage failure
  // never touches the files before or after it in the same request. "One
  // uploaded file is one job" (AGENTS.MD) is a per-file unit of work, not
  // a batch-atomic one - there's nothing in the brief that says five
  // files uploaded together must all succeed or all fail together.
  for (const file of files) {
    if (file.size === 0) {
      outcomes.push({ filename: file.name, status: "rejected", reason: "This file is empty." });
      continue;
    }
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      outcomes.push({
        filename: file.name,
        status: "rejected",
        reason: `This file is larger than the ${(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)).toFixed(1)}MB limit.`,
      });
      continue;
    }
    if (!isAcceptedFile(file)) {
      outcomes.push({ filename: file.name, status: "rejected", reason: "Only .txt files are accepted." });
      continue;
    }

    const storageKey = buildStorageKey(userId);
    let written = false;
    try {
      const content = Buffer.from(await file.arrayBuffer());
      await writeUploadedFile(storageKey, content);
      written = true;

      // status defaults to "pending" (prisma/schema.prisma) - not set
      // explicitly here, so there is exactly one place that decides what
      // a freshly created job's status is.
      const job = await prisma.job.create({
        data: { userId, storageKey, originalFilename: file.name, sizeBytes: file.size },
      });
      outcomes.push({ filename: file.name, status: "queued", jobId: job.id });
    } catch {
      // The write may have succeeded before the failure (e.g. the
      // database insert is what actually failed) - if it did, the file
      // is now unreferenced, since no Job row points at it. Clean it up
      // rather than leave an orphan; this does not affect any other
      // file in the loop.
      if (written) {
        await deleteUploadedFile(storageKey);
      }
      outcomes.push({ filename: file.name, status: "rejected", reason: "Could not save this file. Please try again." });
    }
  }

  // Always 200: the request itself was well-formed and was fully
  // processed, file by file - even a response where every file was
  // rejected is a successful response describing that truth, not a
  // failed request. The per-file breakdown is the whole answer; nothing
  // here claims any file has been processed by the model.
  return NextResponse.json({ files: outcomes }, { status: 200 });
}
