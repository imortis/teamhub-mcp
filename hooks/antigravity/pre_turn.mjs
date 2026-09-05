#!/usr/bin/env node
// Google Antigravity pre_turn hook. Pure Node - no bash dependency.
//
// Antigravity 2.0 (I/O 2026) supports a `pre_turn` lifecycle hook that runs
// a local script before each model call, documented for injecting system
// instructions. Register this script per Antigravity's hook config (global
// or workspace-level JSON - see antigravity.google/docs/sdk/lifecycle/ for
// the current config schema, which was still evolving at time of writing).
//
// Unlike SessionStart hooks (which fire once), pre_turn fires on every
// turn - to avoid hammering the Hub, this only fetches once per 60 seconds
// per working directory (a temp marker file keyed by a hash of cwd).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fetchHubContext } from "../lib/fetch-context.mjs";

const THROTTLE_MS = 60_000;
const key = createHash("sha1").update(process.cwd()).digest("hex");
const marker = join(tmpdir(), `.hub-context-fetched-${key}`);

let last = 0;
if (existsSync(marker)) {
  try {
    last = parseInt(readFileSync(marker, "utf8"), 10) || 0;
  } catch {
    // ignore, treat as never-fetched
  }
}

const now = Date.now();
if (now - last >= THROTTLE_MS) {
  const context = fetchHubContext();
  if (context) console.log(context);
  try {
    writeFileSync(marker, String(now), "utf8");
  } catch {
    // non-fatal - worst case we fetch a bit more often than intended
  }
}
