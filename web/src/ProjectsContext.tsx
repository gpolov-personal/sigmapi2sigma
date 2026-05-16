import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import {
  apiRequest, Project, Task, DerivedStatus, ProjectStatusAnchor, ProjectsResponse, ProjectWithStatus,
} from "./api";

export interface NewProject {
  name: string;
  color?: string;
  tags?: string[];
  notes?: string;
  abbreviation?: string | null;
  working_dir?: string | null;
}

export interface NewTask {
  project_id: string;
  name: string;
  notes?: string;
}

interface Ctx {
  projects: Project[];
  projectById: Map<string, Project>;
  derivedStatusByProjectId: Map<string, DerivedStatus>;
  projectsAnchor: ProjectStatusAnchor;
  tasks: Task[];
  tasksByProject: Map<string, Task[]>;
  taskById: Map<string, Task>;
  assignmentsByTmux: Map<string, string>;
  loading: boolean;
  refresh: () => Promise<void>;
  createProject: (data: NewProject) => Promise<Project>;
  updateProject: (id: string, patch: Partial<Project>) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  createTask: (data: NewTask) => Promise<Task>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  setAssignment: (tmuxSessionName: string, projectId: string | null) => Promise<void>;
}

const ProjectsContext = createContext<Ctx | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectWithStatus[]>([]);
  const [anchor, setAnchor] = useState<ProjectStatusAnchor>({ ts: null, activeWindowHours: 72 });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [pr, tr, ar] = await Promise.all([
      apiRequest<ProjectsResponse>("GET", "/api/projects"),
      apiRequest<{ tasks: Task[] }>("GET", "/api/tasks"),
      apiRequest<{ assignments: Record<string, string> }>("GET", "/api/assignments"),
    ]);
    if (pr.ok) {
      const body = pr.body as ProjectsResponse;
      setProjects(body.projects);
      setAnchor(body.anchor);
    }
    if (tr.ok) setTasks((tr.body as { tasks: Task[] }).tasks);
    if (ar.ok) setAssignments((ar.body as { assignments: Record<string, string> }).assignments);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const createProject = useCallback(async (data: NewProject) => {
    const r = await apiRequest<Project>("POST", "/api/projects", data);
    if (!r.ok) throw new Error((r.body as { error: string }).error);
    await refresh();
    return r.body as Project;
  }, [refresh]);

  const updateProject = useCallback(async (id: string, patch: Partial<Project>) => {
    const r = await apiRequest<Project>("PATCH", `/api/projects/${id}`, patch);
    if (!r.ok) throw new Error((r.body as { error: string }).error);
    await refresh();
    return r.body as Project;
  }, [refresh]);

  const deleteProject = useCallback(async (id: string) => {
    const r = await apiRequest<{ ok: true }>("DELETE", `/api/projects/${id}`);
    if (!r.ok) throw new Error((r.body as { error: string }).error);
    await refresh();
  }, [refresh]);

  const createTask = useCallback(async (data: NewTask) => {
    const r = await apiRequest<Task>("POST", "/api/tasks", data);
    if (!r.ok) throw new Error((r.body as { error: string }).error);
    await refresh();
    return r.body as Task;
  }, [refresh]);

  const updateTask = useCallback(async (id: string, patch: Partial<Task>) => {
    const r = await apiRequest<Task>("PATCH", `/api/tasks/${id}`, patch);
    if (!r.ok) throw new Error((r.body as { error: string }).error);
    await refresh();
    return r.body as Task;
  }, [refresh]);

  const deleteTask = useCallback(async (id: string) => {
    const r = await apiRequest<{ ok: true }>("DELETE", `/api/tasks/${id}`);
    if (!r.ok) throw new Error((r.body as { error: string }).error);
    await refresh();
  }, [refresh]);

  const setAssignment = useCallback(async (tmuxSessionName: string, projectId: string | null) => {
    const r = await apiRequest<{ assignments: Record<string, string> }>(
      "PUT", "/api/assignments", { tmuxSessionName, projectId }
    );
    if (!r.ok) throw new Error((r.body as { error: string }).error);
    await refresh();
  }, [refresh]);

  const projectById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const taskById = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  const tasksByProject = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) {
      const arr = m.get(t.project_id);
      if (arr) arr.push(t); else m.set(t.project_id, [t]);
    }
    return m;
  }, [tasks]);

  const assignmentsByTmux = useMemo(() => {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(assignments)) m.set(k, v);
    return m;
  }, [assignments]);

  const derivedStatusByProjectId = useMemo(() => {
    const m = new Map<string, DerivedStatus>();
    for (const p of projects) {
      if (p.derivedStatus) m.set(p.id, p.derivedStatus);
    }
    return m;
  }, [projects]);

  return (
    <ProjectsContext.Provider value={{
      projects, projectById,
      derivedStatusByProjectId,
      projectsAnchor: anchor,
      tasks, tasksByProject, taskById,
      assignmentsByTmux,
      loading, refresh,
      createProject, updateProject, deleteProject,
      createTask, updateTask, deleteTask,
      setAssignment,
    }}>
      {children}
    </ProjectsContext.Provider>
  );
}

export function useProjects(): Ctx {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error("useProjects must be used inside ProjectsProvider");
  return ctx;
}
