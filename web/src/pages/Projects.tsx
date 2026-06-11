import { useEffect, useMemo, useState } from "react";
import { Plus, X, Trash2, Check, RotateCcw, ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import { Pomodoro, Project, Task, PROJECT_PALETTE, apiRequest } from "../api";
import type { DerivedStatus } from "../api";
import { useProjects, NewProject, NewTask } from "../ProjectsContext";
import { useSettings } from "../SettingsContext";
import { ProjectChip } from "../components/ProjectChip";
import { PomodoroDetailDrawer } from "../components/PomodoroDetailDrawer";
import { formatDuration, computeProjectAbbreviation } from "../utils";
import { pomodoroMinutes } from "../lib/pomodoro";

interface ProjectStats { todayMin: number; weekMin: number; allMin: number; }

function emptyStats(): ProjectStats { return { todayMin: 0, weekMin: 0, allMin: 0 }; }

// Time attribution per pomodoro (matches backend formula):
// units = each picked task + each picked project that has no task picked under it.
// Each unit gets total_min / units.length.
function attributeMinutes(
  p: Pomodoro,
  taskById: Map<string, Task>
): { byProject: Map<string, number>; byTask: Map<string, number> } {
  const dur = pomodoroMinutes(p);
  const tasksByProj = new Map<string, string[]>();
  for (const tid of p.task_ids) {
    const t = taskById.get(tid);
    if (!t) continue;
    if (!p.project_ids.includes(t.project_id)) continue;
    const arr = tasksByProj.get(t.project_id);
    if (arr) arr.push(tid); else tasksByProj.set(t.project_id, [tid]);
  }
  const units: { project: string; task: string | null }[] = [];
  for (const pid of p.project_ids) {
    const tasks = tasksByProj.get(pid) ?? [];
    if (tasks.length === 0) {
      units.push({ project: pid, task: null });
    } else {
      for (const t of tasks) units.push({ project: pid, task: t });
    }
  }
  const per = units.length > 0 ? dur / units.length : 0;
  const byProject = new Map<string, number>();
  const byTask = new Map<string, number>();
  for (const u of units) {
    byProject.set(u.project, (byProject.get(u.project) ?? 0) + per);
    if (u.task) byTask.set(u.task, (byTask.get(u.task) ?? 0) + per);
  }
  return { byProject, byTask };
}

export function Projects() {
  const { projects, tasksByProject, taskById, assignmentsByTmux, derivedStatusByProjectId, projectsAnchor, loading, createProject } = useProjects();
  const [showCompleted, setShowCompleted] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pomodoros, setPomodoros] = useState<Pomodoro[]>([]);

  useEffect(() => {
    apiRequest<{ pomodoros: Pomodoro[] }>("GET", "/api/pomodoros").then(r => {
      if (r.ok) setPomodoros((r.body as { pomodoros: Pomodoro[] }).pomodoros);
    });
  }, []);

  const statsByProject = useMemo(() => {
    const m = new Map<string, ProjectStats>();
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart); weekStart.setDate(weekStart.getDate() - 7);
    const dayMs = dayStart.getTime();
    const weekMs = weekStart.getTime();
    for (const p of pomodoros) {
      const { byProject } = attributeMinutes(p, taskById);
      const ts = Date.parse(p.started_at);
      for (const [pid, mins] of byProject.entries()) {
        const s = m.get(pid) ?? emptyStats();
        s.allMin += mins;
        if (ts >= weekMs) s.weekMin += mins;
        if (ts >= dayMs) s.todayMin += mins;
        m.set(pid, s);
      }
    }
    return m;
  }, [pomodoros, taskById]);

  const minsByTask = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pomodoros) {
      const { byTask } = attributeMinutes(p, taskById);
      for (const [tid, mins] of byTask.entries()) m.set(tid, (m.get(tid) ?? 0) + mins);
    }
    return m;
  }, [pomodoros, taskById]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter(p => !q || p.name.toLowerCase().includes(q) || p.tags.some(x => x.toLowerCase().includes(q)));
  }, [projects, search]);

  const grouped = useMemo(() => {
    const activeVisible: Project[] = [];
    const parkedVisible: Project[] = [];
    const hiddenActive: Project[] = [];
    const hiddenParked: Project[] = [];
    const completed: Project[] = [];
    for (const p of filtered) {
      if (p.completed_at) { completed.push(p); continue; }
      const eng = derivedStatusByProjectId.get(p.id)?.engagement ?? "parked";
      if (p.hidden) (eng === "active" ? hiddenActive : hiddenParked).push(p);
      else (eng === "active" ? activeVisible : parkedVisible).push(p);
    }
    // Within a section: Free first, in_progress before not_started, then by name.
    const cmp = (a: Project, b: Project) => {
      if (a.system && !b.system) return -1;
      if (!a.system && b.system) return 1;
      const da = derivedStatusByProjectId.get(a.id);
      const db = derivedStatusByProjectId.get(b.id);
      const pa = da?.progress ?? "not_started";
      const pb = db?.progress ?? "not_started";
      const progOrder = { in_progress: 0, not_started: 1, completed: 2 };
      if (pa !== pb) return progOrder[pa] - progOrder[pb];
      return a.name.localeCompare(b.name);
    };
    activeVisible.sort(cmp);
    parkedVisible.sort(cmp);
    hiddenActive.sort(cmp);
    hiddenParked.sort(cmp);
    completed.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    return { activeVisible, parkedVisible, hiddenActive, hiddenParked, completed };
  }, [filtered, derivedStatusByProjectId]);

  const hiddenCount = grouped.hiddenActive.length + grouped.hiddenParked.length;

  const selected = selectedId ? projects.find(p => p.id === selectedId) ?? null : null;

  const renderGrid = (list: Project[]) => (
    <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(26rem, 1fr))" }}>
      {list.map(p => (
        <ProjectCard
          key={p.id}
          project={p}
          tasks={tasksByProject.get(p.id) ?? []}
          derivedStatus={derivedStatusByProjectId.get(p.id) ?? null}
          stats={statsByProject.get(p.id) ?? emptyStats()}
          minsByTask={minsByTask}
          onClick={() => setSelectedId(p.id)}
        />
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white"
        >
          <Plus size={14} /> New Project
        </button>
        <input
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
        />
        <div className="ml-auto flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox" checked={showCompleted}
              onChange={e => setShowCompleted(e.target.checked)}
            />
            Show completed
          </label>
          {hiddenCount > 0 && (
            <label className="flex items-center gap-2 text-sm text-slate-400">
              <input
                type="checkbox" checked={showHidden}
                onChange={e => setShowHidden(e.target.checked)}
              />
              Show hidden ({grouped.hiddenActive.length} active, {grouped.hiddenParked.length} parked)
            </label>
          )}
        </div>
      </div>

      <AnchorHeader anchor={projectsAnchor} />

      {loading && <div className="text-slate-500 text-sm">Loading…</div>}

      {!loading
        && grouped.activeVisible.length === 0
        && grouped.parkedVisible.length === 0
        && grouped.completed.length === 0
        && hiddenCount === 0 && (
        <div className="text-slate-500 text-sm">No projects yet.</div>
      )}

      {grouped.activeVisible.length > 0 && (
        <>
          <div className="text-sm text-slate-400">Active ({grouped.activeVisible.length})</div>
          {renderGrid(grouped.activeVisible)}
        </>
      )}

      {grouped.parkedVisible.length > 0 && (
        <>
          <div className="text-sm text-slate-400 mt-6">Parked ({grouped.parkedVisible.length})</div>
          {renderGrid(grouped.parkedVisible)}
        </>
      )}

      {showCompleted && grouped.completed.length > 0 && (
        <>
          <div className="text-sm text-slate-400 mt-6">Completed ({grouped.completed.length})</div>
          {renderGrid(grouped.completed)}
        </>
      )}

      {showHidden && hiddenCount > 0 && (
        <>
          <div className="text-sm text-slate-300 mt-8 font-medium">Hidden</div>
          {grouped.hiddenActive.length > 0 && (
            <>
              <div className="text-xs text-slate-500 mt-2 ml-1">Active ({grouped.hiddenActive.length})</div>
              {renderGrid(grouped.hiddenActive)}
            </>
          )}
          {grouped.hiddenParked.length > 0 && (
            <>
              <div className="text-xs text-slate-500 mt-2 ml-1">Parked ({grouped.hiddenParked.length})</div>
              {renderGrid(grouped.hiddenParked)}
            </>
          )}
        </>
      )}

      {creating && (
        <CreateProjectModal
          onClose={() => setCreating(false)}
          onCreate={async (data) => { await createProject(data); setCreating(false); }}
        />
      )}

      {selected && (
        <ProjectDrawer
          project={selected}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function ProjectCard({ project, tasks, derivedStatus, stats, minsByTask, onClick }: {
  project: Project;
  tasks: Task[];
  derivedStatus: DerivedStatus | null;
  stats: ProjectStats;
  minsByTask: Map<string, number>;
  onClick: () => void;
}) {
  const { settings } = useSettings();
  const fmt = (m: number) => formatDuration(m, settings.workdayHours);

  const openTasks = tasks.filter(t => !t.completed_at);
  const doneTasks = tasks.filter(t => t.completed_at);
  const previewTasks = openTasks.slice(0, 5);

  const progress = derivedStatus?.progress ?? "not_started";
  const engagement = derivedStatus?.engagement ?? "parked";
  const tmuxName = derivedStatus?.tmux_session_name ?? null;

  return (
    <button
      onClick={onClick}
      className="text-left border rounded bg-slate-900/40 hover:bg-slate-900/70 p-4 flex flex-col gap-2 border-slate-800"
      style={{ borderLeft: `5px solid ${project.color}` }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <div className="font-semibold text-base">{project.name}</div>
        {project.system && <span className="text-[10px] text-slate-500 uppercase tracking-wider">system</span>}
        <div className="ml-auto flex items-center gap-1">
          <ProgressChip progress={progress} />
          <EngagementChip engagement={engagement} />
          {tmuxName && <TmuxChip name={tmuxName} />}
        </div>
      </div>
      {project.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {project.tags.map(tag => (
            <span key={tag} className="text-[10px] bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">{tag}</span>
          ))}
        </div>
      )}
      {progress === "completed" && project.completed_at && (
        <div className="text-xs text-slate-500">completed {new Date(project.completed_at).toLocaleDateString()}</div>
      )}
      <div className="text-sm text-slate-400 grid grid-cols-3 gap-1 pt-2 border-t border-slate-800">
        <div><span className="text-slate-500">Today </span>{fmt(stats.todayMin)}</div>
        <div><span className="text-slate-500">Week </span>{fmt(stats.weekMin)}</div>
        <div><span className="text-slate-500">All </span>{fmt(stats.allMin)}</div>
      </div>
      <div className="border-t border-slate-800 pt-2">
        <div className="text-sm text-slate-400 mb-1.5">
          Tasks <span className="text-slate-500">({openTasks.length} open · {doneTasks.length} done)</span>
        </div>
        {tasks.length === 0 ? (
          <div className="text-sm text-slate-500 italic">No tasks yet — click to add one</div>
        ) : (
          <ul className="text-sm space-y-1">
            {previewTasks.map(t => {
              const mins = minsByTask.get(t.id) ?? 0;
              return (
                <li key={t.id} className="text-slate-300 truncate flex items-center gap-2">
                  <span className="flex-1 truncate">☐ {t.name}</span>
                  {mins > 0 && <span className="text-slate-400 text-sm tabular-nums">{fmt(mins)}</span>}
                </li>
              );
            })}
            {openTasks.length > previewTasks.length && (
              <li className="text-sm text-slate-500 italic">+ {openTasks.length - previewTasks.length} more</li>
            )}
            {doneTasks.length > 0 && (
              <li className="text-sm text-slate-500">▸ {doneTasks.length} completed</li>
            )}
          </ul>
        )}
      </div>
    </button>
  );
}

function CreateProjectModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (data: NewProject & { abbreviation?: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_PALETTE[10]);
  const [tagsRaw, setTagsRaw] = useState("");
  const [notes, setNotes] = useState("");
  const [abbreviation, setAbbreviation] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const auto = name.trim() ? computeProjectAbbreviation(name) : "";

  async function submit() {
    setError(null); setBusy(true);
    try {
      const tags = tagsRaw.split(",").map(s => s.trim()).filter(Boolean);
      const abbr = abbreviation.trim();
      const wd = workingDir.trim();
      await onCreate({
        name, color, tags, notes,
        abbreviation: abbr.length > 0 ? abbr : null,
        working_dir: wd.length > 0 ? wd : null,
      });
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-slate-900 border border-slate-700 rounded w-full max-w-md p-6 space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold">New Project</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <label className="block">
          <span className="text-sm text-slate-300">Name</span>
          <input
            autoFocus value={name} onChange={e => setName(e.target.value)}
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm text-slate-300">Color</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {PROJECT_PALETTE.map(c => (
              <button key={c} onClick={() => setColor(c)}
                className={`w-6 h-6 rounded ${color === c ? "ring-2 ring-white" : ""}`}
                style={{ backgroundColor: c }}
              />
            ))}
            <input
              value={color} onChange={e => setColor(e.target.value)}
              className="ml-2 w-24 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono"
            />
          </div>
        </label>
        <label className="block">
          <span className="text-sm text-slate-300">Abbreviation <span className="text-xs text-slate-500">(optional, 1-12 alphanumeric chars)</span></span>
          <input value={abbreviation} onChange={e => setAbbreviation(e.target.value)}
            placeholder={auto ? `auto: ${auto}` : "auto-computed from name"}
            maxLength={12}
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm font-mono" />
        </label>
        <label className="block">
          <span className="text-sm text-slate-300">Working directory <span className="text-xs text-slate-500">(optional — used when creating a tmux session for this project)</span></span>
          <input value={workingDir} onChange={e => setWorkingDir(e.target.value)}
            placeholder="e.g. /home/dsu/Projects/MyApp or ~/Projects/MyApp"
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm font-mono" />
        </label>
        <label className="block">
          <span className="text-sm text-slate-300">Tags (comma separated)</span>
          <input value={tagsRaw} onChange={e => setTagsRaw(e.target.value)}
            placeholder="project, study, ..."
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm" />
        </label>
        <label className="block">
          <span className="text-sm text-slate-300">Notes</span>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4}
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm" />
        </label>
        {error && <div className="text-sm text-red-400">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button disabled={busy || !name.trim()} onClick={submit}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white disabled:opacity-50"
          >Create</button>
          <button onClick={onClose} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ProjectDrawer({ project, onClose }: { project: Project; onClose: () => void }) {
  const { tasksByProject, taskById, updateProject, deleteProject, setAssignment, assignmentsByTmux, derivedStatusByProjectId, createTask, updateTask, deleteTask } = useProjects();
  const { settings } = useSettings();
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color);
  const [tagsRaw, setTagsRaw] = useState(project.tags.join(", "));
  const [notes, setNotes] = useState(project.notes);
  const [abbreviation, setAbbreviation] = useState(project.abbreviation ?? "");
  const [workingDir, setWorkingDir] = useState(project.working_dir ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pomodoros, setPomodoros] = useState<Pomodoro[]>([]);
  const [selectedPomId, setSelectedPomId] = useState<string | null>(null);

  const autoAbbr = name.trim() ? computeProjectAbbreviation(name) : "";
  // Default the tmux name input to the project's effective abbreviation.
  const effectiveAbbr = (project.abbreviation && project.abbreviation.trim()) || autoAbbr || project.name.replace(/\s+/g, "");
  const [assignTo, setAssignTo] = useState(effectiveAbbr);

  const tasks = tasksByProject.get(project.id) ?? [];
  const openTasks = tasks.filter(t => !t.completed_at);
  const doneTasks = tasks.filter(t => t.completed_at);
  const [showDone, setShowDone] = useState(false);
  const [newTaskName, setNewTaskName] = useState("");

  const derivedStatus = derivedStatusByProjectId.get(project.id) ?? null;
  // tmuxName for the assignment section: look up from assignmentsByTmux directly
  // (shows any assigned session, whether live or not)
  const tmuxName = (() => {
    for (const [k, v] of assignmentsByTmux.entries()) if (v === project.id) return k;
    return null;
  })();

  useEffect(() => {
    apiRequest<{ pomodoros: Pomodoro[] }>("GET", `/api/pomodoros?projectId=${encodeURIComponent(project.id)}`).then(r => {
      if (r.ok) setPomodoros((r.body as { pomodoros: Pomodoro[] }).pomodoros);
    });
  }, [project.id]);

  // Per-task minutes for THIS project, computed from this project's pomodoros.
  const minsByTask = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pomodoros) {
      const { byTask } = attributeMinutes(p, taskById);
      for (const [tid, mins] of byTask.entries()) m.set(tid, (m.get(tid) ?? 0) + mins);
    }
    return m;
  }, [pomodoros, taskById]);

  async function save() {
    setError(null); setBusy(true);
    try {
      const tags = tagsRaw.split(",").map(s => s.trim()).filter(Boolean);
      const trimmedAbbr = abbreviation.trim();
      const trimmedWd = workingDir.trim();
      const patch: Partial<Project> = {
        color, tags, notes,
        abbreviation: trimmedAbbr.length > 0 ? trimmedAbbr : null,
        working_dir: trimmedWd.length > 0 ? trimmedWd : null,
      };
      if (!project.system) patch.name = name.trim();
      await updateProject(project.id, patch);
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function toggleComplete() {
    setError(null); setBusy(true);
    try {
      await updateProject(project.id, { completed_at: project.completed_at ? null : new Date().toISOString() });
      onClose();
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function toggleHidden() {
    setError(null); setBusy(true);
    try {
      await updateProject(project.id, { hidden: !project.hidden });
      onClose();
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function doDelete() {
    if (!confirm(`Delete project "${project.name}"?`)) return;
    setError(null); setBusy(true);
    try {
      await deleteProject(project.id);
      onClose();
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function unassign() {
    if (!tmuxName) return;
    setError(null); setBusy(true);
    try { await setAssignment(tmuxName, null); }
    catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  // Smart assign: if a tmux session with this name doesn't exist, create it.
  // Either way, set the project↔tmux assignment by name. If tmux isn't running
  // at all, the assignment is still recorded and will apply when the session appears.
  async function smartAssign() {
    const name = assignTo.trim();
    if (!name) return;
    setError(null); setBusy(true);
    let info = "";
    try {
      const cwd = workingDir.trim() || undefined;
      const r = await apiRequest<{ ok: boolean; name: string }>("POST", "/api/tmux/sessions", { name, cwd });
      if (r.ok) {
        info = `Created tmux session "${name}".`;
      } else {
        const body = r.body as { error: string; existingCwds?: string[]; cwdMismatch?: boolean };
        const err = body.error ?? "";
        if (err.includes("already exists")) {
          if (body.cwdMismatch && workingDir.trim()) {
            const cwds = (body.existingCwds ?? []).map(c => `  • ${c}`).join("\n");
            info =
              `⚠ Tmux session "${name}" already exists, but no pane is in your working_dir (${workingDir.trim()}).\n` +
              `Existing panes are in:\n${cwds}\n\n` +
              `Tmux can't change an existing session's cwd. To use the new working_dir:\n` +
              `  1. tmux kill-session -t ${name}\n` +
              `  2. Click Assign again\n` +
              `Or non-destructively add a window:\n` +
              `  tmux new-window -t ${name} -c "${workingDir.trim()}"`;
          } else {
            info = `Tmux session "${name}" already exists; reusing it.`;
          }
        } else {
          // Tmux down or other error — still record the assignment by name.
          info = `Note: could not probe/create tmux (${err}). Assignment recorded; will apply when a session named "${name}" exists.`;
        }
      }
      await setAssignment(name, project.id);
      setError(info);   // surface as info text (red color is fine; not actually an error)
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function addTask() {
    if (!newTaskName.trim()) return;
    setError(null); setBusy(true);
    try {
      await createTask({ project_id: project.id, name: newTaskName.trim() });
      setNewTaskName("");
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function toggleTask(t: Task) {
    setError(null); setBusy(true);
    try {
      await updateTask(t.id, { completed_at: t.completed_at ? null : new Date().toISOString() });
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function removeTask(t: Task) {
    if (!confirm(`Delete task "${t.name}"?`)) return;
    setError(null); setBusy(true);
    try {
      await deleteTask(t.id);
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-lg bg-slate-900 border-l border-slate-700 p-6 overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <ProjectChip project={project} />
            <div className="flex items-center gap-1">
              <ProgressChip progress={derivedStatus?.progress ?? "not_started"} />
              <EngagementChip engagement={derivedStatus?.engagement ?? "parked"} />
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="space-y-4">
          <label className="block">
            <span className="text-sm text-slate-300">Name {project.system && <span className="text-xs text-slate-500">(locked — system project)</span>}</span>
            <input
              value={name} onChange={e => setName(e.target.value)} disabled={project.system}
              className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm disabled:opacity-50"
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">Color</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {PROJECT_PALETTE.map(c => (
                <button key={c} onClick={() => setColor(c)}
                  className={`w-6 h-6 rounded ${color === c ? "ring-2 ring-white" : ""}`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <input value={color} onChange={e => setColor(e.target.value)}
                className="ml-2 w-24 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono"
              />
            </div>
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">Abbreviation <span className="text-xs text-slate-500">(used in chips like ABC › task)</span></span>
            <input value={abbreviation} onChange={e => setAbbreviation(e.target.value)}
              placeholder={autoAbbr ? `auto: ${autoAbbr}` : "auto-computed from name"}
              maxLength={12}
              className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm font-mono" />
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">Working directory <span className="text-xs text-slate-500">(used when creating a tmux session for this project)</span></span>
            <input value={workingDir} onChange={e => setWorkingDir(e.target.value)}
              placeholder="e.g. /home/dsu/Projects/MyApp or ~/Projects/MyApp"
              className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm font-mono" />
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">Tags</span>
            <input value={tagsRaw} onChange={e => setTagsRaw(e.target.value)}
              className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm" />
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">Notes</span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={5}
              className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm" />
          </label>

          <div className="border-t border-slate-800 pt-4">
            <div className="text-sm text-slate-300 mb-2">Tmux assignment</div>
            {tmuxName ? (
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-slate-200">{tmuxName}</span>
                {!derivedStatus?.tmux_attached && (
                  <span className="text-xs text-slate-500 italic" title="No live tmux session with this name. The binding is stored and will re-attach automatically when a session with this name appears.">(not live)</span>
                )}
                <button onClick={unassign} disabled={busy}
                  className="text-xs px-2 py-0.5 bg-slate-700 hover:bg-slate-600 rounded">Unassign</button>
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <input value={assignTo} onChange={e => setAssignTo(e.target.value)}
                    placeholder={effectiveAbbr || "tmux session name"}
                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm font-mono" />
                  <button onClick={smartAssign} disabled={busy || !assignTo.trim() || !!project.completed_at}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white disabled:opacity-50"
                    title="If a tmux session with this name exists, just bind to it. If not, create it (tmux new-session -d -s &lt;name&gt;) and bind. If tmux isn't running, the binding is still recorded and applies when a session with this name appears."
                  >Assign</button>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Pre-filled with the project's abbreviation. If the tmux session exists, the project just binds to it. Otherwise a new detached session is created with that name.
                </div>
              </>
            )}
          </div>

          {/* Task management */}
          <div className="border-t border-slate-800 pt-4">
            <div className="text-sm text-slate-300 mb-2">Tasks ({openTasks.length} open · {doneTasks.length} done)</div>
            <div className="space-y-1">
              {openTasks.length === 0 && doneTasks.length === 0 && (
                <div className="text-xs text-slate-500 italic">No tasks yet.</div>
              )}
              {openTasks.map(t => (
                <TaskRow key={t.id} task={t} mins={minsByTask.get(t.id) ?? 0} workdayHours={settings.workdayHours}
                  onToggle={toggleTask} onDelete={removeTask} busy={busy} />
              ))}
              {doneTasks.length > 0 && (
                <>
                  <button
                    onClick={() => setShowDone(s => !s)}
                    className="text-xs text-slate-500 hover:text-slate-300 inline-flex items-center gap-1"
                  >
                    {showDone ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {doneTasks.length} completed
                  </button>
                  {showDone && doneTasks.map(t => (
                    <TaskRow key={t.id} task={t} mins={minsByTask.get(t.id) ?? 0} workdayHours={settings.workdayHours}
                      onToggle={toggleTask} onDelete={removeTask} busy={busy} done />
                  ))}
                </>
              )}
            </div>
            <div className="flex gap-2 mt-2">
              <input value={newTaskName}
                onChange={e => setNewTaskName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") addTask(); }}
                placeholder="New task name…"
                disabled={!!project.completed_at}
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm disabled:opacity-50"
              />
              <button onClick={addTask} disabled={busy || !newTaskName.trim() || !!project.completed_at}
                className="inline-flex items-center gap-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white disabled:opacity-50"
              ><Plus size={12} /> Add</button>
            </div>
          </div>

          {error && (
            <div className={`text-sm whitespace-pre-wrap font-mono ${
              error.startsWith("⚠") ? "text-amber-300" : "text-red-400"
            }`}>{error}</div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
            <button onClick={save} disabled={busy}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white disabled:opacity-50"
            ><Check size={14} /> Save</button>
            {!project.system && (
              <button onClick={toggleComplete} disabled={busy}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm">
                {project.completed_at ? <><RotateCcw size={14} /> Reopen</> : <><Check size={14} /> Mark complete</>}
              </button>
            )}
            {!project.system && (
              <button onClick={toggleHidden} disabled={busy || !!project.completed_at}
                title={project.completed_at
                  ? "Completed projects can't be hidden"
                  : (project.hidden ? "Show this project in the main list" : "Hide this project from the main list")}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm disabled:opacity-50">
                {project.hidden ? <><Eye size={14} /> Unhide</> : <><EyeOff size={14} /> Hide</>}
              </button>
            )}
            {!project.system && (
              <button onClick={doDelete} disabled={busy}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-sm text-white ml-auto"
              ><Trash2 size={14} /> Delete</button>
            )}
          </div>

          <Project30DayChart pomodoros={pomodoros} taskById={useProjects().taskById} projectId={project.id} color={project.color} workdayHours={settings.workdayHours} />

          <ProjectRecentPomodoros pomodoros={pomodoros} workdayHours={settings.workdayHours} onPick={setSelectedPomId} />

          <div className="text-xs text-slate-500 pt-2">
            Created {new Date(project.created_at).toLocaleString()} · updated {new Date(project.updated_at).toLocaleString()}
          </div>
        </div>
      </div>
      {selectedPomId && (
        <PomodoroDetailDrawer pomodoroId={selectedPomId} onClose={() => setSelectedPomId(null)} />
      )}
    </div>
  );
}

function TaskRow({ task, mins, workdayHours, onToggle, onDelete, busy, done }: {
  task: Task;
  mins: number;
  workdayHours: number;
  onToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
  busy: boolean;
  done?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [name, setName] = useState(task.name);
  const [notes, setNotes] = useState(task.notes);
  const [savingNotes, setSavingNotes] = useState(false);
  const { updateTask } = useProjects();
  async function save() {
    try {
      await updateTask(task.id, { name: name.trim(), notes });
      setEditing(false);
    } catch {}
  }
  async function saveNotesOnly() {
    if (notes === task.notes) return;
    setSavingNotes(true);
    try { await updateTask(task.id, { notes }); }
    finally { setSavingNotes(false); }
  }
  const hasNotes = !!task.notes && task.notes.trim().length > 0;
  return (
    <div className={`flex items-start gap-2 py-1 ${done ? "opacity-60" : ""}`}>
      <button onClick={() => onToggle(task)} disabled={busy} className="mt-0.5 text-slate-400 hover:text-white">
        {done ? "☑" : "☐"}
      </button>
      {editing ? (
        <div className="flex-1 space-y-1">
          <input value={name} onChange={e => setName(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-sm" />
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
            placeholder="notes…"
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs" />
          <div className="flex gap-1">
            <button onClick={save} className="text-xs px-2 py-0.5 bg-blue-600 hover:bg-blue-500 rounded">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs px-2 py-0.5 hover:text-white">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-w-0">
          <div className={`text-sm flex items-center gap-2 ${done ? "line-through text-slate-500" : "text-slate-200"}`}>
            <span className="flex-1 truncate">{task.name}</span>
            {hasNotes && <span title="Has notes" className="text-xs">📝</span>}
            {mins > 0 && <span className="text-xs text-slate-500 shrink-0">{formatDuration(mins, workdayHours)}</span>}
          </div>
          {notesOpen && (
            <div className="mt-1">
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                onBlur={saveNotesOnly}
                rows={3}
                placeholder="task notes (saved on blur)"
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
              />
              {savingNotes && <span className="text-[10px] text-slate-500">saving…</span>}
            </div>
          )}
          {!notesOpen && hasNotes && (
            <div className="text-xs text-slate-400 whitespace-pre-wrap">{task.notes}</div>
          )}
        </div>
      )}
      {!editing && (
        <>
          <button
            onClick={() => setNotesOpen(o => !o)}
            className={`text-xs hover:text-white ${notesOpen || hasNotes ? "text-slate-300" : "text-slate-500"}`}
            title={notesOpen ? "Hide notes editor" : hasNotes ? "Edit notes" : "Add notes"}
          >{notesOpen ? "✕ notes" : (hasNotes ? "✏ notes" : "+ notes")}</button>
          <button onClick={() => setEditing(true)} className="text-xs text-slate-500 hover:text-white">edit</button>
          <button onClick={() => onDelete(task)} disabled={busy} className="text-xs text-slate-500 hover:text-red-400"><Trash2 size={12} /></button>
        </>
      )}
    </div>
  );
}

function Project30DayChart({ pomodoros, taskById, projectId, color, workdayHours }: {
  pomodoros: Pomodoro[]; taskById: Map<string, Task>; projectId: string; color: string; workdayHours: number;
}) {
  const days: { date: Date; min: number }[] = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    days.push({ date: d, min: 0 });
  }
  const idx = new Map(days.map((d, i) => [d.date.toDateString(), i]));
  for (const p of pomodoros) {
    const day = new Date(p.started_at); day.setHours(0, 0, 0, 0);
    const i = idx.get(day.toDateString());
    if (i === undefined) continue;
    const { byProject } = attributeMinutes(p, taskById);
    days[i].min += byProject.get(projectId) ?? 0;
  }
  const max = Math.max(1, ...days.map(d => d.min));
  return (
    <div className="border-t border-slate-800 pt-4">
      <div className="text-sm text-slate-300 mb-2">Last 30 days</div>
      <div className="flex items-end gap-[2px] h-16">
        {days.map((d, i) => {
          const h = Math.max(2, (d.min / max) * 64);
          return (
            <div key={i} className="flex-1 rounded-sm"
              style={{ height: `${h}px`, backgroundColor: d.min > 0 ? color : "#1e293b" }}
              title={`${d.date.toLocaleDateString()}: ${formatDuration(d.min, workdayHours)}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function ProjectRecentPomodoros({ pomodoros, workdayHours, onPick }: {
  pomodoros: Pomodoro[]; workdayHours: number; onPick: (id: string) => void;
}) {
  const recent = pomodoros.slice(0, 10);
  if (recent.length === 0) {
    return (
      <div className="border-t border-slate-800 pt-4">
        <div className="text-sm text-slate-300 mb-2">Recent pomodoros</div>
        <div className="text-xs text-slate-500">No pomodoros yet for this project.</div>
      </div>
    );
  }
  return (
    <div className="border-t border-slate-800 pt-4">
      <div className="text-sm text-slate-300 mb-2">Recent pomodoros (last 10)</div>
      <div className="space-y-1">
        {recent.map(p => {
          const min = pomodoroMinutes(p);
          return (
            <button key={p.id} onClick={() => onPick(p.id)}
              className="w-full text-left text-xs hover:bg-slate-800/50 rounded px-2 py-1 flex items-center gap-2"
            >
              <span className="text-slate-400 font-mono">{new Date(p.started_at).toLocaleString()}</span>
              <span className="text-slate-500 ml-auto">{formatDuration(min, workdayHours)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AnchorHeader({ anchor }: { anchor: { ts: string | null; activeWindowHours: number } }) {
  if (anchor.ts === null) {
    return (
      <div className="text-xs text-slate-500 bg-slate-900/60 border border-slate-800 rounded px-3 py-1.5">
        No pomodoros yet — all projects are parked.
      </div>
    );
  }
  const d = new Date(anchor.ts);
  const fmt = d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
  return (
    <div className="text-xs text-slate-500 bg-slate-900/60 border border-slate-800 rounded px-3 py-1.5">
      Active window: <span className="text-slate-300">{anchor.activeWindowHours}h</span>{" "}
      since last pomodoro at <span className="text-slate-300">{fmt}</span>.
    </div>
  );
}

function ProgressChip({ progress }: { progress: "not_started" | "in_progress" | "completed" }) {
  const styles = {
    not_started: { bg: "bg-slate-800", text: "text-slate-400", label: "not started" },
    in_progress: { bg: "bg-blue-900/50", text: "text-blue-300", label: "in progress" },
    completed:   { bg: "bg-green-900/50", text: "text-green-300", label: "✓ completed" },
  }[progress];
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${styles.bg} ${styles.text}`}>{styles.label}</span>;
}

function EngagementChip({ engagement }: { engagement: "active" | "parked" }) {
  const styles = engagement === "active"
    ? { bg: "bg-amber-900/50", text: "text-amber-300" }
    : { bg: "bg-slate-800",    text: "text-slate-500" };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${styles.bg} ${styles.text}`}>{engagement}</span>;
}

function TmuxChip({ name }: { name: string }) {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-900/40 text-cyan-300 font-mono" title={`tmux session: ${name}`}>
      ⌗ {name}
    </span>
  );
}
