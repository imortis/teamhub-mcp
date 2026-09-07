// Companion to src/mcp/session-marker.ts - MUST compute the same path given
// the same repoRoot, since one side writes it (the MCP server, on every
// tool call) and the other reads it (this hook). Kept as a duplicate,
// dependency-free file because hook scripts are standalone copies, not
// part of hub-server's own compiled module graph.
//
// canonicalRoot here must match the one in src/mcp/session-marker.ts
// exactly - see that file's comment for why (the two sides arrive at "the
// repo root" via different paths, which a case-insensitive filesystem can
// turn into two different strings for the same folder).

import { existsSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

function canonicalRoot(repoRoot) {
  let real;
  try {
    real = realpathSync(repoRoot);
  } catch {
    real = repoRoot;
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

export function sessionMarkerPath(repoRoot) {
  const key = createHash("sha1").update(canonicalRoot(repoRoot)).digest("hex");
  return join(tmpdir(), `.hub-session-active-${key}`);
}

export function activeWithinMs(repoRoot, windowMs) {
  const p = sessionMarkerPath(repoRoot);
  if (!existsSync(p)) return false;
  try {
    return Date.now() - statSync(p).mtimeMs <= windowMs;
  } catch {
    return false;
  }
}
