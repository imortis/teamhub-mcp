import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as hub from "./tools.js";
import { resolveRepoRoot } from "./repo-resolver.js";
import { markSessionActive } from "./session-marker.js";

/**
 * Every tool operates on the project folder - resolved ONCE per server
 * process (i.e. once per session) via resolveRepoRoot: asks the user
 * directly which GitHub repo they're working on (MCP elicitation), which
 * doubles as team identity - whoever answers with the same repo URL shares
 * `.hub/` state - falling back to MCP `roots`/`process.cwd()` if the client
 * doesn't support elicitation. There's no separate workspace ID or auth
 * token: git repo access IS the access control. `memberName` is optional
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

  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const errorResult = (err: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  });

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
        return json(hub.getContext(await cwd()));
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
      },
    },
    async ({ memberName, title, scope, declaredInterface, assumptions }) => {
      try {
        return json(hub.declareTask(await cwd(), { memberName, title, scope, declaredInterface, assumptions }));
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
        "Claim an existing task (e.g. one from get_context) so teammates know you're working on it. Returns `recentActivityNearby` - real commits touching this task's scope in the last 10 minutes from anyone else. A non-empty list doesn't block the claim, but check it before diving in.",
      inputSchema: { memberName: z.string().optional(), taskId: z.string() },
    },
    async ({ memberName, taskId }) => {
      try {
        return json(hub.claimTask(await cwd(), { memberName, taskId }));
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
        "Update a task's status. When marking a task 'done', ALWAYS include `completion` with this fixed shape (not a free-text summary) - a structured report is what stays consistent when a different model reads it later, unlike prose that gets reinterpreted differently by every reader: whatWasBuilt (1-3 sentences), decisions (each with decision/why/alternativesConsidered), filesChanged (each with path/purpose), knownLimitations, nextSteps. This becomes the permanent, queryable design record in .hub/tasks/ for teammates, and feeds get_handoff_brief. IMPORTANT: if the response includes `uncommittedFileWarnings`, the files you listed in `filesChanged` are NOT actually committed/pushed yet - commit and push them for real before telling the user this is done, or teammates will never see the code. If you're changing direction WITHOUT finishing (switching approach, or dropping it), set status 'abandoned' with `abandonReason` instead of just going quiet - an abandoned task is reclaimable by teammates and shows up honestly in get_handoff_brief; a task silently left 'in_progress' forever looks like someone's still on it.",
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
        return json(hub.updateTaskStatus(await cwd(), { memberName, taskId, status, completion, abandonReason }));
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
        return json(hub.logActivity(await cwd(), { memberName, kind, detail, files }));
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
        return json(hub.recordFileNote(await cwd(), { memberName, filePath, summary, reasoning }));
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
        return json(hub.getHandoffBrief(await cwd(), { scope, doneLimit }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}
