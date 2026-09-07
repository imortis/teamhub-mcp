// Walk up from a directory to the git repo root (the folder containing
// .git). The session marker written by the MCP server is keyed by a hash of
// the repo root as git reports it, so a hook that hashes a SUBDIRECTORY
// instead computes a different key and silently never finds the marker -
// which would look exactly like "the coordination tools were never called".
//
// Falls back to the directory it was given, so a non-repo folder degrades to
// the old behaviour rather than throwing.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function gitRootOf(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}
