import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskStatus } from "../types.js";
import { tasksDir } from "./paths.js";

export const ACTIVE_STATUSES: TaskStatus[] = ["todo", "claimed", "in_progress"];

/**
 * Tasks written by an older hub-server version have a free-text `rationale`
 * string instead of a structured `completion`. Normalize on read so that
 * data isn't silently dropped by anything (dashboard, get_handoff_brief)
 * that now only looks at `completion` - old records still show up, just
 * wrapped into the new shape instead of losing their content.
 */
function normalize(raw: any): Task {
  if (!raw.completion && typeof raw.rationale === "string" && raw.rationale) {
    raw.completion = { whatWasBuilt: raw.rationale, decisions: [], filesChanged: [] };
  }
  if (raw.abandonReason === undefined) raw.abandonReason = null;
  if (!Array.isArray(raw.dependsOn)) raw.dependsOn = [];
  if (raw.baseCommit === undefined) raw.baseCommit = null;
  if (raw.agent === undefined) raw.agent = null;
  return raw as Task;
}

export function listTasks(repoRoot: string): Task[] {
  const dir = tasksDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => normalize(JSON.parse(readFileSync(join(dir, f), "utf8"))))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getTask(repoRoot: string, id: string): Task | null {
  const path = join(tasksDir(repoRoot), `${id}.json`);
  if (!existsSync(path)) return null;
  return normalize(JSON.parse(readFileSync(path, "utf8")));
}

export function taskFilePath(repoRoot: string, id: string): string {
  return join(tasksDir(repoRoot), `${id}.json`);
}

export function writeTask(repoRoot: string, task: Task): string {
  mkdirSync(tasksDir(repoRoot), { recursive: true });
  const path = taskFilePath(repoRoot, task.id);
  writeFileSync(path, JSON.stringify(task, null, 2) + "\n", "utf8");
  return path;
}

export function overlappingScope(a: string[], b: string[]): string[] {
  const bSet = new Set(b);
  return a.filter((x) => bSet.has(x));
}
