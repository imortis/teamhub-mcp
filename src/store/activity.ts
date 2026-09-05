import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityEvent } from "../types.js";
import { activityDir } from "./paths.js";

export function listActivity(repoRoot: string, limit = 25): ActivityEvent[] {
  const dir = activityDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ActivityEvent)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function writeActivity(repoRoot: string, event: ActivityEvent): string {
  mkdirSync(activityDir(repoRoot), { recursive: true });
  // One file per event (named by timestamp+id) - concurrent writers from
  // different teammates never touch the same file, so git can never produce
  // a merge conflict here.
  const path = join(activityDir(repoRoot), `${event.createdAt}-${event.id}.json`);
  writeFileSync(path, JSON.stringify(event, null, 2) + "\n", "utf8");
  return path;
}
