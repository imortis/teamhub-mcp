import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import * as hub from "./tools.js";
import { resolveRepoRoot, resolveUrlToLocalPath } from "./repo-resolver.js";
import { setCachedPath } from "./repo-cache.js";
import { markSessionActive } from "./session-marker.js";
import { findRepoRoot, getRemoteUrl } from "../git/repo.js";

/**
 * Every tool operates on the project folder, resolved once per server
 * process (i.e. once per session) and then reused. `set_repo` can override
 * it mid-session. There's no workspace ID or auth token - git repo access
 * IS the access control, and two people are "on the same team" precisely
 * when their clones push to the same remote. `memberName` is optional
 * everywhere and defaults to `git config user.name`.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "hub-server", version: "0.2.0" });

  let resolvedDir: string | null = null;
  const cwd = async () => {
    if (!resolvedDir) {
      resolvedDir = await resolveRepoRoot(server);
    }
    // Piggyback marking "this repo's coordination tools were used just
    // now" on the same call, so the PreToolUse gate hook (which cannot see
    // MCP tool calls directly - only built-in tools) has something to check.
    markSessionActive(resolvedDir);
    return resolvedDir;
  };

  /** Which repo is in use, so the agent can state it and the user can catch a wrong one. */
  const activeRepo = (dir: string) => ({ localPath: dir, remoteUrl: getRemoteUrl(dir) });

  /**
   * Which coding agent is connected, from the client's own MCP handshake
   * (e.g. "claude-code 2.1.0", "antigravity 2.0"). Recorded alongside the
   * human's name on anything written, since the same person driving two
   * different agents can leave noticeably different records - and a reader
   * deserves to know whose judgement they're inheriting.
   */
  const agentLabel = (): string | null => {
    const info = server.server.getClientVersion();
    if (!info?.name) return null;
    return info.version ? `${info.name} ${info.version}` : info.name;
  };

  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const errorResult = (err: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  });

  server.registerTool(
    "set_repo",
    {
      title: "Set or change which repo this session works on",
      description:
        "Point this session at a specific repo, by GitHub URL or by local folder path. Use it when the user names a repo, says they're switching projects, or when the repo reported by get_context/get_handoff_brief isn't the one they meant. Pass `reset: true` to go back to automatic detection. The change applies to this session only - it is deliberately not saved machine-wide, so another window working on a different project isn't silently redirected.",
      inputSchema: {
        repoUrl: z.string().optional().describe("e.g. https://github.com/your-org/your-repo - resolved to a local clone on this machine."),
        localPath: z.string().optional().describe("Absolute path to a local clone, if you already know it."),
        reset: z.boolean().optional().describe("Forget the override and go back to detecting the repo automatically."),
      },
    },
    async ({ repoUrl, localPath, reset }) => {
      try {
        if (reset) {
          resolvedDir = null;
          const dir = await cwd();
          return json({ reset: true, activeRepo: activeRepo(dir), note: "Back to automatic detection." });
        }

        if (localPath) {
          if (!existsSync(localPath)) throw new Error(`No such folder: ${localPath}`);
          const root = findRepoRoot(localPath); // throws with a clear message if it isn't a git repo
          resolvedDir = root;
          markSessionActive(root);
          // Learn the mapping, so asking for this repo by URL later works
          // even when the clone lives somewhere the folder scan wouldn't
          // look (a work directory, another drive, wherever).
          const remote = getRemoteUrl(root);
          if (remote) setCachedPath(remote, root);
          return json({ activeRepo: activeRepo(root), how: "set directly from the path you gave" });
        }

        if (repoUrl) {
          // Give the resolver the currently-detected folder as a hint, so
          // "you're already in that repo" is recognised rather than searched for.
          const hint = resolvedDir ?? (await cwd());
          const { localPath: found, how } = resolveUrlToLocalPath(repoUrl, hint);
          if (!found) {
            return json({
              error: `Couldn't find a local clone of ${repoUrl} on this machine.`,
              how,
              suggestion: "Clone it first, then call set_repo again with its folder path as `localPath`.",
            });
          }
          resolvedDir = found;
          markSessionActive(found);
          return json({ activeRepo: activeRepo(found), how });
        }

        throw new Error("Pass repoUrl, localPath, or reset: true.");
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_context",
    {
      title: "Get shared team context",
      description:
        "Fetch the current shared plan from .hub/ in this repo: all tasks (status/owner/declared interface), and recent teammate activity. Pulls the latest from git first. For picking up someone else's work, prefer get_handoff_brief instead - it also includes the requirements/design docs, structured completion reports, and anchor-verified file history in one deterministic call.",
      inputSchema: {},
    },
    async () => {
      try {
        const dir = await cwd();
        return json({ activeRepo: activeRepo(dir), ...hub.getContext(dir) });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "declare_task",
    {
      title: "Declare a task",
      description:
        "Propose a task: title, scope (file paths / module / route names it'll touch), and optionally the interface it'll expose and assumptions being made. Leaves the task UNCLAIMED (owner is not set to you automatically) - call claim_task right after if you intend to build it yourself, so teammates can otherwise pick it up. Commits and pushes to .hub/tasks/. Returns `conflicts` (other declared tasks touching the same scope) AND `recentActivityNearby` (real git commits touching this scope in the last 10 minutes, from anyone else - catches a teammate mid-edit right now even if they never declared a task for it). Check both before proceeding.",
      inputSchema: {
        memberName: z.string().optional().describe("Defaults to git config user.name."),
        title: z.string(),
        scope: z.array(z.string()).describe("File paths, module names, or API routes this task will touch."),
        declaredInterface: z.string().optional().describe("e.g. 'POST /reconcile -> {status, exceptions[]}'."),
        assumptions: z.string().optional(),
        dependsOn: z
          .array(z.string())
          .optional()
          .describe(
            "Task IDs this one can't sensibly start before - e.g. a 'wire the login form to /api/auth' task depends on the task that builds /api/auth. Worth setting even when the two touch completely different files, because scope-overlap conflict detection can't see that kind of dependency at all."
          ),
      },
    },
    async ({ memberName, title, scope, declaredInterface, assumptions, dependsOn }) => {
      try {
        return json(hub.declareTask(await cwd(), { memberName, agent: agentLabel(), title, scope, declaredInterface, assumptions, dependsOn }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim a task",
      description:
        "Claim an existing task (e.g. one from get_context) so teammates know you're working on it. Returns `recentActivityNearby` (real commits touching this task's scope in the last 10 minutes from anyone else) and `blockedBy` (dependencies that aren't done yet). Neither blocks the claim, but read both before diving in - `blockedBy` especially, since it means you'd be building against something that doesn't exist yet. Also records the current commit as this task's base, so get_diff_for_task can show exactly what changed once you're finished.",
      inputSchema: { memberName: z.string().optional(), taskId: z.string() },
    },
    async ({ memberName, taskId }) => {
      try {
        return json(hub.claimTask(await cwd(), { memberName, agent: agentLabel(), taskId }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  const decisionSchema = z.object({
    decision: z.string(),
    why: z.string(),
    alternativesConsidered: z.string().optional(),
  });
  const fileChangeSchema = z.object({ path: z.string(), purpose: z.string() });

  server.registerTool(
    "update_task_status",
    {
      title: "Update task status",
      description:
        "Update a task's status. Before marking one 'done', call get_diff_for_task first and write the completion from the actual diff rather than memory. ALWAYS include `completion` with this fixed shape (not a free-text summary) - a structured report is what stays consistent when a different model reads it later, unlike prose that gets reinterpreted differently by every reader: whatWasBuilt (1-3 sentences), decisions (each with decision/why/alternativesConsidered), filesChanged (each with path/purpose), knownLimitations, nextSteps. This becomes the permanent, queryable design record in .hub/tasks/ for teammates, and feeds get_handoff_brief. IMPORTANT: if the response includes `uncommittedFileWarnings`, the files you listed in `filesChanged` are NOT actually committed/pushed yet - commit and push them for real before telling the user this is done, or teammates will never see the code. If you're changing direction WITHOUT finishing (switching approach, or dropping it), set status 'abandoned' with `abandonReason` instead of just going quiet - an abandoned task is reclaimable by teammates and shows up honestly in get_handoff_brief; a task silently left 'in_progress' forever looks like someone's still on it.",
      inputSchema: {
        memberName: z.string().optional(),
        taskId: z.string(),
        status: z.enum(["todo", "claimed", "in_progress", "abandoned", "done"]),
        completion: z
          .object({
            whatWasBuilt: z.string(),
            decisions: z.array(decisionSchema).optional(),
            filesChanged: z.array(fileChangeSchema).optional(),
            knownLimitations: z.string().optional(),
            nextSteps: z.string().optional(),
          })
          .optional()
          .describe("Required (in practice) when status is 'done'."),
        abandonReason: z.string().optional().describe("Required (in practice) when status is 'abandoned' - why you stopped without finishing."),
      },
    },
    async ({ memberName, taskId, status, completion, abandonReason }) => {
      try {
        return json(hub.updateTaskStatus(await cwd(), { memberName, agent: agentLabel(), taskId, status, completion, abandonReason }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "log_activity",
    {
      title: "Log activity",
      description:
        "Broadcast what you're currently doing, so teammates' get_context/get_handoff_brief calls show it in recent activity. Use kind 'pivoted' specifically when you change approach mid-task without abandoning it outright - detail should say what you were doing, what you're doing instead, and why - so teammates see the change of direction immediately instead of working from your original (now stale) plan.",
      inputSchema: {
        memberName: z.string().optional(),
        kind: z.string().describe("e.g. 'started', 'editing', 'committed', 'finished', 'pivoted'."),
        detail: z.string(),
        files: z.array(z.string()).optional(),
      },
    },
    async ({ memberName, kind, detail, files }) => {
      try {
        return json(hub.logActivity(await cwd(), { memberName, agent: agentLabel(), kind, detail, files }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "record_file_note",
    {
      title: "Record a file note",
      description:
        "Attach a short rationale note to a file you finished touching (what you did, why). Pinned to the current commit as an anchor - anyone continuing this file later gets told via get_file_history whether the file has changed since (so they know if the note is still trustworthy).",
      inputSchema: {
        memberName: z.string().optional(),
        filePath: z.string(),
        summary: z.string(),
        reasoning: z.string().optional(),
      },
    },
    async ({ memberName, filePath, summary, reasoning }) => {
      try {
        return json(hub.recordFileNote(await cwd(), { memberName, agent: agentLabel(), filePath, summary, reasoning }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_file_history",
    {
      title: "Get file history",
      description:
        "Get the rationale trail for a specific file - what teammates did to it and why, before you continue it. Each note carries an anchorStatus: 'verified' (file unchanged since the note), 'changed' (modified since - re-read the file before trusting the note), 'gone' (deleted), 'unknown'.",
      inputSchema: { filePath: z.string() },
    },
    async ({ filePath }) => {
      try {
        return json(hub.getFileHistory(await cwd(), filePath));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_diff_for_task",
    {
      title: "See what actually changed for a task",
      description:
        "Call this BEFORE writing a completion report. Returns everything that changed since you claimed the task - committed and uncommitted - as a file list, a diff stat, and (when it's not enormous) the full patch. Write `filesChanged` from this, not from memory: in a long session it's easy to forget files you touched early or to report ones from an approach you later reverted, and since `uncommittedFileWarnings` only checks the paths you list, an incomplete list also quietly defeats that safety check.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      try {
        return json(hub.getDiffForTask(await cwd(), taskId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_task_history",
    {
      title: "Get a task's full status history",
      description:
        "See every status transition a task went through (todo -> claimed -> in_progress -> done/abandoned) with who made each change and when - useful when a task's current state alone doesn't explain how it got there, e.g. it was abandoned then reclaimed then abandoned again.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      try {
        return json(hub.getTaskHistory(await cwd(), taskId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "check_file_before_edit",
    {
      title: "Check a file right before editing it",
      description:
        "Fast, single-file freshness check - call this immediately before editing any file that's part of a shared interface or that you haven't touched yet this session, ESPECIALLY in a long-running session. Returns anchor-verified notes on the file plus real commits from anyone else touching it in the last 15 minutes. This is cheaper than get_handoff_brief and catches drift a session-start snapshot misses (a teammate can commit to this exact file while you're mid-session).",
      inputSchema: { filePath: z.string() },
    },
    async ({ filePath }) => {
      try {
        return json(hub.checkFileBeforeEdit(await cwd(), filePath));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_plan",
    {
      title: "Get the project plan",
      description:
        "Read the two living plan documents: requirements (the why/what) and design (the architecture/how). Read this alongside get_context/get_handoff_brief to understand intent, not just the task list.",
      inputSchema: {},
    },
    async () => {
      try {
        return json(hub.getPlan(await cwd()));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "update_plan",
    {
      title: "Update the project plan",
      description:
        "Replace the full content of one plan document (requirements.md or design.md) with new markdown. Read get_plan first and edit the whole doc, don't append blindly - this is the shared source of truth for project intent that every teammate's agent reads.",
      inputSchema: {
        memberName: z.string().optional(),
        doc: z.enum(["requirements", "design"]),
        content: z.string().describe("Full replacement markdown content for this document."),
      },
    },
    async ({ memberName, doc, content }) => {
      try {
        return json(hub.updatePlan(await cwd(), { memberName, doc, content }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_handoff_brief",
    {
      title: "Get a full handoff brief",
      description:
        "THE tool to call when picking up work someone else started, or at the start of any session on a shared repo - call this INSTEAD OF assembling context yourself from several calls. Deterministically bundles: requirements + design (why/how), active/unclaimed tasks (what's left), recently completed tasks with their structured completion reports (what was just built, key decisions, why), recently ABANDONED tasks with why they were dropped (so you don't redo a dead end or wonder why something looks half-finished), recent activity, and anchor-verified file history for every file those completions touched. Optionally filter by `scope` (e.g. [\"frontend\"]) to focus on one area.",
      inputSchema: {
        scope: z.array(z.string()).optional().describe("Filter to tasks/files touching any of these scope tags. Omit for everything."),
        doneLimit: z.number().optional().describe("Max recently-done tasks to include (default 10)."),
      },
    },
    async ({ scope, doneLimit }) => {
      try {
        const dir = await cwd();
        return json({ activeRepo: activeRepo(dir), ...hub.getHandoffBrief(dir, { scope, doneLimit }) });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}
