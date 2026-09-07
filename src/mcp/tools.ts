import { customAlphabet } from "nanoid";
import {
  findRepoRoot,
  getMemberName,
  commitAndPush,
  syncBeforeRead,
  currentCommit,
  checkAnchor,
  checkFileCommitStatus,
  recentCommitters,
  fileVersionHistory,
  diffSince,
  type DiffSince,
} from "../git/repo.js";
import { relativeToRepo } from "../store/paths.js";
import { ACTIVE_STATUSES, getTask, listTasks, overlappingScope, taskFilePath, writeTask } from "../store/tasks.js";
import { listActivity, writeActivity } from "../store/activity.js";
import { listFileNotes, writeFileNote } from "../store/notes.js";
import { readPlanDoc, writePlanDoc, planFilePath, type PlanDoc } from "../store/plan.js";
import type {
  ActivityEvent,
  AnchorStatus,
  BlockedBy,
  Context,
  Decision,
  FileChange,
  FileNote,
  HandoffBrief,
  Task,
  TaskCompletion,
  TaskStatus,
} from "../types.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export class HubConflict extends Error {}

function now(): number {
  return Date.now();
}

function repoRoot(cwd: string): string {
  return findRepoRoot(cwd);
}

function actor(root: string, memberName?: string): string {
  return memberName?.trim() || getMemberName(root);
}


/** "Pranav via claude-code" for commit subjects - the tool name only, no version, to keep git log scannable. */
function byline(member: string, agent?: string | null): string {
  const short = agent ? String(agent).split(" ")[0] : null;
  return short ? `${member} via ${short}` : member;
}

export function getContext(cwd: string): Context & { syncMessage?: string } {
  const root = repoRoot(cwd);
  const sync = syncBeforeRead(root);
  return {
    tasks: listTasks(root),
    recentActivity: listActivity(root),
    syncMessage: sync.message,
  };
}

export function declareTask(
  cwd: string,
  input: { memberName?: string; agent?: string | null; title: string; scope: string[]; declaredInterface?: string; assumptions?: string; dependsOn?: string[] }
): {
  task: Task;
  conflicts: Task[];
  recentActivityNearby: { author: string; when: string; subject: string }[];
  unknownDependencies?: string[];
  syncMessage?: string;
} {
  const root = repoRoot(cwd);
  const sync = syncBeforeRead(root);
  // Declaring is proposing, not claiming - `member` only appears in the
  // commit message. Leave owner null so this task is pickup-able by anyone
  // (including the declarer, via a follow-up claim_task call) - this is what
  // makes "one person scaffolds a plan of unclaimed tasks" actually work.
  const member = actor(root, input.memberName);

  const active = listTasks(root).filter((t) => ACTIVE_STATUSES.includes(t.status));
  const conflicts = active.filter((t) => overlappingScope(t.scope, input.scope).length > 0);

  // Pure git, no live channel: has anyone else committed against this scope
  // VERY recently? Catches a teammate mid-edit right now even if they never
  // declared a task for it - this is the answer to "shouldn't the other
  // agent know someone's doing something" that doesn't need new infra.
  const recentActivityNearby = recentCommitters(root, { paths: input.scope, windowSeconds: 600, excludeAuthor: member });

  // Flag dependency IDs that don't resolve to a real task, rather than
  // silently storing a dangling reference nobody notices until claim time.
  const dependsOn = input.dependsOn ?? [];
  const unknownDependencies = dependsOn.filter((id) => !getTask(root, id));

  const task: Task = {
    id: nanoid(),
    title: input.title,
    scope: input.scope,
    status: "todo",
    owner: null,
    agent: input.agent ?? null,
    declaredInterface: input.declaredInterface ?? null,
    assumptions: input.assumptions ?? null,
    completion: null,
    abandonReason: null,
    dependsOn,
    baseCommit: null,
    createdAt: now(),
    updatedAt: now(),
  };
  const path = writeTask(root, task);
  commitAndPush(root, [relativeToRepo(root, path)], `hub: declare task "${task.title}" (${byline(member, input.agent)})`);

  return {
    task,
    conflicts,
    recentActivityNearby,
    ...(unknownDependencies.length > 0 ? { unknownDependencies } : {}),
    syncMessage: sync.message,
  };
}

/**
 * Which of a task's dependencies aren't finished yet, resolved fresh at
 * read time (a dependency can be completed after this task was declared).
 */
function resolveBlockedBy(root: string, task: Task): BlockedBy[] {
  return (task.dependsOn ?? [])
    .map((id): BlockedBy | null => {
      const dep = getTask(root, id);
      if (!dep) return { taskId: id, title: "(task not found)", status: "missing" };
      if (dep.status === "done") return null;
      return { taskId: id, title: dep.title, status: dep.status };
    })
    .filter((x): x is BlockedBy => x !== null);
}

export function claimTask(
  cwd: string,
  input: { memberName?: string; agent?: string | null; taskId: string }
): Task & {
  recentActivityNearby: { author: string; when: string; subject: string }[];
  blockedBy?: BlockedBy[];
} {
  const root = repoRoot(cwd);
  syncBeforeRead(root);
  const member = actor(root, input.memberName);

  const existing = getTask(root, input.taskId);
  if (!existing) throw new HubConflict(`No task ${input.taskId} in .hub/tasks/.`);
  if (existing.owner && existing.owner !== member && ACTIVE_STATUSES.includes(existing.status)) {
    throw new HubConflict(`Task "${existing.title}" is already claimed by ${existing.owner}.`);
  }

  // Ownership check passed, but has someone touched this scope in the last
  // few minutes anyway (editing directly, without declaring a task)? Surface
  // it as a warning rather than blocking - it might be stale activity, but
  // worth a second look before diving in.
  const recentActivityNearby = recentCommitters(root, { paths: existing.scope, windowSeconds: 600, excludeAuthor: member });

  // Unfinished dependencies - a warning, not a block. Scope-overlap
  // detection can't see these (dependent tasks usually touch different
  // files entirely), so without this you'd start building against
  // something that doesn't exist yet and get no signal at all.
  const blockedBy = resolveBlockedBy(root, existing);

  const updated: Task = {
    ...existing,
    owner: member,
    agent: input.agent ?? existing.agent,
    status: "claimed",
    // Mark where work starts, so get_diff_for_task has something to diff
    // against later. Don't overwrite it if this task was claimed before.
    baseCommit: existing.baseCommit ?? currentCommit(root),
    updatedAt: now(),
  };
  const path = writeTask(root, updated);

  commitAndPush(root, [relativeToRepo(root, path)], `hub: ${byline(member, input.agent)} claims "${updated.title}"`, () => {
    // Push was rejected - a teammate pushed first. Re-check before retrying:
    // if THEY claimed this exact task in the meantime, surface a real
    // conflict instead of silently overwriting their claim.
    const latest = getTask(root, input.taskId);
    if (latest && latest.owner && latest.owner !== member && ACTIVE_STATUSES.includes(latest.status)) {
      throw new HubConflict(`Lost the race - "${latest.title}" was just claimed by ${latest.owner}.`);
    }
  });

  return {
    ...updated,
    recentActivityNearby,
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
  };
}

export function updateTaskStatus(
  cwd: string,
  input: {
    memberName?: string;
    agent?: string | null;
    taskId: string;
    status: TaskStatus;
    completion?: { whatWasBuilt: string; decisions?: Decision[]; filesChanged?: FileChange[]; knownLimitations?: string; nextSteps?: string };
    abandonReason?: string;
  }
): Task & { uncommittedFileWarnings?: string[] } {
  const root = repoRoot(cwd);
  syncBeforeRead(root);
  const member = actor(root, input.memberName);

  const existing = getTask(root, input.taskId);
  if (!existing) throw new HubConflict(`No task ${input.taskId} in .hub/tasks/.`);

  const completion: TaskCompletion | null = input.completion
    ? {
        whatWasBuilt: input.completion.whatWasBuilt,
        decisions: input.completion.decisions ?? [],
        filesChanged: input.completion.filesChanged ?? [],
        knownLimitations: input.completion.knownLimitations,
        nextSteps: input.completion.nextSteps,
      }
    : existing.completion;

  const updated: Task = {
    ...existing,
    status: input.status,
    agent: input.agent ?? existing.agent,
    completion,
    abandonReason: input.abandonReason ?? existing.abandonReason,
    updatedAt: now(),
  };
  const path = writeTask(root, updated);
  commitAndPush(root, [relativeToRepo(root, path)], `hub: ${byline(member, input.agent)} sets "${updated.title}" -> ${input.status}`);

  // Catches the "marked done, but the real code never left this laptop"
  // pattern (observed twice) at the moment it happens, not weeks later when
  // a teammate discovers their handoff brief was lying to them.
  let uncommittedFileWarnings: string[] | undefined;
  if (input.status === "done" && completion?.filesChanged?.length) {
    const problems = completion.filesChanged
      .map((fc) => ({ path: fc.path, status: checkFileCommitStatus(root, fc.path) }))
      .filter((r) => r.status !== "committed_and_pushed");
    if (problems.length > 0) {
      uncommittedFileWarnings = problems.map(
        (p) => `${p.path}: ${p.status} - teammates will NOT see this file's content until you commit and push it.`
      );
    }
  }

  return uncommittedFileWarnings ? { ...updated, uncommittedFileWarnings } : updated;
}

export function logActivity(
  cwd: string,
  input: { memberName?: string; agent?: string | null; kind: string; detail: string; files?: string[] }
): ActivityEvent {
  const root = repoRoot(cwd);
  // Sync BEFORE committing, not just on retry-after-rejection: otherwise a
  // clone that's behind by several commits builds its new commit on a
  // stale base, and if the retry's ff-only merge then hits real
  // divergence (not a genuine file conflict - .hub/activity/ files never
  // collide - just a self-inflicted stale base), it fails permanently
  // instead of the normal "1 commit behind, trivial fast-forward" case.
  syncBeforeRead(root);
  const member = actor(root, input.memberName);

  const event: ActivityEvent = {
    id: nanoid(),
    member,
    agent: input.agent ?? null,
    kind: input.kind,
    detail: input.detail,
    files: input.files ?? [],
    createdAt: now(),
  };
  const path = writeActivity(root, event);
  commitAndPush(root, [relativeToRepo(root, path)], `hub: ${byline(member, input.agent)} activity - ${input.kind}`);
  return event;
}

export function recordFileNote(
  cwd: string,
  input: { memberName?: string; agent?: string | null; filePath: string; summary: string; reasoning?: string }
): FileNote {
  const root = repoRoot(cwd);
  // Same reasoning as logActivity: sync before committing, not just on
  // retry. Also matters here specifically because the anchor pins to
  // currentCommit(root) right below - syncing first means the anchor
  // reflects the actual latest HEAD, not a stale one.
  syncBeforeRead(root);
  const member = actor(root, input.memberName);

  const note: FileNote = {
    id: nanoid(),
    member,
    agent: input.agent ?? null,
    filePath: input.filePath,
    summary: input.summary,
    reasoning: input.reasoning ?? null,
    // Pinned to the commit this was true as of - re-verified on every read
    // (checkAnchor) so a reader knows if the file has moved on since.
    anchor: { path: input.filePath, commitHash: currentCommit(root) },
    createdAt: now(),
  };
  const path = writeFileNote(root, note);
  commitAndPush(root, [relativeToRepo(root, path)], `hub: ${byline(member, input.agent)} note on ${input.filePath}`);
  return note;
}

function withAnchorStatus(root: string, notes: FileNote[]): (FileNote & { anchorStatus: AnchorStatus })[] {
  return notes.map((n) => ({ ...n, anchorStatus: checkAnchor(root, n.anchor.path, n.anchor.commitHash) }));
}

export function getFileHistory(
  cwd: string,
  filePath: string
): { notes: (FileNote & { anchorStatus: AnchorStatus })[]; syncMessage?: string } {
  const root = repoRoot(cwd);
  const sync = syncBeforeRead(root);
  return { notes: withAnchorStatus(root, listFileNotes(root, filePath)), syncMessage: sync.message };
}

/**
 * The full status-transition history of a task (todo -> claimed ->
 * in_progress -> done/abandoned), oldest first. `.hub/tasks/<id>.json` is
 * overwritten in place on each change (unlike activity/notes), so this
 * sequence isn't otherwise visible even though git already has every
 * version - this just exposes what's already there.
 */
/**
 * What actually changed since this task was claimed - committed and
 * uncommitted. Meant to be called right before writing a completion
 * report, so `filesChanged` comes from the real diff instead of the
 * agent's recollection of a long session. That matters beyond tidiness:
 * `uncommittedFileWarnings` only checks the paths a completion lists, so
 * an under-reported file list quietly defeats that check too.
 */
export function getDiffForTask(cwd: string, taskId: string): DiffSince & { taskId: string; baseCommit: string | null; syncMessage?: string } {
  const root = repoRoot(cwd);
  const sync = syncBeforeRead(root);

  const task = getTask(root, taskId);
  if (!task) throw new HubConflict(`No task ${taskId} in .hub/tasks/.`);

  if (!task.baseCommit) {
    return {
      taskId,
      baseCommit: null,
      files: [],
      stat: "",
      patch: null,
      truncated: false,
      note: "No base commit recorded for this task - it was declared before base commits were tracked, or was never claimed. Claim a task first so there's a 'work starts here' mark to diff against.",
      syncMessage: sync.message,
    };
  }

  return { taskId, baseCommit: task.baseCommit, ...diffSince(root, task.baseCommit), syncMessage: sync.message };
}

export function getTaskHistory(cwd: string, taskId: string): { history: { commitHash: string; author: string; when: string; subject: string; task: Task | null }[]; syncMessage?: string } {
  const root = repoRoot(cwd);
  const sync = syncBeforeRead(root);
  const relPath = relativeToRepo(root, taskFilePath(root, taskId));
  const versions = fileVersionHistory(root, relPath);
  return {
    history: versions.map((v) => {
      let task: Task | null = null;
      try {
        task = JSON.parse(v.content);
      } catch {
        task = null;
      }
      return { commitHash: v.commitHash, author: v.author, when: v.when, subject: v.subject, task };
    }),
    syncMessage: sync.message,
  };
}

/**
 * Fast, single-file check meant to run right before an edit (PreToolUse
 * hook), not a full get_handoff_brief re-fetch. Answers exactly the
 * staleness question that caused the balances.settlements regression: has
 * ANYONE touched this file since I last looked, and does its note history
 * say something I should know before changing it?
 */
export function checkFileBeforeEdit(
  cwd: string,
  filePath: string,
  memberName?: string
): {
  notes: (FileNote & { anchorStatus: AnchorStatus })[];
  recentCommitters: { author: string; when: string; subject: string }[];
  syncMessage?: string;
} {
  const root = repoRoot(cwd);
  const sync = syncBeforeRead(root);
  // Exclude the caller's own commits, same as every other recentCommitters
  // call site - without this, your own recent commit to this exact file
  // reads back as "someone ELSE touched this", which is a false conflict
  // warning on the single most common case (you, continuing your own work).
  const member = actor(root, memberName);
  return {
    notes: withAnchorStatus(root, listFileNotes(root, filePath)),
    recentCommitters: recentCommitters(root, { paths: [filePath], windowSeconds: 900, excludeAuthor: member }),
    syncMessage: sync.message,
  };
}

export function getPlan(cwd: string): { requirements: string; design: string; syncMessage?: string } {
  const root = repoRoot(cwd);
  const sync = syncBeforeRead(root);
  return { requirements: readPlanDoc(root, "requirements"), design: readPlanDoc(root, "design"), syncMessage: sync.message };
}

export function updatePlan(cwd: string, input: { memberName?: string; doc: PlanDoc; content: string }): { path: string } {
  const root = repoRoot(cwd);
  syncBeforeRead(root);
  const member = actor(root, input.memberName);
  const path = writePlanDoc(root, input.doc, input.content);
  commitAndPush(root, [relativeToRepo(root, path)], `hub: ${member} updates ${input.doc}.md`);
  return { path: planFilePath(root, input.doc) };
}

/**
 * One deterministic call assembling everything a joining agent needs:
 * requirements + design (the why/how), active tasks (what's left), recently
 * completed tasks with their structured completion reports (what was just
 * built and why), recent activity, and anchor-verified file history for
 * every file those completions touched. This is what hooks auto-inject -
 * the point is that every agent gets the SAME assembled payload regardless
 * of which harness/model it is or which tools it would have thought to call
 * on its own.
 */
export function getHandoffBrief(cwd: string, opts: { scope?: string[]; doneLimit?: number } = {}): HandoffBrief & { syncMessage?: string } {
  const root = repoRoot(cwd);
  const sync = syncBeforeRead(root);

  const allTasks = listTasks(root);
  const inScope = (t: Task) => !opts.scope || opts.scope.length === 0 || overlappingScope(t.scope, opts.scope).length > 0;

  const activeTasks = allTasks
    .filter((t) => ACTIVE_STATUSES.includes(t.status) && inScope(t))
    .map((t) => ({ ...t, blockedBy: resolveBlockedBy(root, t) }));
  const recentlyDone = allTasks
    .filter((t) => t.status === "done" && inScope(t))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, opts.doneLimit ?? 10);
  const recentlyAbandoned = allTasks
    .filter((t) => t.status === "abandoned" && inScope(t))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, opts.doneLimit ?? 10);

  const touchedFiles = new Set<string>();
  for (const t of recentlyDone) {
    for (const fc of t.completion?.filesChanged ?? []) touchedFiles.add(fc.path);
  }

  const fileHistory: HandoffBrief["fileHistory"] = {};
  for (const path of touchedFiles) {
    fileHistory[path] = withAnchorStatus(root, listFileNotes(root, path));
  }

  return {
    requirements: readPlanDoc(root, "requirements"),
    design: readPlanDoc(root, "design"),
    activeTasks,
    recentlyDone,
    recentlyAbandoned,
    recentActivity: listActivity(root),
    fileHistory,
    syncMessage: sync.message,
  };
}

export { taskFilePath };
