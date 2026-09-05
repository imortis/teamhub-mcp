import { writeFileSync, existsSync, statSync } from "node:fs";
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
 */
function markerPath(repoRoot: string): string {
  const key = createHash("sha1").update(repoRoot).digest("hex");
  return join(tmpdir(), `.hub-session-active-${key}`);
}

export function markSessionActive(repoRoot: string): void {
  try {
    writeFileSync(markerPath(repoRoot), String(Date.now()), "utf8");
  } catch {
    // non-fatal - worst case the gate hook is stricter than intended
  }
}
