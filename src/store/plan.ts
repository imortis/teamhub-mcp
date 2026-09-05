import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubDir } from "./paths.js";

export type PlanDoc = "requirements" | "design";

const TEMPLATES: Record<PlanDoc, string> = {
  requirements: "# Requirements\n\n(Nothing written yet - what should this project do, and why?)\n",
  design: "# Design\n\n(Nothing written yet - what's the architecture, the key interfaces, the how?)\n",
};

function planDir(repoRoot: string): string {
  return join(hubDir(repoRoot), "plan");
}

export function planFilePath(repoRoot: string, doc: PlanDoc): string {
  return join(planDir(repoRoot), `${doc}.md`);
}

export function readPlanDoc(repoRoot: string, doc: PlanDoc): string {
  const path = planFilePath(repoRoot, doc);
  if (!existsSync(path)) return TEMPLATES[doc];
  return readFileSync(path, "utf8");
}

export function writePlanDoc(repoRoot: string, doc: PlanDoc, content: string): string {
  mkdirSync(planDir(repoRoot), { recursive: true });
  const path = planFilePath(repoRoot, doc);
  writeFileSync(path, content.endsWith("\n") ? content : content + "\n", "utf8");
  return path;
}
