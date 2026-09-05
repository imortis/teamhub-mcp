// Cross-platform-safe way to invoke the `hub-server` CLI from a hook script.
//
// On Windows, npm's global bin for hub-server is a .cmd batch wrapper, and
// Node's child_process cannot execute .cmd/.bat files without a shell -
// this is documented Node/Windows behavior, not a bug. Naively passing
// `shell: true` together with a separate args array is what Node itself
// warns is unsafe ("arguments are not escaped, only concatenated"), so on
// Windows we build one fully-escaped command string ourselves and run that
// as a single unit instead - no separate unescaped args array involved.
//
// On POSIX, hub-server's shebang script is directly executable - no shell
// needed at all.

import { execFileSync, execSync } from "node:child_process";

function quoteForWindowsShell(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  return '"' + String(arg).replace(/"/g, '""') + '"';
}

export function runHubServer(args, opts = {}) {
  const baseOpts = { encoding: "utf8", timeout: 10000, ...opts };

  if (process.platform === "win32") {
    const command = ["hub-server", ...args.map(quoteForWindowsShell)].join(" ");
    return execSync(command, baseOpts);
  }
  return execFileSync("hub-server", args, baseOpts);
}
