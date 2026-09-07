#!/usr/bin/env node
// Google Antigravity PreToolUse hook - fires before a file-editing tool
// runs. Pure Node, no bash dependency.
//
// Matched against Antigravity's edit tools (write_to_file,
// replace_file_content, multi_replace_file_content) by .agents/hooks.json,
// which `hub-server init` writes.
//
// Deliberately quiet. It prints NOTHING at all unless a teammate has
// actually committed to this exact file in the last 15 minutes - the one
// case where continuing means overwriting someone's live work. Two reasons
// for that restraint:
//
//   1. An open report (cmux #5358) has Antigravity rejecting PreToolUse
//      responses as `invalid_args`. Emitting no response in the common case
//      means that bug cannot affect normal editing at all - only the rare
//      warning path, where a failure degrades to "no warning" rather than
//      to a broken editor.
//   2. Antigravity's own bundled plugin registers PostToolUse and Stop but
//      skips PreToolUse, which suggests the same instability.
//
// Set HUB_GATE=off to silence it entirely.
//
// Output shape (verified against antigravity.google/docs/hooks):
//   { "decision": "allow" | "deny" | "ask" | ..., "reason": "<string>" }
// "ask" is used rather than "deny": the person is right there, and a
// teammate editing the same file is a judgement call, not a rule violation.

import { runHubServer } from "../lib/run-hub-server.mjs";
import { gitRootOf } from "../lib/repo-root.mjs";

if (process.env.HUB_GATE === "off") process.exit(0);

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

// Antigravity's edit tools don't share one argument name for "the file"
// (and the casing is not the same as Claude Code's), so match on shape
// rather than hardcoding a key that a future tool won't use.
const PATH_KEYS = /^(targetfile|target_file|filepath|file_path|absolutepath|absolute_path|path|file)$/i;

function filePathFrom(args) {
  if (!args || typeof args !== "object") return null;
  for (const [key, value] of Object.entries(args)) {
    if (PATH_KEYS.test(key) && typeof value === "string" && value.trim()) return value;
  }
  return null;
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch {
  process.exit(0);
}

const filePath = filePathFrom(input?.toolCall?.args);
if (!filePath) process.exit(0);

const workspace = Array.isArray(input.workspacePaths) && input.workspacePaths[0] ? input.workspacePaths[0] : process.cwd();
const repoRoot = gitRootOf(workspace);

// filePath goes through the environment, not argv - see the comment in
// src/index.ts's check-file handler for why (cmd.exe re-parses its own
// command line on Windows, so an untrusted argument has no safe way to
// sit in it - this value ultimately traces back to wherever the model
// decided to edit, which is not something to trust blindly).
let result;
try {
  result = JSON.parse(runHubServer(["check-file"], { cwd: repoRoot, env: { ...process.env, HUB_CHECK_FILE_PATH: filePath } }));
} catch {
  // hub-server missing, not a repo, or slow - never block an edit over it.
  process.exit(0);
}

const others = result.recentCommitters ?? [];
if (others.length === 0) process.exit(0);

const who = others.map((c) => `${c.author} (${c.when}): ${c.subject}`).join("; ");
console.log(
  JSON.stringify({
    decision: "ask",
    reason:
      `hub-server: someone else committed to ${filePath} in the last 15 minutes - ${who}. ` +
      `Your copy of this file may be stale, and writing over it now would overwrite their work. ` +
      `Re-read the file from disk first, or confirm this is intended.`,
  })
);
