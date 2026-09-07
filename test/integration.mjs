#!/usr/bin/env node
// End-to-end test: drives the real MCP server over stdio, in a real
// throwaway git repo, exercising the full working sequence a teammate's
// agent would follow. Run with `npm test`.
//
// The point of this suite is not coverage for its own sake - it is that
// this package's whole value is "an agent picks up a teammate's work
// correctly", and the two ways that has actually broken are (a) a crash on
// startup, which makes the server invisible, and (b) an agent skipping the
// coordination tools, which the nextStep/prompt machinery exists to fix.
// Both are checked here.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A throwaway repo with an origin, so push paths are exercised too. */
function makeRepo() {
  const base = mkdtempSync(join(tmpdir(), "hub-test-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  mkdirSync(remote);
  git(remote, ["init", "--bare", "-b", "main"]);
  git(base, ["clone", remote, "work"]);
  git(work, ["config", "user.name", "Test Person"]);
  git(work, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(work, "app.js"), "// seed\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "seed"]);
  git(work, ["push", "origin", "main"]);
  return { base, work };
}

/** Minimal JSON-RPC-over-stdio client for the server under test. */
class Client {
  constructor(repoPath) {
    this.id = 0;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.proc = spawn(process.execPath, [join(pkgRoot, "dist", "index.js")], {
      cwd: repoPath,
      env: { ...process.env, HUB_REPO_PATH: repoPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c) => (this.stderr += c));
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolver = this.pending.get(msg.id);
      if (resolver) {
        this.pending.delete(msg.id);
        resolver(msg);
      }
    }
  }

  send(method, params) {
    const id = ++this.id;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async init() {
    const r = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-harness", version: "9.9.9" },
    });
    this.notify("notifications/initialized", {});
    return r;
  }

  /** Returns the parsed JSON body of a tool result, plus the raw text. */
  async call(name, args = {}) {
    const r = await this.send("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? "";
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* error results are plain text */
    }
    return { raw: r, text, body: parsed, isError: r.result?.isError === true };
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

// ---------------------------------------------------------------- MCP server

async function testServer() {
  console.log("\nMCP server");
  const { base, work } = makeRepo();
  const client = new Client(work);

  try {
    const init = await client.init();
    check("initialize succeeds", init.result?.serverInfo?.name === "hub-server", JSON.stringify(init.error ?? init.result?.serverInfo));

    const tools = (await client.send("tools/list")).result?.tools ?? [];
    check("all 14 tools registered", tools.length === 14, `got ${tools.length}: ${tools.map((t) => t.name).join(",")}`);

    // Every tool result must carry a nextStep - this is the whole mechanism
    // for keeping an agent in sequence, so a tool silently missing one is a
    // real regression, not a cosmetic one.
    const brief = await client.call("get_handoff_brief");
    check("get_handoff_brief returns nextStep", typeof brief.body?.nextStep === "string" && brief.body.nextStep.length > 20);
    check(
      "empty repo brief tells the agent to declare first",
      /declare_task/.test(brief.body?.nextStep ?? ""),
      brief.body?.nextStep
    );

    const ctx = await client.call("get_context");
    check("get_context returns nextStep", typeof ctx.body?.nextStep === "string");

    const declared = await client.call("declare_task", {
      title: "Build auth endpoint",
      scope: ["api/auth.ts"],
      declaredInterface: "POST /api/auth -> {token}",
    });
    const taskId = declared.body?.task?.id;
    check("declare_task creates a task", typeof taskId === "string", JSON.stringify(declared.body)?.slice(0, 200));
    check("declare_task leaves it unclaimed", declared.body?.task?.owner === null);
    check(
      "declare_task nextStep names the real task id and pushes toward claim_task",
      declared.body?.nextStep?.includes(taskId) && declared.body?.nextStep?.includes("claim_task"),
      declared.body?.nextStep
    );

    // Agent attribution should survive into the record.
    check("agent captured from MCP handshake", declared.body?.task?.agent === "test-harness 9.9.9", declared.body?.task?.agent);

    // A dependent task, to prove blockedBy shows up in nextStep.
    const dependent = await client.call("declare_task", {
      title: "Wire login form",
      scope: ["ui/Login.tsx"],
      dependsOn: [taskId],
    });
    const depId = dependent.body?.task?.id;

    const claimedDep = await client.call("claim_task", { taskId: depId });
    check(
      "claim_task on a blocked task says BLOCKED in nextStep",
      /BLOCKED/.test(claimedDep.body?.nextStep ?? ""),
      claimedDep.body?.nextStep
    );

    const claimed = await client.call("claim_task", { taskId });
    check("claim_task sets owner", claimed.body?.owner === "Test Person", claimed.body?.owner);
    check("claim_task records a base commit", typeof claimed.body?.baseCommit === "string" && claimed.body.baseCommit.length > 0);
    check(
      "claim_task nextStep points at get_diff_for_task next",
      claimed.body?.nextStep?.includes("get_diff_for_task") && claimed.body?.nextStep?.includes(taskId),
      claimed.body?.nextStep
    );

    // Do some real work, commit it.
    writeFileSync(join(work, "api-auth.ts"), "export const auth = () => 'token';\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-m", "add auth"]);
    git(work, ["push", "origin", "main"]);

    const diff = await client.call("get_diff_for_task", { taskId });
    check(
      "get_diff_for_task sees the new file",
      (diff.body?.files ?? []).some((f) => f.path.includes("api-auth.ts")),
      JSON.stringify(diff.body?.files)
    );
    check(
      "get_diff_for_task nextStep warns against writing filesChanged from memory",
      /memory/i.test(diff.body?.nextStep ?? ""),
      diff.body?.nextStep
    );

    // Completion naming a file that was never committed must be caught.
    const badDone = await client.call("update_task_status", {
      taskId,
      status: "done",
      completion: { whatWasBuilt: "auth", filesChanged: [{ path: "never-written.ts", purpose: "nope" }] },
    });
    check("uncommitted file is flagged", (badDone.body?.uncommittedFileWarnings ?? []).length > 0, JSON.stringify(badDone.body?.uncommittedFileWarnings));
    check(
      "nextStep tells the agent NOT to report success",
      /DO NOT tell the user this is done/i.test(badDone.body?.nextStep ?? ""),
      badDone.body?.nextStep
    );

    const goodDone = await client.call("update_task_status", {
      taskId,
      status: "done",
      completion: {
        whatWasBuilt: "auth endpoint",
        decisions: [{ decision: "token in body", why: "simpler" }],
        filesChanged: [{ path: "api-auth.ts", purpose: "the endpoint" }],
      },
    });
    check("clean completion has no warnings", goodDone.body?.uncommittedFileWarnings === undefined);
    check("clean completion nextStep suggests record_file_note", /record_file_note/.test(goodDone.body?.nextStep ?? ""), goodDone.body?.nextStep);
    check(
      "a completion with decisions is told to check the decisions against design.md",
      /update_plan/.test(goodDone.body?.nextStep ?? "") && /design\.md/.test(goodDone.body?.nextStep ?? ""),
      goodDone.body?.nextStep
    );

    const note = await client.call("record_file_note", { filePath: "api-auth.ts", summary: "auth entry point", reasoning: "kept flat for now" });
    check("record_file_note stores agent", note.body?.agent === "test-harness 9.9.9");

    const hist = await client.call("get_file_history", { filePath: "api-auth.ts" });
    check("file note is readable back", (hist.body?.notes ?? []).length === 1);
    check("fresh note verifies against the file", hist.body?.notes?.[0]?.anchorStatus === "verified", hist.body?.notes?.[0]?.anchorStatus);

    const checkFile = await client.call("check_file_before_edit", { filePath: "api-auth.ts" });
    check("check_file_before_edit returns nextStep", typeof checkFile.body?.nextStep === "string");

    const plan = await client.call("get_plan");
    check("empty plan nextStep suggests writing one", /update_plan/.test(plan.body?.nextStep ?? ""), plan.body?.nextStep);
    const wrotePlan = await client.call("update_plan", { doc: "requirements", content: "# Requirements\nShip it.\n" });
    check("update_plan writes", typeof wrotePlan.body?.path === "string");

    const taskHist = await client.call("get_task_history", { taskId });
    check("task history has multiple transitions", (taskHist.body?.history ?? []).length >= 3, `${taskHist.body?.history?.length}`);

    const activity = await client.call("log_activity", { kind: "started", detail: "testing" });
    check("log_activity records", activity.body?.kind === "started");

    // Second brief: now it has real state and must warn about owned work.
    const brief2 = await client.call("get_handoff_brief");
    check("brief lists the completed task", (brief2.body?.recentlyDone ?? []).length === 1);
    check(
      "brief nextStep flags work owned by someone",
      /IN PROGRESS BY SOMEONE ELSE/.test(brief2.body?.nextStep ?? ""),
      brief2.body?.nextStep
    );

    // Errors must come back as clean tool errors, never crash the process.
    const bad = await client.call("claim_task", { taskId: "does-not-exist" });
    check("unknown task errors cleanly", bad.isError && /No task/.test(bad.text), bad.text);

    // Path traversal: a taskId is a raw MCP argument that gets joined
    // straight into a filesystem path (.hub/tasks/<id>.json). Every entry
    // point that resolves an ID to a path must reject one shaped like an
    // escape attempt, not silently read or write outside .hub/tasks.
    const traversalId = "../../../../outside";
    for (const [tool, args] of [
      ["claim_task", { taskId: traversalId }],
      ["update_task_status", { taskId: traversalId, status: "done", completion: { whatWasBuilt: "x" } }],
      ["get_diff_for_task", { taskId: traversalId }],
      ["get_task_history", { taskId: traversalId }],
    ]) {
      const r = await client.call(tool, args);
      check(`${tool} rejects a path-traversal taskId instead of touching disk`, r.isError, r.text);
    }
    // The traversal targets 4 levels above .hub/tasks, which lands in the
    // tmp root shared by every test repo - confirms nothing was ever
    // written there, across the whole suite, not just this one repo.
    check("no file escaped .hub/tasks onto disk", !existsSync(join(tmpdir(), "outside.json")));

    // ------------------------------------------------------------- prompts
    const prompts = (await client.send("prompts/list")).result?.prompts ?? [];
    check("both prompts registered", prompts.length === 2, JSON.stringify(prompts.map((p) => p.name)));

    const startWork = await client.send("prompts/get", { name: "start_work", arguments: { intent: "add logging" } });
    const startText = startWork.result?.messages?.[0]?.content?.text ?? "";
    check("start_work prompt embeds live state", startText.includes("auth endpoint"), startText.slice(0, 200));
    check("start_work prompt states the order of work", /claim_task/.test(startText) && /get_diff_for_task/.test(startText));
    check("start_work prompt carries the user's intent", startText.includes("add logging"));

    const finish = await client.send("prompts/get", { name: "finish_task", arguments: { taskId } });
    const finishText = finish.result?.messages?.[0]?.content?.text ?? "";
    check("finish_task prompt embeds the real diff", finishText.includes("api-auth.ts"), finishText.slice(0, 200));

    // A bad task id must produce guidance, not an exception.
    const finishBad = await client.send("prompts/get", { name: "finish_task", arguments: { taskId: "nope" } });
    check(
      "finish_task with a bad id degrades to guidance",
      (finishBad.result?.messages?.[0]?.content?.text ?? "").includes("get_context"),
      JSON.stringify(finishBad.error ?? "").slice(0, 200)
    );

    check("nothing was written to stderr", client.stderr.trim() === "", client.stderr.slice(0, 300));

    // Everything above should have reached the remote, not just local disk.
    const remoteLog = git(work, ["log", "origin/main", "--oneline"]);
    check("hub records were pushed to origin", remoteLog.includes("hub:"), remoteLog.split("\n")[0]);
    check(
      "commits are attributed to person AND agent",
      remoteLog.includes("Test Person via test-harness"),
      remoteLog.split("\n").find((l) => l.includes("hub:")) ?? ""
    );
  } finally {
    client.close();
    rmSync(base, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- hooks

function runHook(script, stdinObj, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(pkgRoot, "hooks", script)], {
    input: JSON.stringify(stdinObj),
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
    timeout: 30000,
  });
  return { stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), status: r.status };
}

async function testAntigravityHooks() {
  console.log("\nAntigravity hooks");
  const { base, work } = makeRepo();

  try {
    // PreInvocation, first call of a conversation: must emit valid JSON in
    // Antigravity's documented injectSteps shape.
    const first = runHook("antigravity/pre-invocation.mjs", { invocationNum: 0, workspacePaths: [work], conversationId: "c1" }, work);
    check("pre-invocation exits 0 on first call", first.status === 0, first.stderr.slice(0, 300));
    let parsed = null;
    try {
      parsed = JSON.parse(first.stdout);
    } catch {
      /* handled below */
    }
    check("pre-invocation emits valid JSON", parsed !== null, first.stdout.slice(0, 300));
    check(
      "first invocation injects an ephemeralMessage string",
      typeof parsed?.injectSteps?.[0]?.ephemeralMessage === "string",
      JSON.stringify(parsed)?.slice(0, 200)
    );
    check(
      "injected context is the handoff brief",
      /handoff brief/i.test(parsed?.injectSteps?.[0]?.ephemeralMessage ?? ""),
      (parsed?.injectSteps?.[0]?.ephemeralMessage ?? "").slice(0, 120)
    );

    // Later invocation with no coordination tools used: the nudge.
    const nudge = runHook("antigravity/pre-invocation.mjs", { invocationNum: 3, workspacePaths: [work], conversationId: "c1" }, work);
    const nudgeParsed = JSON.parse(nudge.stdout);
    check(
      "uncoordinated later invocation nudges toward get_handoff_brief",
      /get_handoff_brief/.test(nudgeParsed?.injectSteps?.[0]?.ephemeralMessage ?? ""),
      nudge.stdout.slice(0, 200)
    );

    // Immediately again: throttled, so it must go quiet rather than nagging
    // before every single model call.
    const throttled = runHook("antigravity/pre-invocation.mjs", { invocationNum: 4, workspacePaths: [work], conversationId: "c1" }, work);
    check("nudge is throttled on the next invocation", throttled.stdout === "{}", throttled.stdout.slice(0, 200));

    // Garbage stdin must not break the hook that runs before every model call.
    const garbage = spawnSync(process.execPath, [join(pkgRoot, "hooks", "antigravity/pre-invocation.mjs")], {
      input: "not json at all",
      encoding: "utf8",
      cwd: work,
      timeout: 20000,
    });
    check("pre-invocation survives garbage stdin", garbage.status === 0 && (garbage.stdout ?? "").trim() === "{}", (garbage.stdout ?? "").slice(0, 100));

    // PreToolUse: quiet when nobody else has touched the file.
    const quiet = runHook(
      "antigravity/pre-edit-check.mjs",
      { toolCall: { name: "write_to_file", args: { TargetFile: "app.js" } }, workspacePaths: [work] },
      work
    );
    check("pre-edit-check stays silent with no conflict", quiet.stdout === "", quiet.stdout.slice(0, 200));

    // Now simulate a teammate committing to that exact file seconds ago.
    const other = join(base, "other");
    spawnSync("git", ["clone", join(base, "remote.git"), "other"], { cwd: base, encoding: "utf8" });
    git(other, ["config", "user.name", "Other Person"]);
    git(other, ["config", "user.email", "other@example.com"]);
    writeFileSync(join(other, "app.js"), "// teammate was here\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-m", "teammate edits app.js"]);
    git(other, ["push", "origin", "main"]);

    const warn = runHook(
      "antigravity/pre-edit-check.mjs",
      { toolCall: { name: "write_to_file", args: { TargetFile: "app.js" } }, workspacePaths: [work] },
      work
    );
    let warnParsed = null;
    try {
      warnParsed = JSON.parse(warn.stdout);
    } catch {
      /* handled below */
    }
    check("pre-edit-check warns on a live conflict", warnParsed?.decision === "ask", warn.stdout.slice(0, 300));
    check("warning names the teammate", /Other Person/.test(warnParsed?.reason ?? ""), (warnParsed?.reason ?? "").slice(0, 200));

    // HUB_GATE=off must silence it completely.
    const off = runHook(
      "antigravity/pre-edit-check.mjs",
      { toolCall: { name: "write_to_file", args: { TargetFile: "app.js" } }, workspacePaths: [work] },
      work,
      { HUB_GATE: "off" }
    );
    check("HUB_GATE=off silences pre-edit-check", off.stdout === "", off.stdout.slice(0, 200));

    // A tool call with no recognisable file argument must be ignored.
    const noPath = runHook("antigravity/pre-edit-check.mjs", { toolCall: { name: "write_to_file", args: { Foo: 1 } }, workspacePaths: [work] }, work);
    check("pre-edit-check ignores calls with no file path", noPath.status === 0 && noPath.stdout === "");

    // Regression: the file path here is LLM-influenced data - wherever the
    // model decided to edit, which can reflect prompt-injected repo
    // content. On Windows this hook invokes the hub-server CLI through
    // cmd.exe (npm's global bin is a .cmd shim, which Node cannot exec
    // without a shell), and cmd.exe re-parses whatever text sits in that
    // command line - a path containing shell metacharacters used to run
    // as a second command once it reached run-hub-server.mjs's argv. It
    // now travels via an environment variable instead, which cmd.exe never
    // re-parses. Prove the exploit is actually closed, not just that nothing
    // crashes: the injected command must not have run.
    const injectionMarker = join(base, "injected-by-shell.txt");
    const injectionPayload = `evil & echo INJECTED > "${injectionMarker}"`;
    const injected = runHook(
      "antigravity/pre-edit-check.mjs",
      { toolCall: { name: "write_to_file", args: { TargetFile: injectionPayload } }, workspacePaths: [work] },
      work
    );
    check("pre-edit-check survives a shell-metacharacter file path without crashing", injected.status === 0, injected.stderr.slice(0, 300));
    check("no command executed via the shelled-out hub-server invocation", !existsSync(injectionMarker));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function testInit() {
  console.log("\ninit");
  const { base, work } = makeRepo();
  try {
    const r = spawnSync(process.execPath, [join(pkgRoot, "dist", "index.js"), "init"], { cwd: work, encoding: "utf8" });
    check("init exits 0", r.status === 0, (r.stderr ?? "").slice(0, 300));

    const hooks = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(work, ".agents", "hooks.json"), "utf8")));
    check("init writes .agents/hooks.json", !!hooks["hub-server"]);
    check("hooks.json uses Antigravity event names", !!hooks["hub-server"].PreInvocation && !!hooks["hub-server"].PreToolUse);
    check(
      "hooks.json matches Antigravity's own edit tool names",
      hooks["hub-server"].PreToolUse[0].matcher.includes("replace_file_content"),
      hooks["hub-server"].PreToolUse[0].matcher
    );

    // Re-running must not duplicate config.
    spawnSync(process.execPath, [join(pkgRoot, "dist", "index.js"), "init"], { cwd: work, encoding: "utf8" });
    const settings = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(work, ".claude", "settings.json"), "utf8")));
    check("re-running init doesn't duplicate Claude hooks", settings.hooks.PreToolUse.length === 1, `${settings.hooks.PreToolUse.length}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function testClaudeCodeHookInjection() {
  console.log("\nClaude Code hook");
  const { base, work } = makeRepo();
  try {
    // The gate denies any edit until this repo's coordination tools have
    // been used - mark it active directly (the same call the real MCP
    // server makes on every tool call) so this test reaches the advisory
    // check-file path this fix is actually about, rather than the gate.
    const { markSessionActive } = await import("../dist/mcp/session-marker.js");
    markSessionActive(work);

    const injectionMarker = join(base, "injected-by-claude-hook.txt");
    const injectionPayload = `evil & echo INJECTED > "${injectionMarker}"`;
    const r = runHook("claude-code/pre-edit-check.mjs", { tool_input: { file_path: injectionPayload } }, work);
    check("claude-code pre-edit-check survives a shell-metacharacter file path", r.status === 0, r.stderr.slice(0, 300));
    check("no command executed via the shelled-out hub-server invocation (Claude Code hook)", !existsSync(injectionMarker));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

await testServer();
await testAntigravityHooks();
await testClaudeCodeHookInjection();
await testInit();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
