import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Persistent, per-machine, never-git-tracked cache: repo URL -> local
 * clone path. Lets "which repo are you working on" only need to be asked
 * once per repo per machine, not every single session.
 */
const CACHE_PATH = join(homedir(), ".hub-server", "repo-cache.json");

export function normalizeRemoteUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .replace(/^git@([^:]+):/, "https://$1/")
    .toLowerCase();
}

function readCache(): Record<string, string> {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function getCachedPath(repoUrl: string): string | undefined {
  return readCache()[normalizeRemoteUrl(repoUrl)];
}

export function setCachedPath(repoUrl: string, localPath: string): void {
  const cache = readCache();
  cache[normalizeRemoteUrl(repoUrl)] = localPath;
  try {
    mkdirSync(join(homedir(), ".hub-server"), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // non-fatal - worst case we ask again next session
  }
}
