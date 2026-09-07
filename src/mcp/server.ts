import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import * as hub from "./tools.js";
import * as guide from "./guidance.js";
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
 *
 * Two deliberate conventions in here, both from measured failure rather
 * than taste:
 *
 * 1. Descriptions state prerequisites DECLARATIVELY ("Requires a claimed
 *    task") rather than as instructions ("Before calling this, make sure
 *    you..."). Models follow the former and skim the latter.
 * 2. Every result carries a `nextStep` computed from real state. The
 *    description is read once while choosing a tool; the result is read
 *    mid-work while choosing what to do next, which is the moment that
 *    actually decides whether the sequence gets followed.
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

  /**
   * `nextStep` goes FIRST in the serialised object on purpose - it's the
   * line most likely to be read in full when a large brief follows it.
   */
  const json = (value: unknown, nextStep?: string) => {
    const payload = nextStep && value && typeof value === "object" ? { nextStep, ...(value as object) } : value;
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  };
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
          const repo = activeRepo(dir);
          return json({ reset: true, activeRepo: repo, note: "Back to automatic detection." }, guide.afterSetRepo(repo.remoteUrl, dir));
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
          return json({ activeRepo: activeRepo(root), how: "set directly from the path you gave" }, guide.afterSetRepo(remote, root));
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
          const repo = activeRepo(found);
          return json({ activeRepo: repo, how }, guide.afterSetRepo(repo.remoteUrl, found));
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
        "Returns the current shared plan from .hub/ in this repo: all tasks (status/owner/declared interface) and recent teammate activity. Pulls the latest from git first. No prerequisites. Narrower than get_handoff_brief, which is the right call when joining a session or picking up someone else's work - this one is for a quick re-check of the task list mid-session.",
      inputSchema: {},
    },
    async () => {
      try {
        const dir = await cwd();
        const result = hub.getContext(dir);
        return json({ activeRepo: activeRepo(dir), ...result }, guide.afterGetContext(result.tasks));
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
        "Records that a piece of work exists, so a teammate's agent can see it before starting the same thing. Requires nothing beforehand; required before editing files for work that isn't already a declared task. Leaves the task UNCLAIMED - owner is not set to you - so claim_task is the necessary follow-up if you're the one building it. Commits and pushes to .hub/tasks/. Returns `conflicts` (other declared tasks touching the same scope) and `recentActivityNearby` (real git commits touching this scope in the last 10 minutes, from anyone else - this catches a teammate who is mid-edit right now and never declared a task at all).",
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
        const r = hub.declareTask(await cwd(), { memberName, agent: agentLabel(), title, scope, declaredInterface, assumptions, dependsOn });
        return json(r, guide.afterDeclareTask(r.task, r.conflicts, r.recentActivityNearby, r.unknownDependencies));
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
        "Takes ownership of an existing task so teammates' agents stop treating it as available. Requires a task that already exists (from get_context, get_handoff_brief, or declare_task). Required before editing files that fall inside that task's scope. Also records the current commit as the task's base, which is what get_diff_for_task later diffs against. Returns `recentActivityNearby` (commits to this scope in the last 10 minutes from anyone else) and `blockedBy` (dependencies not yet done). Neither blocks the claim; `blockedBy` in particular means the thing you're about to build against does not exist yet.",
      inputSchema: { memberName: z.string().optional(), taskId: z.string() },
    },
    async ({ memberName, taskId }) => {
      try {
        const r = hub.claimTask(await cwd(), { memberName, agent: agentLabel(), taskId });
        return json(r, guide.afterClaimTask(r, r.blockedBy, r.recentActivityNearby));
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
        "Moves a task to a new status and, for 'done', stores the permanent design record teammates inherit. Requires a claimed task; for status 'done' it also requires a prior get_diff_for_task call, because `completion.filesChanged` must come from the real diff rather than recollection of a long session. `completion` uses a fixed shape rather than a prose summary - a structured record survives being read by a different model later, where prose gets reinterpreted: whatWasBuilt (1-3 sentences), decisions (each with decision/why/alternativesConsidered), filesChanged (each with path/purpose), knownLimitations, nextSteps. Status 'abandoned' with `abandonReason` is the correct call when changing direction without finishing - it makes the task reclaimable and shows the dead end honestly, where a task silently left 'in_progress' reads to everyone else as still being worked on. A response containing `uncommittedFileWarnings` means the listed code is not actually pushed and teammates will not see it.",
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
          .describe("Required in practice when status is 'done'. Build filesChanged from get_diff_for_task output."),
        abandonReason: z.string().optional().describe("Required in practice when status is 'abandoned' - why you stopped without finishing."),
      },
    },
    async ({ memberName, taskId, status, completion, abandonReason }) => {
      try {
        const r = hub.updateTaskStatus(await cwd(), { memberName, agent: agentLabel(), taskId, status, completion, abandonReason });
        return json(r, guide.afterUpdateStatus(r, r.uncommittedFileWarnings));
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
        "Broadcasts what you're doing right now, so teammates' get_context/get_handoff_brief calls show it. No prerequisites. This is a status ping only - it is not a substitute for update_task_status, which is what actually records work. Kind 'pivoted' is the one to use when changing approach mid-task without abandoning it, with detail saying what you were doing, what you're doing instead, and why, so teammates stop working from a plan that is now stale.",
      inputSchema: {
        memberName: z.string().optional(),
        kind: z.string().describe("e.g. 'started', 'editing', 'committed', 'finished', 'pivoted'."),
        detail: z.string(),
        files: z.array(z.string()).optional(),
      },
    },
    async ({ memberName, kind, detail, files }) => {
      try {
        return json(hub.logActivity(await cwd(), { memberName, agent: agentLabel(), kind, detail, files }), guide.afterLogActivity());
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
        "Attaches a short rationale to one file you just finished touching - what you did and why it looks that way. Requires the file to exist. Pinned to the current commit as an anchor, so get_file_history can tell a later reader whether the file has changed since and therefore whether the note is still trustworthy. Complements a task completion rather than repeating it: the completion says what was built, a file note says why this particular file ended up like this.",
      inputSchema: {
        memberName: z.string().optional(),
        filePath: z.string(),
        summary: z.string(),
        reasoning: z.string().optional(),
      },
    },
    async ({ memberName, filePath, summary, reasoning }) => {
      try {
        return json(hub.recordFileNote(await cwd(), { memberName, agent: agentLabel(), filePath, summary, reasoning }), guide.afterRecordFileNote(filePath));
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
        "Returns the rationale trail for one file - what teammates did to it and why. No prerequisites. Each note carries an anchorStatus: 'verified' (file unchanged since the note was written, so it can be trusted), 'changed' (modified since - the file must be re-read before relying on the note), 'gone' (deleted), 'unknown'.",
      inputSchema: { filePath: z.string() },
    },
    async ({ filePath }) => {
      try {
        const r = hub.getFileHistory(await cwd(), filePath);
        return json(r, guide.afterGetFileHistory(r.notes, filePath));
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
        "Returns everything that changed since the task was claimed - committed and uncommitted - as a file list, a diff stat, and (when not enormous) the full patch. Requires a claimed task, since the claim is what records the base commit. This is a prerequisite of update_task_status with status 'done': in a long session it is easy to forget files touched early or to report files from an approach later reverted, and because `uncommittedFileWarnings` only checks the paths a completion lists, an under-reported file list also quietly disables that safety check.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      try {
        const r = hub.getDiffForTask(await cwd(), taskId);
        return json(r, guide.afterGetDiff(taskId, r.files.length, r.baseCommit !== null));
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
        "Returns every status transition a task went through (todo -> claimed -> in_progress -> done/abandoned) with who made each change and when. No prerequisites. Useful when the current state alone doesn't explain how a task got there - e.g. it was abandoned, reclaimed, then abandoned again, which usually means the obvious approach doesn't work.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      try {
        const r = hub.getTaskHistory(await cwd(), taskId);
        return json(r, guide.afterGetTaskHistory(r.history.length));
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
        "Fast single-file freshness check. No prerequisites, and cheap enough to call routinely. Required before editing any file that is part of a shared interface, or any file not yet touched this session, in a session that has been running a while - a session-start snapshot cannot see a teammate committing to this exact file an hour later. Returns anchor-verified notes on the file plus real commits from anyone else touching it in the last 15 minutes (your own recent commits to it are excluded).",
      inputSchema: { filePath: z.string(), memberName: z.string().optional().describe("Defaults to git config user.name.") },
    },
    async ({ filePath, memberName }) => {
      try {
        const r = hub.checkFileBeforeEdit(await cwd(), filePath, memberName);
        return json(r, guide.afterCheckFile(filePath, r.notes, r.recentCommitters));
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
        "Returns the two living plan documents: requirements (the why/what) and design (the architecture/how). No prerequisites. Reads intent rather than status - the complement to get_context, which reads status rather than intent.",
      inputSchema: {},
    },
    async () => {
      try {
        const r = hub.getPlan(await cwd());
        return json(r, guide.afterGetPlan(r.requirements, r.design));
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
        "Replaces the full content of one plan document (requirements.md or design.md). Requires a prior get_plan call, because this overwrites rather than appends - the whole document has to be edited and passed back. This is the shared source of truth for project intent that every teammate's agent reads at session start, so it is the right place for a direction change and the wrong place for per-task detail.",
      inputSchema: {
        memberName: z.string().optional(),
        doc: z.enum(["requirements", "design"]),
        content: z.string().describe("Full replacement markdown content for this document."),
      },
    },
    async ({ memberName, doc, content }) => {
      try {
        return json(hub.updatePlan(await cwd(), { memberName, doc, content }), guide.afterUpdatePlan(doc));
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
        "The single call for joining a session on a shared repo or picking up work someone else started. No prerequisites, and it replaces assembling context from several separate calls. Deterministically bundles: requirements + design (why/how), active and unclaimed tasks with their blockers (what's left and what's actually startable), recently completed tasks with structured completion reports (what was just built, the decisions and why), recently abandoned tasks with the reason they were dropped (so a dead end doesn't get walked twice, and half-finished code is explained), recent teammate activity, and anchor-verified file history for every file those completions touched. Optionally filter by `scope` to focus on one area.",
      inputSchema: {
        scope: z.array(z.string()).optional().describe("Filter to tasks/files touching any of these scope tags. Omit for everything."),
        doneLimit: z.number().optional().describe("Max recently-done tasks to include (default 10)."),
      },
    },
    async ({ scope, doneLimit }) => {
      try {
        const dir = await cwd();
        const brief = hub.getHandoffBrief(dir, { scope, doneLimit });
        return json({ activeRepo: activeRepo(dir), ...brief }, guide.afterHandoffBrief(brief));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  registerPrompts(server, cwd, activeRepo);
  return server;
}

/**
 * MCP prompts are the protocol's own affordance for "here is how this
 * server is meant to be used, as a sequence" - and unlike a tool
 * description, a prompt is user-invocable (in Claude Code these appear as
 * /mcp__hub-server__<name>). That gives a person a way to force the correct
 * sequence when the model skipped it, which is the failure mode we actually
 * measured. Both prompts embed live state, so the model gets the real task
 * IDs rather than a template telling it to go find them.
 */
function registerPrompts(
  server: McpServer,
  cwd: () => Promise<string>,
  activeRepo: (dir: string) => { localPath: string; remoteUrl: string | null }
): void {
  const text = (body: string) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: body } }],
  });

  server.registerPrompt(
    "start_work",
    {
      title: "Start work on this shared repo",
      description:
        "Load the team's current state and the order to work in. Use at the start of any session on a repo shared with teammates, before writing any code.",
      argsSchema: { intent: z.string().optional().describe("What you're about to work on, if you know already.") },
    },
    async ({ intent }) => {
      try {
        const dir = await cwd();
        const repo = activeRepo(dir);
        const brief = hub.getHandoffBrief(dir, {});
        return text(
          [
            `You are working in ${repo.remoteUrl ?? repo.localPath}, a repo shared with teammates who each use their own AI coding agent.`,
            `Their agents cannot see this session, and this session cannot see theirs. The .hub/ directory in this repo is the only thing that carries context between you.`,
            "",
            intent ? `The user wants to work on: ${intent}` : `The user has not said what they want yet.`,
            "",
            "Here is the team's current state:",
            "",
            "```json",
            JSON.stringify(brief, null, 2),
            "```",
            "",
            "Work in this order:",
            "1. Tell the user, in one line, what teammates have already finished, so they do not re-explain it.",
            "2. Do not re-implement anything in recentlyDone, and do not start anything in activeTasks that has an owner.",
            "3. Before editing any file: claim_task on an existing task, or declare_task then claim_task for new work.",
            "4. While editing a shared file in a long session: check_file_before_edit first.",
            "5. When finished: get_diff_for_task, then update_task_status with a completion built from that diff, then record_file_note on files whose reasoning is not obvious.",
            "6. If you change direction without finishing, update_task_status with 'abandoned' and a reason - do not just go quiet.",
          ].join("\n")
        );
      } catch (err) {
        return text(
          `hub-server could not read team state: ${err instanceof Error ? err.message : String(err)}. ` +
            `Check this is a git repo, or call set_repo with the right repo URL or path, then try again.`
        );
      }
    }
  );

  server.registerPrompt(
    "finish_task",
    {
      title: "Finish and hand off a task",
      description:
        "Close out a task correctly: diff what actually changed, write the structured completion, and verify the code is really pushed.",
      argsSchema: { taskId: z.string().describe("The task you're finishing.") },
    },
    async ({ taskId }) => {
      try {
        const dir = await cwd();
        const diff = hub.getDiffForTask(dir, taskId);
        return text(
          [
            `Close out task ${taskId}. This is what actually changed since it was claimed - use it, not your memory of the session:`,
            "",
            "```json",
            JSON.stringify(diff, null, 2),
            "```",
            "",
            "Then:",
            `1. Call update_task_status with taskId "${taskId}", status "done", and a completion whose filesChanged lists every file above with what it is for. Leaving files out also disables the not-pushed check, which only inspects the paths you list.`,
            "2. Record the real decisions in completion.decisions - what you chose, why, and what you rejected. A teammate's agent reading this later has no other way to know why the code looks like this.",
            "3. If the response contains uncommittedFileWarnings, the code is not pushed. Commit and push it before telling the user this is done.",
            "4. Call record_file_note on any file whose reasoning would not be obvious to someone opening it cold.",
          ].join("\n")
        );
      } catch (err) {
        return text(
          `hub-server could not diff task ${taskId}: ${err instanceof Error ? err.message : String(err)}. ` +
            `Call get_context to check the task ID, and claim_task if it was never claimed (the claim is what records the base commit).`
        );
      }
    }
  );
}
