import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findRepoRoot, getRemoteUrl } from "../git/repo.js";
import { getCachedPath, setCachedPath, normalizeRemoteUrl } from "./repo-cache.js";

/**
 * Which repo is this session actually about? Layered, most-authoritative
 * first:
 *
 * 1. HUB_REPO_PATH env override - explicit, always wins.
 * 2. Ask the user directly, via MCP elicitation - "which GitHub repo are you
 *    working on?" - then resolve that URL to a local clone (matching
 *    directory's git remote, a cached mapping from a previous session, or a
 *    bounded search of common folders). This is deliberately the PRIMARY
 *    mechanism now, not just a last-resort fallback: automatic detection
 *    (MCP `roots`, `process.cwd()`) has repeatedly proven unreliable across
 *    harnesses - Antigravity launches globally-registered servers from its
 *    own install directory, not the workspace. Asking directly sidesteps
 *    that whole class of bug, and doubles as team identity: whoever answers
 *    with the same repo URL is coordinating through the same `.hub/` state,
 *    with no separate workspace ID to invent or share.
 * 3. If the client doesn't support elicitation (or the user declines),
 *    fall back to the old chain: MCP `roots`, then `process.cwd()`.
 *
 * Only asked ONCE per server process (cached by the caller for the
 * session's lifetime) - not on every tool call.
 */
export async function resolveRepoRoot(server: McpServer): Promise<string> {
  if (process.env.HUB_REPO_PATH) {
    return process.env.HUB_REPO_PATH;
  }

  const candidate = await candidateViaRootsOrCwd(server);

  const repoUrl = await askRepoUrl(server);
  if (!repoUrl) {
    // No elicitation support, or the user declined - trust the old chain.
    return candidate;
  }

  // Does the auto-detected candidate already match what they said? Common
  // case for harnesses that get cwd right (Claude Code) - confirms and
  // caches it, so future sessions on other harnesses can reuse the mapping.
  let candidateRoot: string | null = null;
  try {
    candidateRoot = findRepoRoot(candidate);
  } catch {
    candidateRoot = null;
  }
  if (candidateRoot) {
    const remote = getRemoteUrl(candidateRoot);
    if (remote && normalizeRemoteUrl(remote) === normalizeRemoteUrl(repoUrl)) {
      setCachedPath(repoUrl, candidateRoot);
      return candidateRoot;
    }
  }

  // Known from a previous session on this machine?
  const cached = getCachedPath(repoUrl);
  if (cached && existsSync(cached)) {
    return cached;
  }

  // Bounded search of common local folders (direct children only - fast,
  // covers the ordinary "repos live under Desktop/home" case).
  const found = searchCommonRootsForRemote(repoUrl);
  if (found) {
    setCachedPath(repoUrl, found);
    return found;
  }

  // Last resort: ask directly where it's cloned.
  const localPath = await askLocalPath(server, repoUrl);
  if (localPath && existsSync(localPath)) {
    setCachedPath(repoUrl, localPath);
    return localPath;
  }

  return candidate;
}

async function candidateViaRootsOrCwd(server: McpServer): Promise<string> {
  try {
    const result = await server.server.listRoots(undefined, { timeout: 2000 });
    const first = result.roots?.[0];
    if (first?.uri) return fileURLToPath(first.uri);
  } catch {
    // client doesn't declare `roots`, or it errored/timed out
  }
  return process.cwd();
}

async function askRepoUrl(server: McpServer): Promise<string | null> {
  try {
    const result = await server.server.elicitInput(
      {
        message:
          "Which GitHub repo are you working on? (paste the URL - teammates working on the same repo automatically share context)",
        requestedSchema: {
          type: "object",
          properties: {
            repoUrl: {
              type: "string",
              title: "GitHub repo URL",
              description: "e.g. https://github.com/your-org/your-repo",
            },
          },
          required: ["repoUrl"],
        },
      },
      { timeout: 20000 }
    );
    const url = (result.content as any)?.repoUrl;
    if (result.action === "accept" && typeof url === "string" && url.trim()) {
      return url.trim();
    }
    return null;
  } catch {
    // client doesn't support elicitation, or it errored/timed out
    return null;
  }
}

async function askLocalPath(server: McpServer, repoUrl: string): Promise<string | null> {
  try {
    const result = await server.server.elicitInput(
      {
        message: `Couldn't find a local clone of ${repoUrl} automatically - what's the local folder path where you cloned it?`,
        requestedSchema: {
          type: "object",
          properties: {
            localPath: { type: "string", title: "Local folder path" },
          },
          required: ["localPath"],
        },
      },
      { timeout: 20000 }
    );
    const path = (result.content as any)?.localPath;
    if (result.action === "accept" && typeof path === "string" && path.trim()) {
      return path.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function searchCommonRootsForRemote(repoUrl: string): string | null {
  const target = normalizeRemoteUrl(repoUrl);
  const roots = [homedir(), join(homedir(), "Desktop"), join(homedir(), "Documents")];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(root, entry);
      try {
        if (!statSync(dir).isDirectory() || !existsSync(join(dir, ".git"))) continue;
        const remote = getRemoteUrl(dir);
        if (remote && normalizeRemoteUrl(remote) === target) return dir;
      } catch {
        continue;
      }
    }
  }
  return null;
}
