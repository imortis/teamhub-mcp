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

/**
 * Rejects path traversal (`..`) and absolute paths so file notes can't
 * escape .hub/notes. Also rejects an embedded newline: this same string
 * ends up both as a directory path component (where a line break is at
 * best a broken path, OS-dependent) and, in recordFileNote's commit
 * message, as message text - where a newline could otherwise be used to
 * forge a git trailer (see assertSingleLineField in git/repo.ts).
 */
export function sanitizeRelativePath(filePath: string): string {
  if (/[\r\n]/.test(filePath)) {
    throw new Error(`Invalid filePath (contains a line break): ${JSON.stringify(filePath)}`);
  }
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
