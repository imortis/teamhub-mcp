import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "./git/repo.js";

function packageRoot(): string {
  // dist/init.js -> package root is one level up.
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function copyTree(src: string, dest: string, force: boolean, report: string[]): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyTree(srcPath, destPath, force, report);
    } else {
      if (existsSync(destPath) && !force) {
        report.push(`skipped (already exists): ${destPath}`);
        continue;
      }
      writeFileSync(destPath, readFileSync(srcPath));
      report.push(`wrote: ${destPath}`);
    }
  }
}

// `npx -y teamhub-mcp` rather than a bare `hub-server` command: the MCP
// server process is spawned once per session, so the ~1-2s npx cold-start
// is a one-time cost, and this way the config works whether or not the
// user ever did a persistent install - the same pattern Playwright's own
// MCP config uses (`npx -y @playwright/mcp`). A bare `hub-server` command
// only works for someone who ran `npm link`/a global install; someone who
// only ran `npx -y teamhub-mcp init` would have nothing on PATH otherwise.
const DEFAULT_MCP_JSON = {
  mcpServers: {
    hub: { type: "stdio", command: "npx", args: ["-y", "teamhub-mcp"] },
  },
};

// `node hooks/...mjs`, never bash - Node is already a hard dependency of
// hub-server itself, so this works identically on Windows/Mac/Linux with no
// Git Bash/WSL requirement.
const HOOK_ENTRIES: Record<string, { command: string; entry: any }[]> = {
  SessionStart: [
    { command: "hooks/claude-code/session-start.mjs", entry: { hooks: [{ type: "command", command: "node hooks/claude-code/session-start.mjs" }] } },
  ],
  PreToolUse: [
    {
      command: "hooks/claude-code/pre-edit-check.mjs",
      entry: { matcher: "Edit|Write", hooks: [{ type: "command", command: "node hooks/claude-code/pre-edit-check.mjs" }] },
    },
  ],
};

/**
 * Antigravity's hooks.json, which is a different shape from Claude Code's
 * settings.json: the top level is a map of named hook SETS, and the events
 * are PreToolUse / PostToolUse / PreInvocation / PostInvocation / Stop.
 *
 * Only PreInvocation and PreToolUse are used. PostToolUse is documented to
 * return an empty object and so cannot tell the model anything, which makes
 * it useless for correcting an agent's course - PreInvocation is the only
 * channel on this harness that can inject text, so context loading and the
 * "you skipped the shared plan" nudge both run from there.
 *
 * Matchers use Antigravity's own tool names (write_to_file,
 * replace_file_content, multi_replace_file_content), not Claude Code's
 * Edit/Write.
 */
const ANTIGRAVITY_HOOKS = {
  "hub-server": {
    PreInvocation: [{ hooks: [{ type: "command", command: "node hooks/antigravity/pre-invocation.mjs", timeout: 20 }] }],
    PreToolUse: [
      {
        matcher: "write_to_file|replace_file_content|multi_replace_file_content",
        hooks: [{ type: "command", command: "node hooks/antigravity/pre-edit-check.mjs", timeout: 15 }],
      },
    ],
  },
};

/**
 * `hub-server init` - scaffolds everything a repo needs into the CURRENT
 * repo in one command: .mcp.json, .claude/settings.json hooks, and the
 * hook scripts themselves (copied from this package's own hooks/, so it
 * works the same whether installed via `npm link`, a global install, or
 * `npx -y hub-server init`). Never clobbers existing files unless --force.
 */
export function runInit(argv: string[]): void {
  const force = argv.includes("--force");
  const repoRoot = findRepoRoot(process.cwd());
  const pkgRoot = packageRoot();
  const report: string[] = [];

  // .mcp.json
  const mcpJsonPath = join(repoRoot, ".mcp.json");
  if (existsSync(mcpJsonPath) && !force) {
    report.push(`skipped (already exists): ${mcpJsonPath}`);
  } else {
    writeFileSync(mcpJsonPath, JSON.stringify(DEFAULT_MCP_JSON, null, 2) + "\n", "utf8");
    report.push(`wrote: ${mcpJsonPath}`);
  }

  // .claude/settings.json - merge hooks in if the file already exists,
  // rather than overwriting whatever else a team already has configured.
  const claudeDir = join(repoRoot, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  mkdirSync(claudeDir, { recursive: true });
  let settings: any = { hooks: {} };
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      report.push(`WARNING: ${settingsPath} exists but isn't valid JSON - leaving it untouched, wire hooks manually.`);
      settings = null;
    }
  }
  if (settings) {
    settings.hooks ??= {};
    for (const [key, entries] of Object.entries(HOOK_ENTRIES)) {
      settings.hooks[key] ??= [];
      const existingJson = JSON.stringify(settings.hooks[key]);
      for (const { command, entry } of entries) {
        if (!existingJson.includes(command)) settings.hooks[key].push(entry);
      }
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    report.push(`wrote: ${settingsPath}`);
  }

  // .agents/mcp_config.json - Antigravity's workspace-level config.
  // Antigravity does NOT read .mcp.json (that's a Claude Code convention),
  // so without this an Antigravity user runs init, sees files appear, and
  // gets nothing - the server is never registered on their side.
  // Per Antigravity's docs this is the workspace equivalent of
  // ~/.gemini/config/mcp_config.json; not verified against a live install.
  const agentsDir = join(repoRoot, ".agents");
  const agentsConfigPath = join(agentsDir, "mcp_config.json");
  if (existsSync(agentsConfigPath) && !force) {
    report.push(`skipped (already exists): ${agentsConfigPath}`);
  } else {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(agentsConfigPath, JSON.stringify(DEFAULT_MCP_JSON, null, 2) + "\n", "utf8");
    report.push(`wrote: ${agentsConfigPath}`);
  }

  // .agents/hooks.json - merged like the Claude Code settings file, since a
  // team may already have their own hook sets registered here.
  const agyHooksPath = join(agentsDir, "hooks.json");
  mkdirSync(agentsDir, { recursive: true });
  let agyHooks: any = {};
  if (existsSync(agyHooksPath)) {
    try {
      agyHooks = JSON.parse(readFileSync(agyHooksPath, "utf8"));
    } catch {
      report.push(`WARNING: ${agyHooksPath} exists but isn't valid JSON - leaving it untouched, wire hooks manually.`);
      agyHooks = null;
    }
  }
  if (agyHooks) {
    if (agyHooks["hub-server"] && !force) {
      report.push(`skipped (already configured): ${agyHooksPath}`);
    } else {
      Object.assign(agyHooks, ANTIGRAVITY_HOOKS);
      writeFileSync(agyHooksPath, JSON.stringify(agyHooks, null, 2) + "\n", "utf8");
      report.push(`wrote: ${agyHooksPath}`);
    }
  }

  // hooks/ - copy the actual scripts from this package.
  const hooksSrc = join(pkgRoot, "hooks");
  if (existsSync(hooksSrc)) {
    copyTree(hooksSrc, join(repoRoot, "hooks"), force, report);
  } else {
    report.push(`WARNING: no hooks/ found in package at ${hooksSrc} - hook scripts not copied.`);
  }

  console.log(`hub-server init - set up ${repoRoot}\n`);
  for (const line of report) console.log(`  ${line}`);
  console.log(`
Next steps:
  1. Restart your coding agent (or start a new session) so it picks up the
     new MCP config - it won't be noticed mid-session.
  2. Check it worked: ask your agent what MCP tools it has, or run
     \`npx -y teamhub-mcp dashboard\` in this folder.
  3. Commit these files so teammates get the same setup when they clone.

Using Antigravity? It doesn't read .mcp.json or .claude/ - those are Claude
Code files. It gets .agents/mcp_config.json and .agents/hooks.json instead,
both written above. If your version doesn't pick those up, copy them to
~/.gemini/config/mcp_config.json and ~/.gemini/config/hooks.json by hand.

Re-run with --force to overwrite anything that already existed.`);
}
