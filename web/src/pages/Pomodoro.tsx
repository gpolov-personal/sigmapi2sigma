import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, AlarmClock, Coffee, Play } from "lucide-react";
import { Pomodoro, Project, Task, apiRequest, FREE_PROJECT_ID } from "../api";
import { useSettings } from "../SettingsContext";
import { useProjects } from "../ProjectsContext";
import { ProjectChip } from "../components/ProjectChip";
import { PomodoroDetailDrawer } from "../components/PomodoroDetailDrawer";
import { formatDuration } from "../utils";
import {
  LiveTimerState, LiveRestState, clearActive, clearRest, ensureNotificationPermission,
  fmtMmSs, loadActive, loadRest, notify, playBeep, saveActive, saveRest,
} from "../lib/liveTimer";

const PAGE_SIZE = 50;

function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

function pomDurMin(p: Pomodoro): number {
  return Math.max(0, (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000);
}

interface NextPomodoroProposal {
  projectIds: string[];
  taskIds: string[];
  durationMinutes: number;
  freeTaskLabel?: string;
}

// Same attribution formula as backend / Projects page.
function attribute(
  p: Pomodoro,
  taskById: Map<string, Task>
): { byProject: Map<string, number>; byTask: Map<string, number> } {
  const dur = pomDurMin(p);
  const tasksByProj = new Map<string, string[]>();
  for (const tid of p.task_ids) {
    const t = taskById.get(tid);
    if (!t || !p.project_ids.includes(t.project_id)) continue;
    const arr = tasksByProj.get(t.project_id);
    if (arr) arr.push(tid); else tasksByProj.set(t.project_id, [tid]);
  }
  const units: { project: string; task: string | null }[] = [];
  for (const pid of p.project_ids) {
    const tasks = tasksByProj.get(pid) ?? [];
    if (tasks.length === 0) units.push({ project: pid, task: null });
    else for (const t of tasks) units.push({ project: pid, task: t });
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

export function PomodoroPage() {
  const { settings } = useSettings();
  const { projects, projectById, tasksByProject, taskById } = useProjects();
  const [active, setActive] = useState<LiveTimerState | null>(() => loadActive());
  const [now, setNow] = useState(Date.now());
  const [pickedProjects, setPickedProjects] = useState<string[]>([]);
  const [pickedTasks, setPickedTasks] = useState<string[]>([]);
  const [freeTaskLabel, setFreeTaskLabel] = useState<string>(() => loadActive()?.freeTaskLabel ?? "");
  const [duration, setDuration] = useState<number>(settings.defaultPomodoroDuration);
  const [pomodoros, setPomodoros] = useState<Pomodoro[]>([]);
  const [showManual, setShowManual] = useState(false);
  const [postFlow, setPostFlow] = useState<
    | null
    | { stage: "notes"; pomodoro: Pomodoro }
    | { stage: "rest"; proposal: NextPomodoroProposal; restEndsAt: number }
    | { stage: "restart-prompt"; proposal: NextPomodoroProposal }
  >(() => {
    // Restore rest state from localStorage if present.
    const r = loadRest();
    if (r) return { stage: "rest", proposal: r.proposal, restEndsAt: r.restEndsAt };
    return null;
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const refreshList = useCallback(async () => {
    const r = await apiRequest<{ pomodoros: Pomodoro[] }>("GET", "/api/pomodoros");
    if (r.ok) setPomodoros((r.body as { pomodoros: Pomodoro[] }).pomodoros);
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);

  const isResting = postFlow?.stage === "rest";
  useEffect(() => {
    if (!active && !isResting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, isResting]);

  useEffect(() => {
    if (!active) setDuration(settings.defaultPomodoroDuration);
  }, [settings.defaultPomodoroDuration, active]);

  const targetMs = active ? active.startedAt + active.targetDurationMinutes * 60_000 : 0;
  const remainingMs = active ? targetMs - now : 0;
  const elapsedMs = active ? now - active.startedAt : 0;

  const startTimerFromProposal = useCallback(async (proposal: NextPomodoroProposal, freeLabel?: string) => {
    if (settings.notificationsEnabled) ensureNotificationPermission();
    // The first user-gesture call to playBeep also unlocks the AudioContext.
    if (settings.audioEnabled) playBeep(settings.startBeepSound);
    const label = (freeLabel ?? "").trim();
    const s: LiveTimerState = {
      startedAt: Date.now(),
      targetDurationMinutes: proposal.durationMinutes,
      topicIds: proposal.projectIds,
      taskIds: proposal.taskIds,
      freeTaskLabel: label,
    };
    saveActive(s);
    setActive(s);
    setPickedProjects(proposal.projectIds);
    setPickedTasks(proposal.taskIds);
    setFreeTaskLabel(label);
    setDuration(proposal.durationMinutes);
    setNow(Date.now());
  }, [settings.audioEnabled, settings.notificationsEnabled, settings.startBeepSound]);

  // Use the timer state's taskIds (which is persisted to localStorage) — single source of truth.
  const finalizePomodoro = useCallback(async (state: LiveTimerState, endedAtMs: number) => {
    const startedAt = new Date(state.startedAt).toISOString();
    const endedAt = new Date(endedAtMs).toISOString();
    const r = await apiRequest<Pomodoro>("POST", "/api/pomodoros", {
      started_at: startedAt,
      ended_at: endedAt,
      target_duration_minutes: state.targetDurationMinutes,
      project_ids: state.topicIds,
      task_ids: state.taskIds ?? [],
      notes: "",
      freeTaskLabel: state.freeTaskLabel ?? "",
      source: "live-timer",
    });
    clearActive();
    setActive(null);
    if (r.ok) {
      const saved = r.body as Pomodoro;
      setPostFlow({ stage: "notes", pomodoro: saved });
      await refreshList();
    } else {
      setError((r.body as { error: string }).error);
    }
  }, [refreshList]);

  // Auto-stop watcher — fires EXACTLY ONCE per active pomodoro reaching its target.
  // (Without dedup, the 1s tick keeps re-running the effect during the in-flight POST.)
  const firedAutoStopRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      firedAutoStopRef.current = null;
      return;
    }
    if (now < targetMs) return;
    if (firedAutoStopRef.current === active.startedAt) return;
    firedAutoStopRef.current = active.startedAt;
    if (settings.audioEnabled) playBeep(settings.endBeepSound);
    const names = active.topicIds.map(id => projectById.get(id)?.name ?? id.slice(0, 6)).join(", ");
    if (settings.notificationsEnabled) notify("Pomodoro complete", names);
    // Sync the latest taskIds + freeTaskLabel from React state into the timer
    // before finalizing — covers the case where the user edited either during
    // a running pomodoro and let it auto-complete.
    const synced: LiveTimerState = { ...active, taskIds: pickedTasks, freeTaskLabel: freeTaskLabel.trim() };
    finalizePomodoro(synced, targetMs);
  }, [active, now, targetMs, settings.audioEnabled, settings.notificationsEnabled, settings.endBeepSound, projectById, finalizePomodoro, pickedTasks, freeTaskLabel]);

  // End-of-rest watcher — same dedup pattern.
  const firedRestEndRef = useRef<number | null>(null);
  useEffect(() => {
    if (postFlow?.stage !== "rest") {
      firedRestEndRef.current = null;
      return;
    }
    if (now < postFlow.restEndsAt) return;
    if (firedRestEndRef.current === postFlow.restEndsAt) return;
    firedRestEndRef.current = postFlow.restEndsAt;
    if (settings.audioEnabled) playBeep(settings.endBeepSound);
    if (settings.notificationsEnabled) notify("Rest finished", "Ready for the next pomodoro?");
    clearRest();
    setPostFlow({ stage: "restart-prompt", proposal: postFlow.proposal });
  }, [postFlow, now, settings.audioEnabled, settings.notificationsEnabled, settings.endBeepSound]);

  // Tab title.
  useEffect(() => {
    if (active) {
      const names = active.topicIds.map(id => projectById.get(id)?.name ?? "?").join(", ");
      document.title = `⏱ ${fmtMmSs(Math.max(0, remainingMs))} · ${names}`;
      return () => { document.title = "ΣΠ ∪ ΠΣ"; };
    }
    if (postFlow?.stage === "rest") {
      document.title = `☕ ${fmtMmSs(Math.max(0, postFlow.restEndsAt - now))} · rest`;
      return () => { document.title = "ΣΠ ∪ ΠΣ"; };
    }
    document.title = "ΣΠ ∪ ΠΣ";
  }, [active, remainingMs, postFlow, now, projectById]);

  function toggleProject(id: string) {
    setPickedProjects(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      // Drop tasks belonging to projects no longer picked.
      setPickedTasks(t => t.filter(tid => {
        const task = taskById.get(tid);
        return task && next.includes(task.project_id);
      }));
      return next;
    });
  }
  function toggleTask(id: string) {
    setPickedTasks(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function startTimer() {
    if (pickedProjects.length === 0) return;
    await startTimerFromProposal(
      { projectIds: pickedProjects, taskIds: pickedTasks, durationMinutes: duration },
      freeTaskLabel
    );
  }

  async function stopTimer() {
    if (!active) return;
    // Always sync taskIds + freeTaskLabel from current React state into the active timer before finalizing.
    const synced: LiveTimerState = { ...active, taskIds: pickedTasks, freeTaskLabel: freeTaskLabel.trim() };
    saveActive(synced);
    await finalizePomodoro(synced, Date.now());
  }

  function keepGoing() {
    if (!active) return;
    const next: LiveTimerState = { ...active, targetDurationMinutes: active.targetDurationMinutes + settings.defaultPomodoroDuration };
    saveActive(next);
    setActive(next);
  }

  function discardActive() { clearActive(); setActive(null); }

  // Today summary.
  const today = startOfDay(new Date()).getTime();
  const tomorrow = today + 86400_000;
  const todayPoms = pomodoros.filter(p => {
    const t = Date.parse(p.started_at);
    return t >= today && t < tomorrow;
  });
  const todayMinutes = todayPoms.reduce((s, p) => s + pomDurMin(p), 0);
  const byProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of todayPoms) {
      const { byProject: bp } = attribute(p, taskById);
      for (const [pid, mins] of bp.entries()) m.set(pid, (m.get(pid) ?? 0) + mins);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [todayPoms, taskById]);

  const byTask = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of todayPoms) {
      const { byTask: bt } = attribute(p, taskById);
      for (const [tid, mins] of bt.entries()) m.set(tid, (m.get(tid) ?? 0) + mins);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [todayPoms, taskById]);

  const eligibleProjects = projects.filter(p => !p.completed_at);
  const eligibleTasksForPicked = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const pid of pickedProjects) {
      const ts = (tasksByProject.get(pid) ?? []).filter(t => !t.completed_at);
      map.set(pid, ts);
    }
    return map;
  }, [pickedProjects, tasksByProject]);

  const totalPages = Math.max(1, Math.ceil(pomodoros.length / PAGE_SIZE));
  const pageItems = pomodoros.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const restRemainingMs = postFlow?.stage === "rest" ? Math.max(0, postFlow.restEndsAt - now) : 0;

  function cancelRest() {
    if (postFlow?.stage !== "rest") return;
    // Prefill picker with the rest's proposal so user can reconfigure.
    setPickedProjects(postFlow.proposal.projectIds);
    setPickedTasks(postFlow.proposal.taskIds);
    setFreeTaskLabel(postFlow.proposal.freeTaskLabel ?? "");
    setDuration(postFlow.proposal.durationMinutes);
    clearRest();
    setPostFlow(null);
  }
  function skipRest() {
    if (postFlow?.stage !== "rest") return;
    clearRest();
    setPostFlow({ stage: "restart-prompt", proposal: postFlow.proposal });
  }

  return (
    <div className="space-y-6">
      {/* Live timer / rest block (single source of truth on the page) */}
      <div className={`border rounded p-4 ${postFlow?.stage === "rest" ? "border-amber-700 bg-amber-950/20" : "border-slate-800 bg-slate-900/50"}`}>
        {postFlow?.stage === "rest" ? (
          // ─── RESTING ───────────────────────────────────────────
          <>
            <div className="flex items-center gap-4 flex-wrap">
              <Coffee size={20} className="text-amber-400" />
              <div className="font-mono text-3xl tabular-nums text-amber-200">
                {fmtMmSs(restRemainingMs)}
              </div>
              <div className="text-xs text-amber-300/80">resting · of {settings.restMinutes} min</div>
              <div className="flex-1" />
              <button onClick={skipRest}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">Skip rest</button>
              <button onClick={cancelRest}
                className="px-2 py-1.5 text-xs text-slate-400 hover:text-white">cancel</button>
            </div>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500">Next pomodoro will be:</span>
              {postFlow.proposal.projectIds.map(pid => {
                const p = projectById.get(pid);
                return <ProjectChip key={pid} project={p} label={p?.name ?? "?"} />;
              })}
              {postFlow.proposal.taskIds.length > 0 && (
                <>
                  <span className="text-xs text-slate-500">·</span>
                  {postFlow.proposal.taskIds.map(tid => {
                    const t = taskById.get(tid);
                    const p = t ? projectById.get(t.project_id) : null;
                    return <ProjectChip key={tid} project={p} task={t} />;
                  })}
                </>
              )}
              <span className="text-xs text-slate-500 ml-2">· {postFlow.proposal.durationMinutes}m</span>
            </div>
          </>
        ) : (
          // ─── IDLE OR RUNNING ────────────────────────────────────
          <>
            <div className="flex items-center gap-4 flex-wrap">
              <AlarmClock size={20} className="text-slate-400" />
              <div className="font-mono text-3xl tabular-nums">
                {active ? fmtMmSs(Math.max(0, remainingMs)) : `${String(duration).padStart(2, "0")}:00`}
              </div>
              {!active && (
                <input type="number" min={1} max={180} value={duration}
                  onChange={e => setDuration(Math.max(1, Math.min(180, Number(e.target.value))))}
                  className="w-20 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
                  title="duration in minutes"
                />
              )}
              {active && (
                <div className="text-xs text-slate-400">elapsed {fmtMmSs(elapsedMs)} / target {active.targetDurationMinutes}m</div>
              )}
              <div className="flex-1" />
              {!active ? (
                <button onClick={startTimer} disabled={pickedProjects.length === 0}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white disabled:opacity-50">Start</button>
              ) : (
                <>
                  <button onClick={keepGoing} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm">Keep going (+{settings.defaultPomodoroDuration}m)</button>
                  <button onClick={stopTimer} className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-sm text-white">Stop</button>
                  <button onClick={discardActive} title="Discard without saving" className="px-2 py-1.5 text-xs text-slate-500 hover:text-white">discard</button>
                </>
              )}
            </div>

            {/* Project picker */}
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500">Projects:</span>
              {!active ? (
                eligibleProjects.length === 0
                  ? <span className="text-xs text-slate-500">No projects.</span>
                  : eligibleProjects.map(p => (
                    <button key={p.id} onClick={() => toggleProject(p.id)}
                      className={`px-2 py-0.5 rounded text-xs border ${pickedProjects.includes(p.id) ? "border-white" : "border-transparent opacity-70 hover:opacity-100"}`}
                      style={{ backgroundColor: p.color, color: "#fff" }}
                    >{p.name}</button>
                  ))
              ) : (
                active.topicIds.map(id => {
                  const p = projectById.get(id);
                  return <ProjectChip key={id} project={p} label={p?.name ?? id.slice(0, 6)} />;
                })
              )}
            </div>

            {/* Task picker — only when projects are picked and timer not running */}
            {!active && pickedProjects.length > 0 && (
              <div className="mt-2 space-y-1">
                {pickedProjects.map(pid => {
                  const proj = projectById.get(pid);
                  const tasksForP = eligibleTasksForPicked.get(pid) ?? [];
                  if (pid === FREE_PROJECT_ID) {
                    return (
                      <div key={pid} className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs" style={{ color: proj?.color }}>{proj?.name ?? "Free"}:</span>
                        <input
                          value={freeTaskLabel}
                          onChange={e => setFreeTaskLabel(e.target.value)}
                          placeholder="What are you working on?"
                          maxLength={200}
                          className="flex-1 min-w-64 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-[11px]"
                        />
                      </div>
                    );
                  }
                  if (tasksForP.length === 0) {
                    return (
                      <div key={pid} className="flex items-center gap-2 text-xs text-slate-500 italic">
                        <span style={{ color: proj?.color }}>{proj?.name ?? "?"}</span>
                        <span>· no tasks (project-level time)</span>
                      </div>
                    );
                  }
                  return (
                    <div key={pid} className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs" style={{ color: proj?.color }}>{proj?.name ?? "?"}:</span>
                      {tasksForP.map(t => (
                        <button key={t.id} onClick={() => toggleTask(t.id)}
                          className={`px-1.5 py-0.5 rounded text-[11px] border ${pickedTasks.includes(t.id) ? "border-white bg-slate-700" : "border-slate-700 hover:bg-slate-800"}`}
                        >{t.name}</button>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Active free-label input — editable while timer runs (synced to live state at stop time). */}
            {active && active.topicIds.includes(FREE_PROJECT_ID) && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className="text-xs" style={{ color: projectById.get(FREE_PROJECT_ID)?.color ?? "#64748b" }}>Free:</span>
                <input
                  value={freeTaskLabel}
                  onChange={e => setFreeTaskLabel(e.target.value)}
                  placeholder="What are you working on?"
                  maxLength={200}
                  className="flex-1 min-w-64 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-[11px]"
                />
              </div>
            )}

            {active && pickedTasks.length > 0 && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-500">Tasks:</span>
                {pickedTasks.map(tid => {
                  const t = taskById.get(tid);
                  const p = t ? projectById.get(t.project_id) : null;
                  return <ProjectChip key={tid} project={p} task={t} />;
                })}
              </div>
            )}

            {error && <div className="mt-2 text-sm text-red-400">{error}</div>}
          </>
        )}
      </div>

      {/* Today summary */}
      <div className="border border-slate-800 rounded p-4 bg-slate-900/30">
        <div className="flex items-center gap-4">
          <div className="text-sm text-slate-400">Today</div>
          <div className="text-lg font-mono">{formatDuration(todayMinutes, settings.workdayHours)}</div>
          <div className="text-sm text-slate-400">· {todayPoms.length} pomodoros</div>
          <div className="text-xs text-slate-500 ml-auto">1 workday = {settings.workdayHours}h</div>
        </div>
        {byProject.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            <span className="text-slate-500">by project:</span>
            {byProject.map(([pid, mins]) => {
              const p = projectById.get(pid);
              return (
                <span key={pid} className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: p?.color ?? "#475569" }} />
                  <span className="text-slate-300">{p?.name ?? "[deleted]"}</span>
                  <span className="text-slate-500">{formatDuration(mins, settings.workdayHours)}</span>
                </span>
              );
            })}
          </div>
        )}
        {byTask.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-3 text-xs">
            <span className="text-slate-500">by task:</span>
            {byTask.map(([tid, mins]) => {
              const t = taskById.get(tid);
              const p = t ? projectById.get(t.project_id) : null;
              return (
                <span key={tid} className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: p?.color ?? "#475569" }} />
                  <span className="text-slate-300">{t?.name ?? "[deleted]"}</span>
                  <span className="text-slate-500">{formatDuration(mins, settings.workdayHours)}</span>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <button onClick={() => setShowManual(true)}
          className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-sm"
        ><Plus size={14} /> Log past pomodoro</button>
      </div>

      {/* Recent table */}
      <div>
        <div className="flex items-center mb-2">
          <div className="text-sm text-slate-400">Recent ({pomodoros.length} total)</div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="px-2 py-1 bg-slate-800 border border-slate-700 rounded disabled:opacity-40">← Newer</button>
            <span className="text-slate-500">page {page + 1} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              className="px-2 py-1 bg-slate-800 border border-slate-700 rounded disabled:opacity-40">Older →</button>
          </div>
        </div>
        <div className="border border-slate-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Duration</th>
                <th className="text-left px-3 py-2">Projects / Tasks</th>
                <th className="text-left px-3 py-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-500">No pomodoros yet.</td></tr>
              )}
              {pageItems.map(p => {
                const min = pomDurMin(p);
                return (
                  <tr key={p.id} onClick={() => setSelectedId(p.id)}
                      className="border-t border-slate-800 hover:bg-slate-900/60 cursor-pointer align-top">
                    <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{new Date(p.started_at).toLocaleString()}</td>
                    <td className="px-3 py-2 text-xs text-slate-300 whitespace-nowrap">{formatDuration(min, settings.workdayHours)}</td>
                    <td className="px-3 py-2">
                      <PomodoroProjectsCell pomodoro={p} />
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400 truncate max-w-md">{p.notes}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showManual && (
        <ManualPomodoroModal
          onClose={() => setShowManual(false)}
          onSaved={async () => { setShowManual(false); await refreshList(); }}
          projects={eligibleProjects}
        />
      )}

      {postFlow?.stage === "notes" && (
        <NotesAndNextModal
          pomodoro={postFlow.pomodoro}
          restMinutes={settings.restMinutes}
          onCancel={() => {
            setPickedProjects(postFlow.pomodoro.project_ids);
            setPickedTasks(postFlow.pomodoro.task_ids);
            setFreeTaskLabel(postFlow.pomodoro.freeTaskLabel ?? "");
            setDuration(postFlow.pomodoro.target_duration_minutes);
            setPostFlow(null);
          }}
          onTakeRest={async (notes) => {
            if (notes) await apiRequest("PATCH", `/api/pomodoros/${postFlow.pomodoro.id}`, { notes });
            await refreshList();
            const proposal: NextPomodoroProposal = {
              projectIds: postFlow.pomodoro.project_ids,
              taskIds: postFlow.pomodoro.task_ids,
              durationMinutes: postFlow.pomodoro.target_duration_minutes,
              freeTaskLabel: postFlow.pomodoro.freeTaskLabel ?? "",
            };
            const restMin = Number.isFinite(settings.restMinutes) && settings.restMinutes > 0 ? settings.restMinutes : 5;
            const restEndsAt = Date.now() + restMin * 60_000;
            saveRest({ restEndsAt, proposal });
            setPostFlow({ stage: "rest", proposal, restEndsAt });
            setNow(Date.now());
          }}
          onContinueNow={async (notes) => {
            if (notes) await apiRequest("PATCH", `/api/pomodoros/${postFlow.pomodoro.id}`, { notes });
            await refreshList();
            setPostFlow(null);
            await startTimerFromProposal({
              projectIds: postFlow.pomodoro.project_ids,
              taskIds: postFlow.pomodoro.task_ids,
              durationMinutes: postFlow.pomodoro.target_duration_minutes,
            }, postFlow.pomodoro.freeTaskLabel ?? "");
          }}
        />
      )}

      {/* Rest is now rendered inline in the live-timer block above. */}

      {postFlow?.stage === "restart-prompt" && (
        <RestartPromptModal
          proposal={postFlow.proposal}
          onContinue={async () => {
            const proposal = postFlow.proposal;
            setPostFlow(null);
            await startTimerFromProposal(proposal, proposal.freeTaskLabel ?? "");
          }}
          onCancel={() => {
            setPickedProjects(postFlow.proposal.projectIds);
            setPickedTasks(postFlow.proposal.taskIds);
            setFreeTaskLabel(postFlow.proposal.freeTaskLabel ?? "");
            setDuration(postFlow.proposal.durationMinutes);
            setPostFlow(null);
          }}
        />
      )}

      {selectedId && (
        <PomodoroDetailDrawer pomodoroId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

/**
 * Recent table cell — one row per project. Each row: a project-colored pill
 * with the project name, followed by white pills (black text) for each task.
 * Free project's freeTaskLabel renders as a single white pill. Project with
 * no tasks shows "(project-level)" italic in the same row.
 */
function PomodoroProjectsCell({ pomodoro }: { pomodoro: Pomodoro }) {
  const { projectById, taskById } = useProjects();
  const tasksByProj = new Map<string, string[]>();
  for (const tid of pomodoro.task_ids) {
    const t = taskById.get(tid);
    if (!t) continue;
    const arr = tasksByProj.get(t.project_id);
    if (arr) arr.push(tid); else tasksByProj.set(t.project_id, [tid]);
  }
  return (
    <div className="space-y-1">
      {pomodoro.project_ids.map(pid => {
        const proj = projectById.get(pid);
        const tasks = tasksByProj.get(pid) ?? [];
        return (
          <div key={pid} className="flex flex-wrap items-center gap-1">
            <ProjectChip project={proj} label={proj?.name ?? "[deleted]"} />
            {pid === FREE_PROJECT_ID && pomodoro.freeTaskLabel && (
              <ProjectChip color="#ffffff" label={pomodoro.freeTaskLabel} />
            )}
            {pid === FREE_PROJECT_ID && !pomodoro.freeTaskLabel && (
              <span className="text-xs text-slate-500 italic">(no label)</span>
            )}
            {pid !== FREE_PROJECT_ID && tasks.length === 0 && (
              <span className="text-xs text-slate-500 italic">(project-level)</span>
            )}
            {pid !== FREE_PROJECT_ID && tasks.map(tid => (
              <ProjectChip key={tid} color="#ffffff" label={taskById.get(tid)?.name ?? "[deleted]"} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function PomodoroChips({ pomodoro }: { pomodoro: Pomodoro }) {
  const { projectById, taskById } = useProjects();
  // For each project: render a chip per task. Free with a freeTaskLabel renders as
  // "Free › <label>" using the chip's `label` prop (no Task object needed).
  const chips: { key: string; project: Project | undefined; task?: ReturnType<typeof taskById.get>; label?: string }[] = [];
  const tasksByProj = new Map<string, string[]>();
  for (const tid of pomodoro.task_ids) {
    const t = taskById.get(tid);
    if (!t) continue;
    const arr = tasksByProj.get(t.project_id);
    if (arr) arr.push(tid); else tasksByProj.set(t.project_id, [tid]);
  }
  for (const pid of pomodoro.project_ids) {
    const proj = projectById.get(pid);
    const tasks = tasksByProj.get(pid) ?? [];
    if (pid === FREE_PROJECT_ID && pomodoro.freeTaskLabel) {
      chips.push({ key: pid, project: proj, label: `${proj?.name ?? "Free"} › ${pomodoro.freeTaskLabel}` });
      continue;
    }
    if (tasks.length === 0) {
      chips.push({ key: pid, project: proj });
    } else {
      for (const tid of tasks) chips.push({ key: `${pid}:${tid}`, project: proj, task: taskById.get(tid) });
    }
  }
  return (
    <>
      {chips.map(c => (
        <ProjectChip key={c.key} project={c.project} task={c.task ?? null}
          label={c.label ?? (c.project ? undefined : "[deleted]")} />
      ))}
    </>
  );
}

function NotesAndNextModal({ pomodoro, restMinutes, onCancel, onTakeRest, onContinueNow }: {
  pomodoro: Pomodoro;
  restMinutes: number;
  onCancel: () => void;
  onTakeRest: (notes: string) => void;
  onContinueNow: (notes: string) => void;
}) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  async function call(fn: (n: string) => void) { setBusy(true); try { fn(notes); } finally { setBusy(false); } }
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6">
      <div className="bg-slate-900 border border-slate-700 rounded w-full max-w-md p-6 space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold">Pomodoro complete</h2>
          <button onClick={onCancel} className="text-slate-400"><X size={18} /></button>
        </div>
        <textarea autoFocus value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Notes (optional)…" rows={3}
          className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
        />
        <div className="text-sm text-slate-300">What's next?</div>
        <div className="flex flex-col gap-2">
          <button disabled={busy} onClick={() => call(onTakeRest)}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white"
          ><Coffee size={16} /> Take a {restMinutes}-min rest</button>
          <button disabled={busy} onClick={() => call(onContinueNow)}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
          ><Play size={16} /> Start same pomodoro now</button>
          <button disabled={busy} onClick={onCancel}
            className="px-3 py-2 text-sm text-slate-400 hover:text-white"
          >Cancel — let me reconfigure</button>
        </div>
        <div className="text-xs text-slate-500">
          Cancel returns you to the picker prefilled with the same {pomodoro.project_ids.length} project(s){pomodoro.task_ids.length > 0 ? ` and ${pomodoro.task_ids.length} task(s)` : ""} and {pomodoro.target_duration_minutes}-min duration.
        </div>
      </div>
    </div>
  );
}

// RestModal removed — rest is now rendered inline in the Pomodoro page. Stub kept for reference.
function _RestModal({ remainingMs, totalMinutes, onSkip, onCancel }: {
  remainingMs: number; totalMinutes: number; onSkip: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6">
      <div className="bg-slate-900 border border-slate-700 rounded w-full max-w-sm p-6 space-y-4 text-center">
        <div className="flex items-center justify-center gap-2 text-slate-300"><Coffee size={18} /> Resting</div>
        <div className="font-mono text-4xl tabular-nums">{fmtMmSs(remainingMs)}</div>
        <div className="text-xs text-slate-500">of {totalMinutes} min</div>
        <div className="flex flex-col gap-2 pt-2">
          <button onClick={onSkip} className="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">Skip rest</button>
          <button onClick={onCancel} className="px-3 py-2 text-sm text-slate-400 hover:text-white">Cancel — let me reconfigure</button>
        </div>
      </div>
    </div>
  );
}

function RestartPromptModal({ proposal, onContinue, onCancel }: {
  proposal: NextPomodoroProposal;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { projectById, taskById } = useProjects();
  const projNames = proposal.projectIds.map(id => projectById.get(id)?.name ?? "?").join(", ");
  const taskNames = proposal.taskIds.map(id => taskById.get(id)?.name ?? "?").join(", ");
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6">
      <div className="bg-slate-900 border border-slate-700 rounded w-full max-w-md p-6 space-y-4">
        <h2 className="text-lg font-semibold">Rest finished</h2>
        <div className="text-sm text-slate-300">Start another pomodoro with the same projects/tasks?</div>
        <div className="text-xs text-slate-400">
          Projects: {projNames}{taskNames && <> · Tasks: {taskNames}</>} · {proposal.durationMinutes} min
        </div>
        <div className="flex flex-col gap-2 pt-2">
          <button onClick={onContinue}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white"
          ><Play size={16} /> Start same pomodoro now</button>
          <button onClick={onCancel} className="px-3 py-2 text-sm text-slate-400 hover:text-white">Cancel — let me reconfigure</button>
        </div>
      </div>
    </div>
  );
}

function ManualPomodoroModal({ onClose, onSaved, projects }: {
  onClose: () => void; onSaved: () => void; projects: Project[];
}) {
  const { tasksByProject } = useProjects();
  const now = new Date();
  const local = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const [start, setStart] = useState(local(new Date(now.getTime() - 25 * 60_000)));
  const [end, setEnd] = useState(local(now));
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [freeLabel, setFreeLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleProject(id: string) {
    setProjectIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      setTaskIds(t => t.filter(tid => {
        const tk = (tasksByProject.get(id) ?? []).find(x => x.id === tid);
        return tk ? next.includes(id) : true;
      }));
      return next;
    });
  }
  function toggleTask(id: string) {
    setTaskIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function save() {
    setError(null);
    if (projectIds.length === 0) { setError("pick at least one project"); return; }
    const startedAt = new Date(start).toISOString();
    const endedAt = new Date(end).toISOString();
    const target = Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000));
    setBusy(true);
    const r = await apiRequest<Pomodoro>("POST", "/api/pomodoros", {
      started_at: startedAt, ended_at: endedAt, target_duration_minutes: target,
      project_ids: projectIds, task_ids: taskIds, notes,
      freeTaskLabel: projectIds.includes(FREE_PROJECT_ID) ? freeLabel.trim() : "",
      source: "manual",
    });
    setBusy(false);
    if (!r.ok) { setError((r.body as { error: string }).error); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-slate-900 border border-slate-700 rounded w-full max-w-md p-6 space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold">Log past pomodoro</h2>
          <button onClick={onClose} className="text-slate-400"><X size={18} /></button>
        </div>
        <label className="block">
          <span className="text-sm text-slate-300">Start</span>
          <input type="datetime-local" value={start} onChange={e => setStart(e.target.value)}
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm" />
        </label>
        <label className="block">
          <span className="text-sm text-slate-300">End</span>
          <input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)}
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm" />
        </label>
        <div>
          <span className="text-sm text-slate-300">Projects</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {projects.length === 0 && <span className="text-xs text-slate-500">No projects available.</span>}
            {projects.map(p => (
              <button key={p.id} onClick={() => toggleProject(p.id)}
                className={`px-2 py-0.5 rounded text-xs border ${projectIds.includes(p.id) ? "border-white" : "border-transparent opacity-70"}`}
                style={{ backgroundColor: p.color, color: "#fff" }}
              >{p.name}</button>
            ))}
          </div>
        </div>
        {projectIds.length > 0 && (
          <div>
            <span className="text-sm text-slate-300">Tasks (optional)</span>
            <div className="mt-1 space-y-1">
              {projectIds.map(pid => {
                if (pid === FREE_PROJECT_ID) {
                  const proj = projects.find(p => p.id === pid);
                  return (
                    <div key={pid} className="flex flex-wrap items-center gap-1">
                      <span className="text-xs" style={{ color: proj?.color }}>{proj?.name ?? "Free"}:</span>
                      <input
                        value={freeLabel}
                        onChange={e => setFreeLabel(e.target.value)}
                        placeholder="What were you working on?"
                        maxLength={200}
                        className="flex-1 min-w-64 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-[11px]"
                      />
                    </div>
                  );
                }
                const tasks = (tasksByProject.get(pid) ?? []).filter(t => !t.completed_at);
                if (tasks.length === 0) return null;
                const proj = projects.find(p => p.id === pid);
                return (
                  <div key={pid} className="flex flex-wrap items-center gap-1">
                    <span className="text-xs" style={{ color: proj?.color }}>{proj?.name}:</span>
                    {tasks.map(t => (
                      <button key={t.id} onClick={() => toggleTask(t.id)}
                        className={`px-1.5 py-0.5 rounded text-[11px] border ${taskIds.includes(t.id) ? "border-white bg-slate-700" : "border-slate-700"}`}
                      >{t.name}</button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <label className="block">
          <span className="text-sm text-slate-300">Notes</span>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm" />
        </label>
        {error && <div className="text-sm text-red-400">{error}</div>}
        <div className="flex gap-2">
          <button onClick={save} disabled={busy} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white disabled:opacity-50">Save</button>
          <button onClick={onClose} className="px-3 py-1.5 bg-slate-700 rounded text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
