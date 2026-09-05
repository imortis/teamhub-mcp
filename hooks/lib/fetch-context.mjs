// Shared helper: returns the current shared-team HANDOFF BRIEF as a
// plain-text block for injecting into an agent's context window, or null if
// unavailable. Pure Node (no bash/Git-Bash/WSL dependency) so this works
// identically on Windows, Mac, and Linux - Node is already a hard
// dependency of hub-server itself.
//
// hub-server is a LOCAL MCP server (no hosted service, no URL) - this
// shells out to `hub-server handoff`, which does a git fetch + fast-forward
// pull before reading, so it's always fresh.

import { runHubServer } from "./run-hub-server.mjs";

export function fetchHubContext() {
  let response;
  try {
    response = runHubServer(["handoff"]);
  } catch {
    // hub-server not installed, not a git repo, or unreachable - degrade
    // silently so this never blocks a session.
    return null;
  }
  if (!response || !response.trim()) return null;

  return [
    "## Shared team handoff brief (hub-server, .hub/ in this repo)",
    "",
    "This repo is shared with teammates using their own AI coding agents.",
    "This is the FULL current state: project requirements/design, what's",
    "still to do, what teammates just finished (with their reasoning and",
    "decisions), and file-level history. Read it before asking the user",
    "to re-explain anything they've already told a teammate's agent.",
    "",
    "As you work: call declare_task before starting something new (check",
    "the conflicts and recentActivityNearby it returns), claim_task to take",
    "an existing one, update_task_status with a structured `completion`",
    "when done (not a one-line summary - whatWasBuilt/decisions/",
    "filesChanged/nextSteps), record_file_note when you finish touching a",
    "file, check_file_before_edit before editing a shared-interface file in",
    "a long session, and update_plan if requirements or design changed.",
    "",
    "```json",
    response.trim(),
    "```",
  ].join("\n");
}
