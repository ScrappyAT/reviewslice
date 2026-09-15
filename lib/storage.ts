// lib/storage.ts
//
// The only module that writes an uploaded file to disk or builds a
// storage key. AGENTS.MD: uploaded files live on the local filesystem, in
// a directory outside the repository and outside public/; only the
// storage key ever goes in the database.

import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { UPLOAD_STORAGE_DIR } from "./ai/config";

// Storage key format: "<userId>/<32 random hex chars>.txt".
//
// - userId prefix: groups one user's uploads together on disk for anyone
//   inspecting the storage directory by hand - not required for
//   correctness, but the natural, no-extra-cost choice given a directory
//   has to exist per write regardless.
// - Random hex, not the original filename: the original name never
//   builds a disk path, so nothing about it - including a deliberately
//   hostile one, e.g. "../../etc/passwd" - can ever escape the storage
//   directory. It's kept separately, as Job.originalFilename, for
//   display; this key only has to be a safe, collision-resistant handle.
//   randomBytes(16), not a new ID library: the same idiom
//   lib/auth/session.ts already uses for its own random tokens.
// - Fixed .txt extension: the only accepted MIME type is text/plain
//   (lib/ai/config.ts), so every stored file is predictably named
//   regardless of what extension the client's original filename had.
export function buildStorageKey(userId: string): string {
  return `${userId}/${randomBytes(16).toString("hex")}.txt`;
}

function resolveStoragePath(storageKey: string): string {
  return path.join(UPLOAD_STORAGE_DIR, storageKey);
}

// Creates the directory tree (base dir and the per-user subdirectory) on
// every call rather than as a separate setup step - mkdir with
// recursive: true is idempotent and cheap, so there is no start-up hook
// or provisioning script to keep in sync with this.
export async function writeUploadedFile(storageKey: string, content: Buffer): Promise<void> {
  const fullPath = resolveStoragePath(storageKey);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

// Best-effort cleanup for a file that was written but then couldn't be
// queued (its Job row failed to create afterward) - a swallowed failure
// here is deliberate: the original error is what actually needs
// reporting, and a cleanup failure on top of it wouldn't change what the
// caller needs to tell the user.
export async function deleteUploadedFile(storageKey: string): Promise<void> {
  try {
    await unlink(resolveStoragePath(storageKey));
  } catch {
    // Nothing more to do.
  }
}
