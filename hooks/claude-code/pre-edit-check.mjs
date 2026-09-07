#!/usr/bin/env node
// Claude Code PreToolUse hook - fires right before Edit/Write. Pure Node -
// no bash dependency.
//
// Register in .claude/settings.json:
//   { "hooks": { "PreToolUse": [{ "matcher": "Edit|Write", "hooks": [
//       { "type": "command", "command": "node hooks/claude-code/pre-edit-check.mjs" }
//   ] }] } }
// (Written automatically by `hub-server init`.)
//
// Two jobs:
// 1. GATE: if no hub-server tool has been called recently in this repo,
//    DENY the edit and tell the model to call get_handoff_brief first. This
//    exists because we found - via a real, live-tested run - that an agent
//    given a plain feature request will simply skip the coordination tools
//    entirely even when a SessionStart hook already injected an explicit
//    instruction to use them. Hooks cannot see or gate MCP tool calls
//    directly (only built-in tools), so the MCP server itself leaves a
//    local marker file on every tool call, and this hook checks it.
// 2. ADVISORY: once past the gate, a fast per-file freshness check (real
//    commits from anyone else touching this exact file recently, or a note
//    whose anchor says the file has changed since).
//
// Known limitation (confirmed, not theoretical): a model blocked here can
// still route around via Bash instead of Edit/Write - this raises the bar,
// it isn't airtight. Also two open Claude Code bugs mean `deny` sometimes
// gets silently ignored specifically for Edit - if this gate doesn't seem
// to be working, that's a known upstream issue, not necessarily this script.

import { runHubServer } from "../lib/run-hub-server.mjs";
import { activeWithinMs } from "../lib/session-marker.mjs";
import { gitRootOf } from "../lib/repo-root.mjs";

const GATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function deny(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

const raw = await readStdin();

let filePath;
try {
  const parsed = JSON.parse(raw);
  filePath = parsed?.tool_input?.file_path || parsed?.tool_input?.path;
} catch {
  process.exit(0);
}
if (!filePath) process.exit(0);

// Gate: has this repo's coordination tools been used recently? Hash the
// git root, not the raw cwd - the MCP server keys its marker by the root,
// so a session started in a subdirectory would otherwise never match.
if (!activeWithinMs(gitRootOf(process.cwd()), GATE_WINDOW_MS)) {
  deny(
    "hub-server: call get_handoff_brief first. This repo is shared with teammates using their own AI agents - " +
      "editing without checking current tasks/plan/recent changes risks duplicating or conflicting with work already " +
      "in progress. Call get_handoff_brief, then retry this edit."
  );
  process.exit(0);
}

// Advisory: fast per-file freshness check, non-blocking. filePath goes
// through the environment, not argv - see the comment in src/index.ts's
// check-file handler for why (cmd.exe re-parses its own command line on
// Windows, so an untrusted argument has no safe way to sit in it).
let result;
try {
  const output = runHubServer(["check-file"], { env: { ...process.env, HUB_CHECK_FILE_PATH: filePath } });
  result = JSON.parse(output);
} catch {
  process.exit(0);
}

const hasChangedNote = (result.notes ?? []).some((n) => n.anchorStatus === "changed");
const hasRecentActivity = (result.recentCommitters ?? []).length > 0;

if (hasChangedNote || hasRecentActivity) {
  console.log(`## hub-server: heads up before editing ${filePath}`);
  console.log("");
  console.log("Someone else has touched this file recently, or a note about it is");
  console.log("stale. Read this before proceeding, don't assume your session-start");
  console.log("context is still current:");
  console.log("");
  console.log("```json");
  console.log(JSON.stringify(result, null, 2));
  console.log("```");
}
