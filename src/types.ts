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
  createdAt: number;
  updatedAt: number;
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
  activeTasks: Task[];
  recentlyDone: Task[];
  recentlyAbandoned: Task[];
  recentActivity: ActivityEvent[];
  fileHistory: Record<string, (FileNote & { anchorStatus: AnchorStatus })[]>;
}
