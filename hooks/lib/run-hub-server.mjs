// Cross-platform-safe way to invoke the hub-server CLI from a hook script.
//
// Tries the bare `hub-server` command first (fast - works if it's on PATH
// via a persistent global install or `npm link`), falling back to
// `npx -y teamhub-mcp` if that's not found - so someone who only ever ran
// `npx -y teamhub-mcp init` (no persistent install) still works, just with
// npx's ~1-2s cold-start instead of an instant command. This matters more
// here than in the main MCP server config: hooks like PreToolUse can fire
// on every single edit, so the fast path is worth having, not just the
// npx fallback.
//
// On Windows, npm's global bin for hub-server is a .cmd batch wrapper (and
// npx itself resolves through one too), and Node's child_process cannot
// execute .cmd/.bat files without a shell - this is documented Node/Windows
// behavior, not a bug. Naively passing `shell: true` together with a
// separate args array is what Node itself warns is unsafe ("arguments are
// not escaped, only concatenated"), so on Windows we build one fully-
// escaped command string ourselves and run that as a single unit instead.
//
// On POSIX, these are directly executable - no shell needed at all.

import { execFileSync, execSync } from "node:child_process";

function quoteForWindowsShell(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  return '"' + String(arg).replace(/"/g, '""') + '"';
}

function run(command, args, opts) {
  if (process.platform === "win32") {
    const full = [command, ...args.map(quoteForWindowsShell)].join(" ");
    return execSync(full, opts);
  }
  return execFileSync(command, args, opts);
}

export function runHubServer(args, opts = {}) {
  const baseOpts = { encoding: "utf8", timeout: 15000, ...opts };
  // stdio: pipe on all three streams for the fast-path attempt - on
  // Windows, execSync/cmd.exe otherwise prints "'hub-server' is not
  // recognized..." straight to our stderr even though we catch the
  // exception cleanly, which would look like a real error on every single
  // hook call for anyone without a persistent install (the fallback below
  // always succeeds regardless).
  try {
    return run("hub-server", args, { ...baseOpts, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // ENOENT (POSIX) / "not recognized" (Windows via cmd.exe) - not
    // installed globally. Fall back to npx.
    return run("npx", ["-y", "teamhub-mcp", ...args], baseOpts);
  }
}
