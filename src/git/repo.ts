import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function git(cwd: string, args: string[]): GitResult {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    code: res.status,
  };
}

/** Walk up from `startDir` looking for a `.git` directory. */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Not inside a git repository (searched upward from ${startDir}). hub-server stores its state in .hub/ inside your team's repo.`
      );
    }
    dir = parent;
  }
}

/** The current commit hash - used to anchor a file reference at write time. */
export function currentCommit(repoRoot: string): string {
  const res = git(repoRoot, ["rev-parse", "HEAD"]);
  return res.ok ? res.stdout : "unknown";
}

/**
 * Re-checks a file reference pinned at `anchorCommit` against the repo's
 * current state: "verified" (untouched since the anchor), "changed"
 * (modified since), "gone" (deleted), "unknown" (anchor commit itself isn't
 * reachable, e.g. history was rewritten - can't verify either way).
 */
export function checkAnchor(repoRoot: string, filePath: string, anchorCommit: string): "verified" | "changed" | "gone" | "unknown" {
  if (!existsSync(join(repoRoot, filePath))) return "gone";
  if (anchorCommit === "unknown") return "unknown";

  const catFile = git(repoRoot, ["cat-file", "-e", `${anchorCommit}^{commit}`]);
  if (!catFile.ok) return "unknown";

  const diff = git(repoRoot, ["diff", "--quiet", anchorCommit, "HEAD", "--", filePath]);
  // spawnSync with `git diff --quiet`: exit 0 = no diff, exit 1 = differs.
  if (diff.code === 0) return "verified";
  if (diff.code === 1) return "changed";
  return "unknown";
}

export type FileCommitStatus = "missing" | "uncommitted" | "committed_not_pushed" | "committed_and_pushed";

/**
 * Checks whether a file a task CLAIMS to have changed was actually
 * committed (and pushed) - catches the "marked done, but the real code
 * never left this laptop" pattern (observed twice: FocusFlow, then the
 * expense-splitter frontend) at the moment it happens, instead of a
 * teammate discovering the gap later.
 */
export function checkFileCommitStatus(repoRoot: string, filePath: string): FileCommitStatus {
  if (!existsSync(join(repoRoot, filePath))) return "missing";

  const status = git(repoRoot, ["status", "--porcelain", "--", filePath]);
  if (status.stdout) return "uncommitted";

  const branch = currentBranch(repoRoot);
  if (!hasRemote(repoRoot)) return "committed_not_pushed"; // no remote to push to at all

  const ahead = git(repoRoot, ["rev-list", "--count", `origin/${branch}..HEAD`, "--", filePath]);
  if (ahead.ok && ahead.stdout !== "0") return "committed_not_pushed";

  return "committed_and_pushed";
}

/**
 * Recent-activity proximity check, pure git: has anyone OTHER than
 * `excludeAuthor` touched these paths (or the repo at all, if paths
 * omitted) in the last `windowSeconds`? This is the answer to "shouldn't
 * the other agent know someone's doing something right now" that doesn't
 * need a live channel - it catches teammates editing code directly too,
 * even if they never declared a task for it, because it reads real commit
 * history rather than hub-server's own records.
 */
export function recentCommitters(
  repoRoot: string,
  opts: { paths?: string[]; windowSeconds?: number; excludeAuthor?: string } = {}
): { author: string; when: string; subject: string }[] {
  const since = new Date(Date.now() - (opts.windowSeconds ?? 300) * 1000).toISOString();
  const args = ["log", `--since=${since}`, "--format=%an|%aI|%s", "--all"];
  if (opts.paths && opts.paths.length > 0) args.push("--", ...opts.paths);

  const res = git(repoRoot, args);
  if (!res.ok || !res.stdout) return [];
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [author, when, subject] = line.split("|");
      return { author, when, subject };
    })
    .filter((c) => !opts.excludeAuthor || c.author !== opts.excludeAuthor);
}

/**
 * The full version history of one file, oldest first - each commit that
 * touched it, with its content at that point. Used for `get_task_history`:
 * `.hub/tasks/<id>.json` is overwritten in place on every status change
 * (unlike activity/notes, which are one-file-per-event), so the
 * todo->claimed->in_progress->done sequence isn't otherwise queryable even
 * though git already has it - this just exposes what git already stores.
 */
export function fileVersionHistory(
  repoRoot: string,
  relativePath: string
): { commitHash: string; author: string; when: string; subject: string; content: string }[] {
  const log = git(repoRoot, ["log", "--format=%H|%an|%aI|%s", "--follow", "--", relativePath]);
  if (!log.ok || !log.stdout) return [];

  const commits = log.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commitHash, author, when, ...rest] = line.split("|");
      return { commitHash, author, when, subject: rest.join("|") };
    })
    .reverse(); // oldest first

  return commits.map((c) => {
    const show = git(repoRoot, ["show", `${c.commitHash}:${relativePath}`]);
    return { ...c, content: show.ok ? show.stdout : "" };
  });
}

export interface DiffSince {
  /** Files changed since the base commit, including uncommitted working-tree changes. */
  files: { path: string; status: string }[];
  /** `git diff --stat` style summary. */
  stat: string;
  /** Full patch text, omitted when it'd be enormous (see `truncated`). */
  patch: string | null;
  truncated: boolean;
  note?: string;
}

const MAX_PATCH_BYTES = 60_000;

/**
 * Everything that changed since `baseCommit`, committed or not. Committed
 * changes come from `baseCommit..HEAD`; uncommitted ones from the working
 * tree, because an agent typically writes its completion report before it
 * has committed anything.
 */
export function diffSince(repoRoot: string, baseCommit: string): DiffSince {
  const reachable = git(repoRoot, ["cat-file", "-e", `${baseCommit}^{commit}`]);
  if (!reachable.ok) {
    return {
      files: [],
      stat: "",
      patch: null,
      truncated: false,
      note: `Base commit ${baseCommit} isn't reachable (history may have been rewritten) - can't diff against it.`,
    };
  }

  const committed = git(repoRoot, ["diff", "--name-status", `${baseCommit}..HEAD`]);
  const uncommitted = git(repoRoot, ["status", "--porcelain"]);

  const files: { path: string; status: string }[] = [];
  const seen = new Set<string>();
  for (const line of committed.stdout.split("\n").filter(Boolean)) {
    const [status, ...rest] = line.split(/\s+/);
    const path = rest.join(" ");
    if (path && !seen.has(path)) {
      seen.add(path);
      files.push({ path, status: `committed:${status}` });
    }
  }
  for (const line of uncommitted.stdout.split("\n").filter(Boolean)) {
    const status = line.slice(0, 2).trim();
    const path = line.slice(3).trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      files.push({ path, status: `uncommitted:${status}` });
    }
  }

  const stat = git(repoRoot, ["diff", "--stat", `${baseCommit}..HEAD`]).stdout;
  const committedPatch = git(repoRoot, ["diff", `${baseCommit}..HEAD`]).stdout;
  const workingPatch = git(repoRoot, ["diff", "HEAD"]).stdout;
  const full = [committedPatch, workingPatch].filter(Boolean).join("\n");

  if (full.length > MAX_PATCH_BYTES) {
    return {
      files,
      stat,
      patch: null,
      truncated: true,
      note: `Patch is ${full.length} bytes, too large to inline - use the file list and stat, or read specific files directly.`,
    };
  }
  return { files, stat, patch: full || null, truncated: false };
}

/** The `origin` remote URL of a repo, or null if there isn't one / it's not a repo. */
export function getRemoteUrl(repoRoot: string): string | null {
  const res = git(repoRoot, ["remote", "get-url", "origin"]);
  return res.ok && res.stdout ? res.stdout : null;
}

export function getMemberName(repoRoot: string): string {
  const cfg = git(repoRoot, ["config", "user.name"]);
  if (cfg.ok && cfg.stdout) return cfg.stdout;
  return userInfo().username;
}

function hasRemote(repoRoot: string): boolean {
  return git(repoRoot, ["remote"]).stdout.length > 0;
}

function currentBranch(repoRoot: string): string {
  const res = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return res.ok ? res.stdout : "HEAD";
}

/**
 * Best-effort sync before a read: fetch + fast-forward-only merge. Never
 * touches working-tree files outside what upstream actually changed, and a
 * fast-forward-only merge either succeeds cleanly or does nothing - it will
 * never produce a conflict or partial state. If there's no remote (solo/demo
 * repo) this is a silent no-op so the tool still works standalone.
 */
export function syncBeforeRead(repoRoot: string): { synced: boolean; message?: string } {
  if (!hasRemote(repoRoot)) return { synced: false, message: "no git remote configured - reading local state only" };

  const branch = currentBranch(repoRoot);
  const fetch = git(repoRoot, ["fetch", "origin", branch]);
  if (!fetch.ok) return { synced: false, message: `git fetch failed: ${fetch.stderr}` };

  const merge = git(repoRoot, ["merge", "--ff-only", `origin/${branch}`]);
  if (!merge.ok) {
    return {
      synced: false,
      message: `couldn't fast-forward to origin/${branch} (local branch has diverged or has unrelated commits) - showing local state, which may be stale: ${merge.stderr}`,
    };
  }
  return { synced: true };
}

/**
 * Stages exactly the given paths (never `-A`/`.`, so unrelated working-tree
 * changes elsewhere are never swept into this commit), commits, and pushes -
 * retrying a fetch+ff-merge+push cycle a few times if another teammate
 * pushed to .hub/ first. Throws HubGitConflict if a targeted re-check
 * (`onConflict`) reports the specific record was concurrently modified.
 */
/**
 * Every commit message here is built by interpolating free-text fields
 * (a task title, a member name, an agent label, an activity kind) straight
 * into what gets passed to `git commit -m`. Git and GitHub parse trailers
 * like `Co-Authored-By:` purely by position - a blank line followed by a
 * "Key: value" line, anywhere in the message - with no check on who wrote
 * that line. A title like `Fix bug\n\nCo-Authored-By: x <x@evil.com>` would
 * forge a contributor into the repo's real history. Reject rather than
 * silently strip: a field that already contains a genuine newline losing
 * everything after the first line would be its own confusing bug.
 */
export function assertSingleLineField(fieldName: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${fieldName} cannot contain a line break (it becomes part of a git commit message).`);
  }
  return value;
}

export function commitAndPush(
  repoRoot: string,
  paths: string[],
  message: string,
  onConflict?: () => void
): { pushed: boolean; message?: string } {
  assertSingleLineField("commit message", message);
  const add = git(repoRoot, ["add", "--", ...paths]);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);

  const status = git(repoRoot, ["status", "--porcelain", "--", ...paths]);
  if (!status.stdout) return { pushed: false, message: "nothing to commit" };

  const commit = git(repoRoot, ["commit", "-m", message]);
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`);

  if (!hasRemote(repoRoot)) return { pushed: false, message: "no git remote configured - committed locally only" };

  const branch = currentBranch(repoRoot);
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const push = git(repoRoot, ["push", "origin", branch]);
    if (push.ok) return { pushed: true };

    // Rejected - someone else pushed first. Sync and let the caller re-check
    // the specific record (e.g. "is this task still unclaimed?") before we
    // retry, so a real conflict is reported instead of blindly overwritten.
    const fetch = git(repoRoot, ["fetch", "origin", branch]);
    if (!fetch.ok) throw new Error(`git push rejected and fetch failed: ${fetch.stderr}`);

    onConflict?.();

    const merge = git(repoRoot, ["merge", "--ff-only", `origin/${branch}`]);
    if (!merge.ok) {
      throw new Error(
        `Push rejected and couldn't fast-forward merge origin/${branch} - your branch has diverged beyond .hub/ changes. Resolve manually: ${merge.stderr}`
      );
    }
  }
  throw new Error(`Gave up pushing after ${MAX_ATTEMPTS} attempts - too much concurrent activity, try again.`);
}
