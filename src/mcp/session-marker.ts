import { writeFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * A local (never git-tracked, never shared) marker: "has THIS machine's
 * agent session engaged with hub-server's coordination tools recently, for
 * this repo?" Written by every tool call; read by the PreToolUse gate hook
 * to decide whether to deny a raw Edit/Write. This exists specifically
 * because hooks cannot see or gate MCP tool calls directly (confirmed via
 * research) - only built-in tools like Edit/Write - so the MCP server
 * itself has to leave a trace the hook can check instead.
 *
 * This side (the MCP server, writing) and the hook script (reading) each
 * arrive at "the repo root" through a different path - an elicited URL
 * resolved to a clone here, vs. `process.cwd()` or the harness's own
 * reported workspace path there - so the two are not guaranteed to be the
 * byte-identical string even when they name the exact same folder. On a
 * case-insensitive filesystem (NTFS, default APFS) a pure casing
 * difference would hash to a different key and the gate would look
 * permanently "never coordinated" even when it was. `realpathSync`
 * resolves both symlinks and the on-disk canonical casing regardless of
 * how the path was originally typed, so both sides converge on the same
 * key for the same folder. Must stay in exact sync with the copy in
 * hooks/lib/session-marker.mjs.
 *
 * `realpathSync` alone isn't enough here - confirmed experimentally on
 * Node/Windows it resolves symlinks but passes casing through unchanged
 * rather than returning the true on-disk case (`realpathSync("C:\\FOO")`
 * stays `C:\FOO`, it doesn't become `C:\foo`) - so an explicit lowercase is
 * also needed, and only on win32: POSIX filesystems are usually
 * case-sensitive, where lowercasing would wrongly treat two distinct repos
 * (`~/Repo` and `~/repo`) as the same one.
 */
function canonicalRoot(repoRoot: string): string {
  let real: string;
  try {
    real = realpathSync(repoRoot);
  } catch {
    real = repoRoot; // doesn't exist (shouldn't happen - callers always found a real .git) - hash the raw string rather than throw
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function markerPath(repoRoot: string): string {
  const key = createHash("sha1").update(canonicalRoot(repoRoot)).digest("hex");
  return join(tmpdir(), `.hub-session-active-${key}`);
}

export function markSessionActive(repoRoot: string): void {
  try {
    writeFileSync(markerPath(repoRoot), String(Date.now()), "utf8");
  } catch {
    // non-fatal - worst case the gate hook is stricter than intended
  }
}
