/**
 * `nextStep` strings attached to every tool result.
 *
 * Why this file exists: a study of real-world MCP servers found the large
 * majority of tool descriptions have defects that cause models to pick the
 * wrong tool or skip tools entirely - which is exactly the failure we
 * measured here (a live session built a whole feature calling zero
 * coordination tools, despite a SessionStart hook explicitly telling it to).
 *
 * The finding that matters: a tool's DESCRIPTION is read once, when the
 * model is deciding what to call. Its RESULT is read in the middle of the
 * work, when the model is deciding what to do next - so the result is the
 * far stronger place to steer from. Every tool here returns a `nextStep`
 * computed from actual state (real task IDs, real warnings), not a static
 * sentence, because a concrete instruction naming an ID gets followed and a
 * generic reminder gets skimmed.
 */

import type { BlockedBy, Task } from "../types.js";

/** Tasks nobody has claimed - the ones a joining agent can pick up. */
function unclaimed(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status === "todo" && !t.owner);
}

function describe(t: Task): string {
  return `${t.id} ("${t.title}")`;
}

function blockedNote(blockedBy: BlockedBy[] | undefined): string | null {
  if (!blockedBy || blockedBy.length === 0) return null;
  const list = blockedBy.map((b) => `${b.taskId} ("${b.title}", ${b.status})`).join(", ");
  return `BLOCKED: this depends on ${list}, which is not done. Building against it now means building against something that does not exist yet - either do that task first, or confirm with the user that you should stub it.`;
}

export function afterSetRepo(remoteUrl: string | null, localPath: string): string {
  return `Tell the user which repo this is (${remoteUrl ?? localPath}) so a wrong one gets caught now rather than after you have written to it. Then call get_handoff_brief to load what the team has already done.`;
}

export function afterGetContext(tasks: Task[]): string {
  const open = unclaimed(tasks);
  if (open.length > 0) {
    return `Unclaimed tasks exist: ${open.slice(0, 3).map(describe).join(", ")}. If you are about to work on one of these, call claim_task first so a teammate's agent does not start the same thing. If your work is something else, call declare_task. Either way, do it BEFORE editing files.`;
  }
  if (tasks.length === 0) {
    return `No tasks declared yet. Call declare_task before you start building, so teammates' agents can see what you are taking on.`;
  }
  return `Everything declared is already owned. Call declare_task for whatever you are about to build, then claim_task on it.`;
}

export function afterDeclareTask(task: Task, conflicts: Task[], nearby: unknown[], unknownDeps?: string[]): string {
  const parts: string[] = [];
  if (conflicts.length > 0) {
    parts.push(
      `CONFLICT: ${conflicts.map(describe).join(", ")} already cover overlapping files. Read them before continuing - if a teammate is doing this, do not duplicate it.`
    );
  }
  if (nearby.length > 0) {
    parts.push(`Someone else committed to this scope in the last 10 minutes (see recentActivityNearby). They may be mid-edit right now.`);
  }
  if (unknownDeps && unknownDeps.length > 0) {
    parts.push(`These dependency IDs do not resolve to real tasks: ${unknownDeps.join(", ")}. Fix or drop them.`);
  }
  parts.push(
    `This task is declared but NOT claimed - nobody owns it yet. Call claim_task with taskId "${task.id}" now if you are the one building it.`
  );
  return parts.join(" ");
}

export function afterClaimTask(task: Task, blockedBy: BlockedBy[] | undefined, nearby: unknown[]): string {
  const parts: string[] = [];
  const blocked = blockedNote(blockedBy);
  if (blocked) parts.push(blocked);
  if (nearby.length > 0) {
    parts.push(`Someone else committed to this scope in the last 10 minutes (see recentActivityNearby) - check you are not about to redo or overwrite it.`);
  }
  parts.push(
    `You own ${task.id} and its base commit is recorded. Now: edit the files. When you believe you are finished, call get_diff_for_task with taskId "${task.id}" FIRST, then update_task_status with status "done" and a completion written from that diff.`
  );
  return parts.join(" ");
}

export function afterUpdateStatus(task: Task, uncommitted: string[] | undefined): string {
  if (uncommitted && uncommitted.length > 0) {
    return `DO NOT tell the user this is done yet. The files you listed are not committed and pushed, so teammates will pull this task marked "done" and find none of the code. Commit and push them for real, then say it is finished.`;
  }
  if (task.status === "done") {
    const parts = [`Task closed and pushed.`];
    // A decision is stored on this task's completion, but nothing here
    // cross-checks it against design.md - a decision that quietly picks a
    // different service/interface/approach than the plan describes will
    // sit right next to that stale plan until someone notices by hand, and
    // a teammate who reads design.md alone will build against the old one.
    if ((task.completion?.decisions?.length ?? 0) > 0) {
      parts.push(
        `You recorded ${task.completion!.decisions.length} decision(s). If any of them chose something design.md doesn't already describe - a different service, a different interface, a different approach than what was planned - call get_plan and then update_plan now. A decision that only lives in this one task's completion is easy for the next agent to miss if the plan doc they read at session start still describes the old approach.`
      );
    }
    parts.push(
      `For any file in filesChanged where a future reader would ask "why is it like this", call record_file_note - the completion report says what was built, a file note says why that file looks the way it does. Then call get_context to see what is left.`
    );
    return parts.join(" ");
  }
  if (task.status === "abandoned") {
    return `Marked abandoned with a reason, so teammates see a dead end instead of a task that looks like it is still being worked on. Call get_context to pick up what is next.`;
  }
  return `Status recorded. Keep going; call get_diff_for_task with taskId "${task.id}" when you think you are finished.`;
}

export function afterLogActivity(): string {
  return `Broadcast to teammates. This is a status ping, not a record of work - a finished piece of work still needs update_task_status with a completion, and a finished file still needs record_file_note.`;
}

export function afterRecordFileNote(filePath: string): string {
  return `Note pinned to the current commit, so anyone reading it later is told whether ${filePath} has changed since. If the task this belongs to is finished, call update_task_status with a completion.`;
}

export function afterGetFileHistory(notes: { anchorStatus: string }[], filePath: string): string {
  if (notes.length === 0) return `No notes on ${filePath} yet. If you change it, call record_file_note so the next person is not guessing.`;
  const stale = notes.filter((n) => n.anchorStatus === "changed").length;
  if (stale > 0) {
    return `${stale} of these notes are marked "changed" - the file has moved on since they were written. Read the current file before trusting them.`;
  }
  return `All notes verified against the current file. Safe to rely on them.`;
}

export function afterGetDiff(taskId: string, fileCount: number, hasBase: boolean): string {
  if (!hasBase) {
    return `No base commit, so there is nothing to diff against. Claim the task first (claim_task records the base), or write the completion from what you can verify in the repo right now.`;
  }
  return `Write update_task_status completion.filesChanged from these ${fileCount} files, not from memory. Files you leave out are also skipped by the not-pushed check, so an incomplete list quietly disables it.`;
}

export function afterGetTaskHistory(count: number): string {
  return count === 0
    ? `No recorded history - this task has not been committed to .hub/ yet.`
    : `This is how the task actually got to its current state. If it was abandoned and reclaimed, read the abandon reason before repeating the approach that was dropped.`;
}

export function afterCheckFile(filePath: string, notes: { anchorStatus: string }[], committers: unknown[]): string {
  if (committers.length > 0) {
    return `SOMEONE ELSE COMMITTED TO ${filePath} IN THE LAST 15 MINUTES. Re-read the file from disk before editing - your in-context version is probably stale, and overwriting their change is exactly the failure this tool exists to catch.`;
  }
  const stale = notes.filter((n) => n.anchorStatus === "changed").length;
  if (stale > 0) return `Notes on this file are stale (the file changed after they were written). Re-read the file before editing.`;
  return `Clear - nobody else has touched ${filePath} recently. Go ahead and edit, then call record_file_note when you are done with it.`;
}

export function afterGetPlan(requirements: string, design: string): string {
  if (!requirements.trim() && !design.trim()) {
    return `Both plan documents are empty. If the user has described what they are building, call update_plan to write it down - right now nothing tells a teammate's agent what this project is for.`;
  }
  return `This is the team's stated intent. If what the user is now asking for contradicts it, say so before building, and call update_plan once the direction is settled.`;
}

export function afterUpdatePlan(doc: string): string {
  return `${doc}.md replaced and pushed - every teammate's agent reads this on their next session. Now call declare_task for the work this plan implies, if it is not declared already.`;
}

export function afterHandoffBrief(brief: {
  activeTasks: (Task & { blockedBy: BlockedBy[] })[];
  recentlyDone: Task[];
  requirements: string;
  design: string;
}): string {
  const parts: string[] = [];

  const startable = brief.activeTasks.filter((t) => t.blockedBy.length === 0 && !t.owner);
  const owned = brief.activeTasks.filter((t) => t.owner);

  if (owned.length > 0) {
    parts.push(
      `IN PROGRESS BY SOMEONE ELSE: ${owned.slice(0, 3).map((t) => `${describe(t)} - ${t.owner}`).join(", ")}. Do not start these.`
    );
  }
  if (startable.length > 0) {
    parts.push(`Startable now: ${startable.slice(0, 3).map(describe).join(", ")}. Call claim_task before touching their files.`);
  }
  if (brief.activeTasks.length === 0) {
    parts.push(`Nothing is in flight. Whatever the user asks for next, call declare_task then claim_task before you edit anything.`);
  }
  parts.push(
    `Tell the user in one line what the team has already done (from recentlyDone) so they do not re-explain it. Do not re-implement anything listed there.`
  );
  return parts.join(" ");
}
