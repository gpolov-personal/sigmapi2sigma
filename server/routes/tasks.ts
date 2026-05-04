import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  PROJECTS_FILE,
  TASKS_FILE,
  readJsonSafe,
  writeJsonAtomic,
} from "../lib/dataStore.js";

export const tasksRouter = Router();

export interface Task {
  id: string;
  project_id: string;
  name: string;
  notes: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TasksFile { schemaVersion: number; tasks: Task[] }
interface ProjectsFile { schemaVersion: number; projects: { id: string; completed_at: string | null }[] }

const EMPTY_TASKS: TasksFile = { schemaVersion: 1, tasks: [] };
const EMPTY_PROJECTS: ProjectsFile = { schemaVersion: 1, projects: [] };

interface ValidationError { status: 400 | 404 | 409; error: string; details?: any }

function validateTaskInput(
  body: any,
  existing: Task[],
  selfId?: string,
  projectIdForUniq?: string
): ValidationError | null {
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return { status: 400, error: "name must be string" };
    const name = body.name.trim();
    if (name.length < 1 || name.length > 200) return { status: 400, error: "name must be 1-200 chars" };
    if (projectIdForUniq) {
      const dup = existing.find(
        t => t.id !== selfId && t.project_id === projectIdForUniq && t.name.toLowerCase() === name.toLowerCase()
      );
      if (dup) return { status: 409, error: "task name already exists in this project", details: { existingId: dup.id } };
    }
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== "string" || body.notes.length > 8000) {
      return { status: 400, error: "notes must be string ≤8000 chars" };
    }
  }
  if (body.completed_at !== undefined && body.completed_at !== null) {
    if (typeof body.completed_at !== "string" || !Number.isFinite(Date.parse(body.completed_at))) {
      return { status: 400, error: "completed_at must be ISO string or null" };
    }
  }
  return null;
}

tasksRouter.get("/tasks", async (req, res) => {
  const file = await readJsonSafe<TasksFile>(TASKS_FILE, EMPTY_TASKS);
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
  const out = projectId ? file.tasks.filter(t => t.project_id === projectId) : file.tasks;
  res.json({ tasks: out });
});

tasksRouter.get("/tasks/:id", async (req, res) => {
  const file = await readJsonSafe<TasksFile>(TASKS_FILE, EMPTY_TASKS);
  const t = file.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  res.json(t);
});

tasksRouter.post("/tasks", async (req, res) => {
  const body = req.body ?? {};
  const projectId: unknown = body.project_id;
  if (typeof projectId !== "string" || projectId.length === 0) {
    return res.status(400).json({ error: "project_id required" });
  }
  if (!body.name) return res.status(400).json({ error: "name required" });

  const projects = await readJsonSafe<ProjectsFile>(PROJECTS_FILE, EMPTY_PROJECTS);
  const project = projects.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: "project not found" });
  if (project.completed_at) return res.status(409).json({ error: "cannot add task to completed project" });

  const file = await readJsonSafe<TasksFile>(TASKS_FILE, EMPTY_TASKS);
  const err = validateTaskInput(body, file.tasks, undefined, projectId);
  if (err) return res.status(err.status).json({ error: err.error, ...(err.details ? { details: err.details } : {}) });

  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    project_id: projectId,
    name: body.name.trim(),
    notes: body.notes ?? "",
    completed_at: body.completed_at ?? null,
    created_at: now,
    updated_at: now,
  };
  file.tasks.push(task);
  await writeJsonAtomic(TASKS_FILE, file);
  res.json(task);
});

const ALLOWED_PATCH = new Set(["name", "notes", "completed_at"]);

tasksRouter.patch("/tasks/:id", async (req, res) => {
  const body = req.body ?? {};
  for (const k of Object.keys(body)) {
    if (!ALLOWED_PATCH.has(k)) return res.status(400).json({ error: `field not patchable: ${k}` });
  }
  const file = await readJsonSafe<TasksFile>(TASKS_FILE, EMPTY_TASKS);
  const idx = file.tasks.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "task not found" });
  const prev = file.tasks[idx];

  const err = validateTaskInput(body, file.tasks, req.params.id, prev.project_id);
  if (err) return res.status(err.status).json({ error: err.error, ...(err.details ? { details: err.details } : {}) });

  const next: Task = {
    ...prev,
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.completed_at !== undefined ? { completed_at: body.completed_at } : {}),
    updated_at: new Date().toISOString(),
  };
  file.tasks[idx] = next;
  await writeJsonAtomic(TASKS_FILE, file);
  res.json(next);
});

tasksRouter.delete("/tasks/:id", async (req, res) => {
  const file = await readJsonSafe<TasksFile>(TASKS_FILE, EMPTY_TASKS);
  const idx = file.tasks.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "task not found" });
  file.tasks.splice(idx, 1);
  await writeJsonAtomic(TASKS_FILE, file);
  res.json({ ok: true });
});
