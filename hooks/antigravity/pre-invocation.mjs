#!/usr/bin/env node
// Google Antigravity PreInvocation hook - fires before each model call.
// Pure Node, no bash dependency.
//
// This is Antigravity's equivalent of Claude Code's SessionStart, and it is
// the ONE channel on this harness that can put text in front of the model:
// PostToolUse is documented to return an empty object and cannot inject
// anything, and PreToolUse can only allow/deny/ask. So both jobs - loading
// team context, and correcting an agent that skipped the coordination tools
// - are done from here.
//
// Output shape (verified against antigravity.google/docs/hooks):
//   { "injectSteps": [ { "ephemeralMessage": "<string>" } ] }
// ephemeralMessage is a plain string, and a step object carries exactly one
// of toolCall / userMessage / ephemeralMessage.
//
// Registered by `hub-server init` in .agents/hooks.json.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fetchHubContext } from "../lib/fetch-context.mjs";
import { activeWithinMs } from "../lib/session-marker.mjs";
import { gitRootOf } from "../lib/repo-root.mjs";

// PreInvocation fires on EVERY model call, so re-fetching the brief each
// time would mean a git fetch per turn. The full brief goes in once at the
// start; after that only the cheap nudge can fire, and only occasionally.
const NUDGE_THROTTLE_MS = 5 * 60 * 1000;
const GATE_WINDOW_MS = 60 * 60 * 1000;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function emit(messages) {
  if (messages.length === 0) {
    console.log("{}");
    return;
  }
  console.log(JSON.stringify({ injectSteps: messages.map((m) => ({ ephemeralMessage: m })) }));
}

let input = {};
try {
  input = JSON.parse(await readStdin()) || {};
} catch {
  // Malformed or absent stdin - degrade to "inject nothing" rather than
  // crashing a hook that runs before literally every model call.
  emit([]);
  process.exit(0);
}

const workspace = Array.isArray(input.workspacePaths) && input.workspacePaths[0] ? input.workspacePaths[0] : process.cwd();
const repoRoot = gitRootOf(workspace);

// First model call of the conversation: load the full team brief.
if (input.invocationNum === 0) {
  let context = null;
  try {
    context = fetchHubContext({ cwd: repoRoot });
  } catch {
    context = null;
  }
  emit(context ? [context] : []);
  process.exit(0);
}

// Later calls: the only thing worth saying is "you are editing this repo
// without having touched the shared plan at all". Antigravity cannot block
// an MCP-less agent the way a deny gate would, so this is an advisory
// correction - but it fires before the model acts, not after.
const throttleKey = createHash("sha1").update(repoRoot).digest("hex");
const throttleFile = join(tmpdir(), `.hub-agy-nudge-${throttleKey}`);

let lastNudge = 0;
if (existsSync(throttleFile)) {
  try {
    lastNudge = parseInt(readFileSync(throttleFile, "utf8"), 10) || 0;
  } catch {
    lastNudge = 0;
  }
}

const now = Date.now();
const coordinated = activeWithinMs(repoRoot, GATE_WINDOW_MS);

if (!coordinated && now - lastNudge >= NUDGE_THROTTLE_MS) {
  try {
    writeFileSync(throttleFile, String(now), "utf8");
  } catch {
    // non-fatal - worst case the nudge repeats sooner than intended
  }
  emit([
    "hub-server: you have not called any team coordination tool in this repo yet. " +
      "This repo is shared with teammates who each use their own AI coding agent - they cannot see this session, " +
      "and .hub/ in this repo is the only thing carrying context between you. " +
      "Call get_handoff_brief before editing any file, then claim_task (or declare_task then claim_task) for the work you are about to do. " +
      "Skipping this is how two people's agents build the same thing twice, or overwrite each other.",
  ]);
  process.exit(0);
}

emit([]);
