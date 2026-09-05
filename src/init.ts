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

const DEFAULT_MCP_JSON = {
  mcpServers: {
    hub: { type: "stdio", command: "hub-server", args: [] },
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

  // hooks/ - copy the actual scripts from this package.
  const hooksSrc = join(pkgRoot, "hooks");
  if (existsSync(hooksSrc)) {
    copyTree(hooksSrc, join(repoRoot, "hooks"), force, report);
  } else {
    report.push(`WARNING: no hooks/ found in package at ${hooksSrc} - hook scripts not copied.`);
  }

  console.log(`hub-server init - set up ${repoRoot}\n`);
  for (const line of report) console.log(`  ${line}`);
  console.log(`\nNext: commit these files so teammates who clone this repo get the same setup automatically.`);
  console.log(`Re-run with --force to overwrite anything that already existed.`);
}
