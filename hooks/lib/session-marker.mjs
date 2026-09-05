// Companion to src/mcp/session-marker.ts - MUST compute the same path given
// the same repoRoot, since one side writes it (the MCP server, on every
// tool call) and the other reads it (this hook). Kept as a duplicate,
// dependency-free file because hook scripts are standalone copies, not
// part of hub-server's own compiled module graph.

import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function sessionMarkerPath(repoRoot) {
  const key = createHash("sha1").update(repoRoot).digest("hex");
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
