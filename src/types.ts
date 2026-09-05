export type TaskStatus = "todo" | "claimed" | "in_progress" | "abandoned" | "done";

export interface Decision {
  decision: string;
  why: string;
  alternativesConsidered?: string;
}

export interface FileChange {
  path: string;
  purpose: string;
}

/**
 * Structured completion report, filled in when a task moves to "done".
 * Fixed shape on purpose: prose summaries get reinterpreted differently by
 * different models reading them later - a fixed schema is what stays
 * consistent across Claude/Gemini/GPT, even when wording varies.
 */
export interface TaskCompletion {
  whatWasBuilt: string;
  decisions: Decision[];
  filesChanged: FileChange[];
  knownLimitations?: string;
  nextSteps?: string;
}

export interface Task {
  id: string;
  title: string;
  scope: string[];
  status: TaskStatus;
  owner: string | null;
  declaredInterface: string | null;
  assumptions: string | null;
  completion: TaskCompletion | null;
  /** Why this was abandoned without finishing - a silent stall looks like "still in progress" to everyone else, this makes a pivot visible instead. */
  abandonReason: string | null;
  /**
   * Task IDs this one can't sensibly start before. Scope-overlap conflict
   * detection is blind to this case: "build POST /api/auth" (scope
   * api/auth.ts) and "wire login form to it" (scope LoginForm.tsx) share no
   * files at all, so nothing flags that the second can't start until the
   * first exists.
   */
  dependsOn: string[];
  /**
   * HEAD at the moment this task was claimed - the "work starts here" mark
   * that get_diff_for_task diffs against, so a completion can be written
   * from the actual diff rather than the agent's memory of a long session.
   */
  baseCommit: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A dependency that isn't finished yet, resolved at read time. */
export interface BlockedBy {
  taskId: string;
  title: string;
  status: TaskStatus | "missing";
}

export interface ActivityEvent {
  id: string;
  member: string;
  kind: string;
  detail: string;
  files: string[];
  createdAt: number;
}

export type AnchorStatus = "verified" | "changed" | "gone" | "unknown";

/** A file reference pinned to the commit it was true as of, re-checked at read time. */
export interface Anchor {
  path: string;
  commitHash: string;
}

export interface AnchorCheck extends Anchor {
  status: AnchorStatus;
}

export interface FileNote {
  id: string;
  member: string;
  filePath: string;
  summary: string;
  reasoning: string | null;
  anchor: Anchor;
  createdAt: number;
}

export interface Context {
  tasks: Task[];
  recentActivity: ActivityEvent[];
}

export interface HandoffBrief {
  requirements: string;
  design: string;
  /** Each carries `blockedBy` (empty when nothing's in the way), so you can tell what's actually startable before claiming anything. */
  activeTasks: (Task & { blockedBy: BlockedBy[] })[];
  recentlyDone: Task[];
  recentlyAbandoned: Task[];
  recentActivity: ActivityEvent[];
  fileHistory: Record<string, (FileNote & { anchorStatus: AnchorStatus })[]>;
}
