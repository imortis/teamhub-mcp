import { join, normalize, sep } from "node:path";

export const HUB_DIR = ".hub";

export function hubDir(repoRoot: string): string {
  return join(repoRoot, HUB_DIR);
}

export function tasksDir(repoRoot: string): string {
  return join(hubDir(repoRoot), "tasks");
}

export function activityDir(repoRoot: string): string {
  return join(hubDir(repoRoot), "activity");
}

export function notesDirFor(repoRoot: string, filePath: string): string {
  const safe = sanitizeRelativePath(filePath);
  return join(hubDir(repoRoot), "notes", safe);
}

/** Rejects path traversal (`..`) and absolute paths so file notes can't escape .hub/notes. */
export function sanitizeRelativePath(filePath: string): string {
  const normalized = normalize(filePath).replace(/^([/\\])+/, "");
  if (normalized.split(sep).includes("..")) {
    throw new Error(`Invalid filePath (contains "..") : ${filePath}`);
  }
  return normalized;
}

/** Path relative to repoRoot, for passing to `git add`. */
export function relativeToRepo(repoRoot: string, absolutePath: string): string {
  return absolutePath.slice(repoRoot.length).replace(/^([/\\])+/, "").split(sep).join("/");
}
