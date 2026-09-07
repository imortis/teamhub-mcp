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
// execute .cmd/.bat files without going through cmd.exe - documented
// Node/Windows behavior, not a bug.
//
// This used to hand-roll that cmd.exe invocation: build one escaped string
// and run it with execSync. That's exactly the anti-pattern behind
// CVE-2024-27980 (Node command injection via .bat/.cmd spawning on
// Windows) - manually quoting for cmd.exe doesn't actually work in
// general, because cmd.exe expands `%VAR%` during its own parsing pass
// even inside double-quoted text, and naive quote-doubling isn't the
// argv-escaping rule the *target* process's own parser expects either. A
// file path chosen by an LLM agent (which is exactly what flows into this
// function - `check-file <path>`) reaching a hand-built shell string is
// the concrete risk: prompt-injected repo content steering an agent
// toward editing a path like `%APPDATA%\x & calc.exe` would have been
// enough.
//
// The actual fix, per Node's own advisory: use `shell: true` together with
// an args ARRAY (never a pre-built string) and let Node's own patched
// escaping handle it - that is what closed the CVE, and it's present in
// every currently-supported Node line (>=18.20.2, >=20.12.2, >=21.7.2,
// >=22.0.0; this package already hard-requires a recent Node runtime).
// No hand-rolled quoting needed, or wanted, on either platform.

import { execFileSync } from "node:child_process";

/** Exported for tests - the real fallback logic lives in runHubServer below. */
export function run(command, args, opts) {
  if (process.platform === "win32") {
    return execFileSync(command, args, { ...opts, shell: true });
  }
  return execFileSync(command, args, opts);
}

/**
 * INVARIANT: `args` here must only ever be fixed literal tokens this
 * codebase wrote itself ("check-file", "handoff", "-y", "teamhub-mcp", ...),
 * never anything that traces back to a tool call, a file path, or any other
 * value an LLM chose. `shell: true` on the Windows branch above makes
 * cmd.exe re-parse this array as a command line, and there is no escaping
 * that survives that re-parse (`%VAR%` expands even inside quotes,
 * regardless of how carefully the rest is quoted). A value that isn't
 * fully trusted belongs in `opts.env` instead, which cmd.exe never
 * touches - see check-file's callers for the pattern.
 */
export function runHubServer(args, opts = {}) {
  const baseOpts = { encoding: "utf8", timeout: 15000, ...opts };
  // stdio: pipe on all three streams for the fast-path attempt - on
  // Windows, cmd.exe otherwise prints "'hub-server' is not recognized..."
  // straight to our stderr even though we catch the exception cleanly,
  // which would look like a real error on every single hook call for
  // anyone without a persistent install (the fallback below always
  // succeeds regardless).
  try {
    return run("hub-server", args, { ...baseOpts, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // ENOENT (POSIX) / "not recognized" (Windows) - not installed
    // globally. Fall back to npx.
    return run("npx", ["-y", "teamhub-mcp", ...args], baseOpts);
  }
}
