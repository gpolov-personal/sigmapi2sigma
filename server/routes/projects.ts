import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  ASSIGNMENTS_FILE,
  PROJECTS_FILE,
  TASKS_FILE,
  readJsonSafe,
  writeJsonAtomic,
} from "../lib/dataStore.js";

export const projectsRouter = Router();

export const FREE_PROJECT_ID = "free";

export interface Project {
  id: string;
  name: string;
  color: string;
  tags: string[];
  notes: string;
  abbreviation: string | null;    // manual override; null = auto-computed from name
  working_dir: string | null;     // optional cwd used when creating a tmux session for this project
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  system?: boolean;       // true for the Free project; cannot be deleted/completed
}

interface ProjectsFile {
  schemaVersion: number;
  projects: Project[];
}

interface AssignmentsFile {
  schemaVersion: number;
  assignments: Record<string, string>;
}

interface TasksFile {
  schemaVersion: number;
  tasks: { id: string; project_id: string; completed_at: string | null }[];
}

const EMPTY_PROJECTS: ProjectsFile = { schemaVersion: 1, projects: [] };
const EMPTY_ASSIGNMENTS: AssignmentsFile = { schemaVersion: 1, assignments: {} };
const EMPTY_TASKS: TasksFile = { schemaVersion: 1, tasks: [] };

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const FREE_DEFAULT_COLOR = "#64748b"; // slate-500

function buildFreeProject(now: string): Project {
  return {
    id: FREE_PROJECT_ID,
    name: "Free",
    color: FREE_DEFAULT_COLOR,
    tags: [],
    notes: "Ad-hoc tasks not tied to a larger project. This project is system-managed; you can recolor or edit notes/tags but cannot delete or complete it.",
    abbreviation: null,
    working_dir: null,
    completed_at: null,
    created_at: now,
    updated_at: now,
    system: true,
  };
}

async function loadProjects(): Promise<ProjectsFile> {
  const file = await readJsonSafe<ProjectsFile>(PROJECTS_FILE, EMPTY_PROJECTS);
  let mutated = false;
  // Ensure Free project always exists.
  if (!file.projects.find(p => p.id === FREE_PROJECT_ID)) {
    file.projects.unshift(buildFreeProject(new Date().toISOString()));
    mutated = true;
  } else {
    const free = file.projects.find(p => p.id === FREE_PROJECT_ID)!;
    if (!free.system) { free.system = true; mutated = true; }
  }
  // Backfill missing fields on legacy records.
  for (const p of file.projects) {
    if (p.abbreviation === undefined) { p.abbreviation = null; mutated = true; }
    if (p.working_dir === undefined) { p.working_dir = null; mutated = true; }
  }
  if (mutated) await writeJsonAtomic(PROJECTS_FILE, file);
  return file;
}

interface ValidationError { status: 400 | 409; error: string; details?: any }

function validateProjectInput(
  body: any,
  existing: Project[],
  selfId?: string
): ValidationError | null {
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return { status: 400, error: "name must be string" };
    const name = body.name.trim();
    if (name.length < 1 || name.length > 100) return { status: 400, error: "name must be 1-100 chars" };
    const dup = existing.find(
      p => p.id !== selfId && p.name.toLowerCase() === name.toLowerCase()
    );
    if (dup) return { status: 409, error: "project name already exists", details: { existingId: dup.id } };
  }
  if (body.color !== undefined) {
    if (typeof body.color !== "string" || !COLOR_RE.test(body.color)) {
      return { status: 400, error: "color must match #RRGGBB" };
    }
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 16) {
      return { status: 400, error: "tags must be array of ≤16 strings" };
    }
    for (const t of body.tags) {
      if (typeof t !== "string" || t.length > 32) {
        return { status: 400, error: "each tag must be string ≤32 chars" };
      }
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
  if (body.abbreviation !== undefined && body.abbreviation !== null) {
    if (typeof body.abbreviation !== "string") {
      return { status: 400, error: "abbreviation must be string or null" };
    }
    const a = body.abbreviation.trim();
    if (a.length < 1 || a.length > 12) {
      return { status: 400, error: "abbreviation must be 1-12 chars" };
    }
    if (!/^[A-Za-z0-9]+$/.test(a)) {
      return { status: 400, error: "abbreviation must be alphanumeric only" };
    }
  }
  if (body.working_dir !== undefined && body.working_dir !== null) {
    if (typeof body.working_dir !== "string") {
      return { status: 400, error: "working_dir must be string or null" };
    }
    const w = body.working_dir.trim();
    if (w.length === 0) return null;       // treat empty as null in the merge step
    if (w.length > 500) return { status: 400, error: "working_dir must be ≤500 chars" };
    if (!w.startsWith("/") && !w.startsWith("~")) {
      return { status: 400, error: "working_dir should be an absolute path (start with / or ~)" };
    }
  }
  return null;
}

projectsRouter.get("/projects", async (_req, res) => {
  const file = await loadProjects();
  res.json({ projects: file.projects });
});

projectsRouter.get("/projects/:id", async (req, res) => {
  const file = await loadProjects();
  const p = file.projects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "project not found" });
  res.json(p);
});

projectsRouter.post("/projects", async (req, res) => {
  const file = await loadProjects();
  const body = req.body ?? {};
  if (!body.name) return res.status(400).json({ error: "name required" });
  const err = validateProjectInput(body, file.projects);
  if (err) return res.status(err.status).json({ error: err.error, ...(err.details ? { details: err.details } : {}) });
  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID(),
    name: body.name.trim(),
    color: body.color ?? "#3b82f6",
    tags: body.tags ?? [],
    notes: body.notes ?? "",
    abbreviation: body.abbreviation ? body.abbreviation.trim() : null,
    working_dir: body.working_dir && body.working_dir.trim() ? body.working_dir.trim() : null,
    completed_at: body.completed_at ?? null,
    created_at: now,
    updated_at: now,
  };
  file.projects.push(project);
  await writeJsonAtomic(PROJECTS_FILE, file);
  res.json(project);
});

const ALLOWED_PATCH = new Set(["name", "color", "tags", "notes", "completed_at", "abbreviation", "working_dir"]);

projectsRouter.patch("/projects/:id", async (req, res) => {
  const body = req.body ?? {};
  for (const k of Object.keys(body)) {
    if (!ALLOWED_PATCH.has(k)) return res.status(400).json({ error: `field not patchable: ${k}` });
  }
  const file = await loadProjects();
  const idx = file.projects.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "project not found" });
  const prev = file.projects[idx];

  // Free project guards: cannot rename or complete; can recolor / edit notes / tags.
  if (prev.system) {
    if (body.name !== undefined) return res.status(409).json({ error: "Free project cannot be renamed" });
    if (body.completed_at !== undefined && body.completed_at !== null) {
      return res.status(409).json({ error: "Free project cannot be completed" });
    }
  }

  const err = validateProjectInput(body, file.projects, req.params.id);
  if (err) return res.status(err.status).json({ error: err.error, ...(err.details ? { details: err.details } : {}) });

  const next: Project = {
    ...prev,
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.color !== undefined ? { color: body.color } : {}),
    ...(body.tags !== undefined ? { tags: body.tags } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.completed_at !== undefined ? { completed_at: body.completed_at } : {}),
    ...(body.abbreviation !== undefined ? { abbreviation: body.abbreviation === null || body.abbreviation === "" ? null : body.abbreviation.trim() } : {}),
    ...(body.working_dir !== undefined ? { working_dir: body.working_dir === null || (typeof body.working_dir === "string" && body.working_dir.trim() === "") ? null : body.working_dir.trim() } : {}),
    updated_at: new Date().toISOString(),
  };

  // Auto-release tmux assignment when marking completed.
  if (body.completed_at !== undefined && body.completed_at !== null && prev.completed_at === null) {
    const a = await readJsonSafe<AssignmentsFile>(ASSIGNMENTS_FILE, EMPTY_ASSIGNMENTS);
    let changed = false;
    for (const [k, v] of Object.entries(a.assignments)) {
      if (v === prev.id) {
        delete a.assignments[k];
        changed = true;
      }
    }
    if (changed) await writeJsonAtomic(ASSIGNMENTS_FILE, a);
  }

  file.projects[idx] = next;
  await writeJsonAtomic(PROJECTS_FILE, file);
  res.json(next);
});

projectsRouter.delete("/projects/:id", async (req, res) => {
  const file = await loadProjects();
  const idx = file.projects.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "project not found" });
  const project = file.projects[idx];
  if (project.system) return res.status(409).json({ error: "Free project cannot be deleted" });

  // Block delete if project has any incomplete tasks.
  const tasksFile = await readJsonSafe<TasksFile>(TASKS_FILE, EMPTY_TASKS);
  const projectTasks = tasksFile.tasks.filter(t => t.project_id === project.id);
  const incomplete = projectTasks.filter(t => t.completed_at === null);
  if (incomplete.length > 0) {
    return res.status(409).json({
      error: `project has ${incomplete.length} incomplete task(s); complete or delete them first`,
      details: { incompleteCount: incomplete.length },
    });
  }

  // Cascade delete completed tasks belonging to this project.
  if (projectTasks.length > 0) {
    tasksFile.tasks = tasksFile.tasks.filter(t => t.project_id !== project.id);
    await writeJsonAtomic(TASKS_FILE, tasksFile);
  }

  // Remove tmux assignment(s) (idempotent).
  const a = await readJsonSafe<AssignmentsFile>(ASSIGNMENTS_FILE, EMPTY_ASSIGNMENTS);
  let changed = false;
  for (const [k, v] of Object.entries(a.assignments)) {
    if (v === project.id) {
      delete a.assignments[k];
      changed = true;
    }
  }
  if (changed) await writeJsonAtomic(ASSIGNMENTS_FILE, a);

  file.projects.splice(idx, 1);
  await writeJsonAtomic(PROJECTS_FILE, file);
  res.json({ ok: true });
});
