import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileNote } from "../types.js";
import { notesDirFor, sanitizeRelativePath } from "./paths.js";

export function listFileNotes(repoRoot: string, filePath: string): FileNote[] {
  const dir = notesDirFor(repoRoot, filePath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { const n = JSON.parse(readFileSync(join(dir, f), "utf8")); if (n.agent === undefined) n.agent = null; return n as FileNote; })
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function writeFileNote(repoRoot: string, note: FileNote): string {
  sanitizeRelativePath(note.filePath);
  const dir = notesDirFor(repoRoot, note.filePath);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${note.createdAt}-${note.id}.json`);
  writeFileSync(path, JSON.stringify(note, null, 2) + "\n", "utf8");
  return path;
}
