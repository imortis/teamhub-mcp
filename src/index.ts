#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./mcp/server.js";
import { getContext, getHandoffBrief, checkFileBeforeEdit } from "./mcp/tools.js";
import { runInit } from "./init.js";
import { findRepoRoot, getRemoteUrl } from "./git/repo.js";

const args = process.argv.slice(2);
const startDir = () => process.env.HUB_REPO_PATH || process.cwd();

function fail(err: unknown): never {
  console.error(`hub-server: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

try {
  if (args[0] === "init") {
    runInit(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "dashboard") {
    const context = getContext(startDir());
    if (args.includes("--json")) {
      console.log(JSON.stringify(context, null, 2));
    } else {
      console.log(`Tasks (${context.tasks.length}):`);
      for (const t of context.tasks) {
        console.log(`  [${t.status.padEnd(11)}] ${t.title}  (owner: ${t.owner ?? "-"}, scope: ${t.scope.join(", ")})`);
        if (t.completion) console.log(`      -> ${t.completion.whatWasBuilt}`);
        if (t.abandonReason) console.log(`      -> abandoned: ${t.abandonReason}`);
      }
      console.log(`\nRecent activity:`);
      for (const a of context.recentActivity) {
        console.log(`  ${new Date(a.createdAt).toLocaleTimeString()}  ${a.member}: ${a.kind} - ${a.detail}`);
      }
      if (context.syncMessage) console.log(`\n(${context.syncMessage})`);
    }
    process.exit(0);
  }

  // The comprehensive, deterministic payload hooks auto-inject at session
  // start: requirements/design + active tasks + structured completion
  // reports + anchor-verified file history - the same assembled brief
  // regardless of which harness/model is asking, so nobody has to
  // hand-explain context.
  if (args[0] === "handoff") {
    const dir = startDir();
    const brief = getHandoffBrief(dir);
    const root = findRepoRoot(dir);
    console.log(JSON.stringify({ activeRepo: { localPath: root, remoteUrl: getRemoteUrl(root) }, ...brief }, null, 2));
    process.exit(0);
  }

  // Fast, single-file check meant for a PreToolUse hook (fires right
  // before an Edit/Write, not just once at session start) - this is what
  // would have caught the balances.settlements regression: a teammate
  // committed to this file 4 minutes ago and you're about to edit it on a
  // stale mental model.
  if (args[0] === "check-file") {
    const filePath = args[1];
    if (!filePath) {
      console.error("Usage: hub-server check-file <path>");
      process.exit(1);
    }
    const result = checkFileBeforeEdit(startDir(), filePath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
} catch (err) {
  fail(err);
}

// Default: run as a local stdio MCP server. A harness (Claude Code, Cursor,
// Antigravity, OpenCode, ...) launches this as a subprocess with cwd set to
// the repo; all state lives in .hub/ inside that repo and syncs via git.
//
// Safety net: every tool handler already catches its own errors and
// returns them as a normal tool result (see server.ts), but this covers
// anything outside that - e.g. the elicitation/directory-resolution code
// that runs before a tool handler's own try/catch. Without this, one
// unexpected error anywhere would kill the whole server process and break
// every subsequent tool call for the rest of the session, not just fail
// the one call that triggered it. Logs to STDERR only, never stdout -
// stdout is the JSON-RPC channel for a stdio MCP server, and writing
// anything else there would corrupt the protocol stream.
process.on("uncaughtException", (err) => {
  console.error("hub-server: uncaught exception (session continues):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("hub-server: unhandled rejection (session continues):", reason);
});

const server = buildMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
