import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./pathEncoding.js";

export const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
export const TASKS_FILE = path.join(DATA_DIR, "tasks.json");
export const ASSIGNMENTS_FILE = path.join(DATA_DIR, "assignments.json");
export const POMODOROS_FILE = path.join(DATA_DIR, "pomodoros.json");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const txt = await fs.readFile(filePath, "utf8");
    return JSON.parse(txt) as T;
  } catch (e: any) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}
