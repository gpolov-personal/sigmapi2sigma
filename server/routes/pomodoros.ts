import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  ASSIGNMENTS_FILE,
  POMODOROS_FILE,
  PROJECTS_FILE,
  TASKS_FILE,
  readJsonSafe,
  writeJsonAtomic,
} from "../lib/dataStore.js";
import { buildTmuxTree, isTmuxRunning } from "../lib/tmux.js";
import { computeActivitySlice } from "../lib/activity.js";

export const pomodorosRouter = Router();

export interface Pomodoro {
  id: string;
  started_at: string;
  ended_at: string;
  target_duration_minutes: number;
  project_ids: string[];      // ≥1
  task_ids: string[];         // ≥0; every task's project must be in project_ids
  notes: string;
  /** Per-pomodoro task label for the Free project. Empty when Free isn't selected
   *  or when the user didn't type one. Acts as the "task name" analog for Free. */
  freeTaskLabel: string;
  source: "live-timer" | "manual";
  context: {
    tmux_session_names: string[];
    claude_session_ids: string[];
  };
}

interface PomFile { schemaVersion: number; pomodoros: Pomodoro[] }
interface ProjectsFile { schemaVersion: number; projects: { id: string; completed_at: string | null }[] }
interface TasksFile { schemaVersion: number; tasks: { id: string; project_id: string; completed_at: string | null }[] }
interface AssignFile { schemaVersion: number; assignments: Record<string, string> }

const EMPTY_P: PomFile = { schemaVersion: 1, pomodoros: [] };
const EMPTY_PRJ: ProjectsFile = { schemaVersion: 1, projects: [] };
const EMPTY_T: TasksFile = { schemaVersion: 1, tasks: [] };
const EMPTY_A: AssignFile = { schemaVersion: 1, assignments: {} };

async function captureContext(
  projectIds: string[]
): Promise<{ tmux_session_names: string[]; claude_session_ids: string[] }> {
  const a = await readJsonSafe<AssignFile>(ASSIGNMENTS_FILE, EMPTY_A);
  const tmuxNames = new Set<string>();
  for (const [tname, pid] of Object.entries(a.assignments)) {
    if (projectIds.includes(pid)) tmuxNames.add(tname);
  }
  const tmux_session_names = [...tmuxNames];
  if (tmux_session_names.length === 0) {
    return { tmux_session_names: [], claude_session_ids: [] };
  }
  if (!(await isTmuxRunning())) {
    return { tmux_session_names, claude_session_ids: [] };
  }
  const tree = await buildTmuxTree();
  const sids = new Set<string>();
  for (const s of tree) {
    if (!tmuxNames.has(s.name)) continue;
    for (const w of s.windows) {
      for (const p of w.panes) {
        if (p.cmd === "claude" && p.claudeSessionId) sids.add(p.claudeSessionId);
      }
    }
  }
  return { tmux_session_names, claude_session_ids: [...sids] };
}

// Backfill missing freeTaskLabel for old records. Pure read-time normalization;
// not persisted unless the record is otherwise updated.
function normalize(p: Pomodoro): Pomodoro {
  if (typeof p.freeTaskLabel !== "string") return { ...p, freeTaskLabel: "" };
  return p;
}

pomodorosRouter.get("/pomodoros", async (req, res) => {
  const file = await readJsonSafe<PomFile>(POMODOROS_FILE, EMPTY_P);
  const from = typeof req.query.from === "string" ? Date.parse(req.query.from) : null;
  const to = typeof req.query.to === "string" ? Date.parse(req.query.to) : null;
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
  const taskId = typeof req.query.taskId === "string" ? req.query.taskId : null;
  const filtered = file.pomodoros.filter(p => {
    const t = Date.parse(p.started_at);
    if (from !== null && Number.isFinite(from) && t < from) return false;
    if (to !== null && Number.isFinite(to) && t > to) return false;
    if (projectId && !p.project_ids.includes(projectId)) return false;
    if (taskId && !p.task_ids.includes(taskId)) return false;
    return true;
  });
  filtered.sort((a, b) => b.started_at.localeCompare(a.started_at));
  res.json({ pomodoros: filtered.map(normalize) });
});

pomodorosRouter.get("/pomodoros/:id", async (req, res) => {
  const file = await readJsonSafe<PomFile>(POMODOROS_FILE, EMPTY_P);
  const p = file.pomodoros.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "pomodoro not found" });
  res.json(normalize(p));
});

pomodorosRouter.get("/pomodoros/:id/activity", async (req, res) => {
  const file = await readJsonSafe<PomFile>(POMODOROS_FILE, EMPTY_P);
  const p = file.pomodoros.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "pomodoro not found" });
  const slice = await computeActivitySlice(
    p.id,
    p.started_at,
    p.ended_at,
    p.context.tmux_session_names,
    p.context.claude_session_ids
  );
  res.json(slice);
});

pomodorosRouter.post("/pomodoros", async (req, res) => {
  const body = req.body ?? {};
  const { started_at, ended_at, target_duration_minutes, project_ids, task_ids, notes, freeTaskLabel, source, context } = body;

  if (typeof started_at !== "string" || !Number.isFinite(Date.parse(started_at))) {
    return res.status(400).json({ error: "started_at must be ISO string" });
  }
  if (typeof ended_at !== "string" || !Number.isFinite(Date.parse(ended_at))) {
    return res.status(400).json({ error: "ended_at must be ISO string" });
  }
  if (Date.parse(ended_at) < Date.parse(started_at)) {
    return res.status(400).json({ error: "ended_at must be >= started_at" });
  }
  if (!Number.isInteger(target_duration_minutes) || target_duration_minutes < 1) {
    return res.status(400).json({ error: "target_duration_minutes must be integer >= 1" });
  }
  if (!Array.isArray(project_ids) || project_ids.length < 1) {
    return res.status(400).json({ error: "project_ids must be non-empty array" });
  }
  const tIds: string[] = Array.isArray(task_ids) ? task_ids : [];
  if (notes !== undefined && (typeof notes !== "string" || notes.length > 8000)) {
    return res.status(400).json({ error: "notes must be string ≤8000 chars" });
  }
  if (freeTaskLabel !== undefined && (typeof freeTaskLabel !== "string" || freeTaskLabel.length > 200)) {
    return res.status(400).json({ error: "freeTaskLabel must be string ≤200 chars" });
  }
  if (source !== "live-timer" && source !== "manual") {
    return res.status(400).json({ error: "source must be live-timer or manual" });
  }

  const projects = await readJsonSafe<ProjectsFile>(PROJECTS_FILE, EMPTY_PRJ);
  for (const pid of project_ids) {
    const p = projects.projects.find(x => x.id === pid);
    if (!p) return res.status(404).json({ error: `project not found: ${pid}` });
    if (p.completed_at) {
      return res.status(409).json({
        error: `project '${pid}' is completed — reopen it before logging time`,
      });
    }
  }
  const tasks = await readJsonSafe<TasksFile>(TASKS_FILE, EMPTY_T);
  for (const tid of tIds) {
    const t = tasks.tasks.find(x => x.id === tid);
    if (!t) return res.status(404).json({ error: `task not found: ${tid}` });
    if (!project_ids.includes(t.project_id)) {
      return res.status(409).json({ error: `task ${tid} belongs to a project not in project_ids` });
    }
  }

  let ctx = { tmux_session_names: [] as string[], claude_session_ids: [] as string[] };
  if (source === "live-timer") {
    ctx = await captureContext(project_ids);
  } else if (context && typeof context === "object") {
    ctx = {
      tmux_session_names: Array.isArray(context.tmux_session_names) ? context.tmux_session_names : [],
      claude_session_ids: Array.isArray(context.claude_session_ids) ? context.claude_session_ids : [],
    };
  }

  const pomodoro: Pomodoro = {
    id: randomUUID(),
    started_at,
    ended_at,
    target_duration_minutes,
    project_ids,
    task_ids: tIds,
    notes: notes ?? "",
    freeTaskLabel: typeof freeTaskLabel === "string" ? freeTaskLabel : "",
    source,
    context: ctx,
  };

  const file = await readJsonSafe<PomFile>(POMODOROS_FILE, EMPTY_P);
  file.pomodoros.push(pomodoro);
  await writeJsonAtomic(POMODOROS_FILE, file);
  res.json(pomodoro);
});

pomodorosRouter.patch("/pomodoros/:id", async (req, res) => {
  const body = req.body ?? {};
  const allowed = new Set(["notes", "freeTaskLabel"]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) return res.status(400).json({ error: `field not patchable: ${k}` });
  }
  if (body.notes !== undefined && (typeof body.notes !== "string" || body.notes.length > 8000)) {
    return res.status(400).json({ error: "notes must be string ≤8000 chars" });
  }
  if (body.freeTaskLabel !== undefined && (typeof body.freeTaskLabel !== "string" || body.freeTaskLabel.length > 200)) {
    return res.status(400).json({ error: "freeTaskLabel must be string ≤200 chars" });
  }
  const file = await readJsonSafe<PomFile>(POMODOROS_FILE, EMPTY_P);
  const idx = file.pomodoros.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "pomodoro not found" });
  if (body.notes !== undefined) file.pomodoros[idx].notes = body.notes;
  if (body.freeTaskLabel !== undefined) file.pomodoros[idx].freeTaskLabel = body.freeTaskLabel;
  await writeJsonAtomic(POMODOROS_FILE, file);
  res.json(normalize(file.pomodoros[idx]));
});
