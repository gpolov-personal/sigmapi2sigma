import { Router } from "express";
import {
  ASSIGNMENTS_FILE,
  PROJECTS_FILE,
  readJsonSafe,
  writeJsonAtomic,
} from "../lib/dataStore.js";

export const assignmentsRouter = Router();

interface AssignmentsFile {
  schemaVersion: number;
  assignments: Record<string, string>;
}
interface ProjectsFile {
  schemaVersion: number;
  projects: { id: string; completed_at: string | null }[];
}

const EMPTY_A: AssignmentsFile = { schemaVersion: 1, assignments: {} };
const EMPTY_P: ProjectsFile = { schemaVersion: 1, projects: [] };

assignmentsRouter.get("/assignments", async (_req, res) => {
  const file = await readJsonSafe<AssignmentsFile>(ASSIGNMENTS_FILE, EMPTY_A);
  res.json({ assignments: file.assignments });
});

assignmentsRouter.put("/assignments", async (req, res) => {
  const body = req.body ?? {};
  const tmuxName: unknown = body.tmuxSessionName;
  const projectId: unknown = body.projectId;
  if (typeof tmuxName !== "string" || tmuxName.length === 0) {
    return res.status(400).json({ error: "tmuxSessionName required" });
  }
  if (projectId !== null && typeof projectId !== "string") {
    return res.status(400).json({ error: "projectId must be string or null" });
  }

  const file = await readJsonSafe<AssignmentsFile>(ASSIGNMENTS_FILE, EMPTY_A);

  if (projectId === null) {
    delete file.assignments[tmuxName];
    await writeJsonAtomic(ASSIGNMENTS_FILE, file);
    return res.json({ assignments: file.assignments });
  }

  const projects = await readJsonSafe<ProjectsFile>(PROJECTS_FILE, EMPTY_P);
  const project = projects.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: "project not found" });
  if (project.completed_at) {
    return res.status(409).json({ error: "project is completed; reopen first" });
  }
  for (const [k, v] of Object.entries(file.assignments)) {
    if (v === projectId && k !== tmuxName) {
      return res.status(409).json({
        error: "project already assigned to another tmux session",
        details: { tmuxSessionName: k },
      });
    }
  }

  file.assignments[tmuxName] = projectId;
  await writeJsonAtomic(ASSIGNMENTS_FILE, file);
  res.json({ assignments: file.assignments });
});
