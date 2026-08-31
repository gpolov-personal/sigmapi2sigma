import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
  type Dispatch, type SetStateAction, type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Plus, X, AlarmClock, Coffee, Play, Pause, ChevronDown, ArrowUpToLine } from "lucide-react";
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
import { attributePomodoro as attribute, pomodoroMinutes } from "../lib/pomodoro";

const PAGE_SIZE = 50;

function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

const MAX_FREE_SLOTS = 8;

// A logged Free pomodoro can carry both real tasks and one-off labels, and the two must
// not read alike. Real tasks keep the solid chip every project's tasks use; one-off
// labels get a dashed italic pill against the white per-project cell background.
const ONE_OFF_CHIP_ON_WHITE = "border border-dashed border-slate-400 italic";

// Trim, drop empties, and cap the Free-project slot labels before sending to the server.
function cleanFreeLabels(labels: string[] | undefined): string[] {
  return (labels ?? []).map(s => s.trim()).filter(Boolean).slice(0, MAX_FREE_SLOTS);
}

interface NextPomodoroProposal {
  projectIds: string[];
  taskIds: string[];
  durationMinutes: number;
  freeTaskLabels?: string[];
}

// Add/remove list of Free-project one-off slot inputs — labels scoped to a single
// pomodoro, as opposed to Free's real tasks (see FreeBlock). Holds raw values (may
// include empty rows while editing); the caller cleans them before persisting. Renders
// at least one row.
// `suggestions` are recently-used labels (most-recent first). The fold auto-opens filtered
// as you type; the left ▾ button opens the full list. Keyboard: ↓/↑ move, Enter picks,
// Esc closes.
// `onPromote`, when set, adds a ⇧ button per non-empty row that turns that label into a
// persistent Free task.
function FreeSlotsEditor({ labels, onChange, placeholder, suggestions = [], onPromote, busy }: {
  labels: string[];
  onChange: Dispatch<SetStateAction<string[]>>;
  placeholder?: string;
  suggestions?: string[];
  onPromote?: (label: string) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState<{ row: number; mode: "all" | "filtered" } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rows = labels.length > 0 ? labels : [""];

  // `open` is keyed by row index, so adding or removing a row re-points it at whichever
  // label now sits at that index — after a promote, the fold would hang under the row
  // that shifted up and picking a suggestion would overwrite *that* label. Reset on row
  // count only: keying on content would close the fold on every keystroke and break
  // type-to-filter.
  const rowCount = labels.length;
  const prevRowCount = useRef(rowCount);
  useEffect(() => {
    if (prevRowCount.current !== rowCount) {
      prevRowCount.current = rowCount;
      setOpen(null);
      setActiveIndex(-1);
    }
  }, [rowCount]);

  const setAt = (i: number, v: string) => { const next = rows.slice(); next[i] = v; onChange(next); };
  const removeAt = (i: number) => { const next = rows.slice(); next.splice(i, 1); onChange(next); setOpen(null); };
  const pick = (i: number, v: string) => { const next = rows.slice(); next[i] = v; onChange(next); setOpen(null); setActiveIndex(-1); };

  const optionsFor = (i: number, mode: "all" | "filtered") => {
    if (mode === "all") return suggestions;
    const q = (rows[i] ?? "").trim().toLowerCase();
    return q ? suggestions.filter(s => s.toLowerCase().includes(q)) : suggestions;
  };

  // Typing auto-opens the filtered fold (and closes it when the field is emptied).
  const onType = (i: number, v: string) => {
    setAt(i, v);
    setActiveIndex(-1);
    if (suggestions.length === 0) { setOpen(null); return; }
    setOpen(v.trim().length > 0 ? { row: i, mode: "filtered" } : null);
  };

  // ▾ toggles the full (unfiltered) list.
  const toggleArrow = (i: number) => {
    setActiveIndex(-1);
    setOpen(prev => (prev && prev.row === i && prev.mode === "all") ? null : { row: i, mode: "all" });
  };

  const onKey = (i: number, e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length === 0) return;
    const cur = open && open.row === i ? open : null;
    const opts = cur ? optionsFor(i, cur.mode) : [];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!cur) {
        setOpen({ row: i, mode: (rows[i] ?? "").trim() ? "filtered" : "all" });
        setActiveIndex(0);
      } else {
        setActiveIndex(a => Math.min(a + 1, opts.length - 1));
      }
    } else if (e.key === "ArrowUp") {
      if (!cur) return;
      e.preventDefault();
      setActiveIndex(a => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (cur && activeIndex >= 0 && activeIndex < opts.length) {
        e.preventDefault();
        pick(i, opts[activeIndex]);
      }
    } else if (e.key === "Escape") {
      setOpen(null);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="flex items-start gap-2">
      <span className="text-xs text-slate-500 w-16 shrink-0 pt-1" title="Labels for this pomodoro only — not saved as tasks">
        One-off:
      </span>
      <div className="flex flex-col gap-1 min-w-0 flex-1 max-w-xl">
      {rows.map((label, i) => {
        const cur = open && open.row === i ? open : null;
        const opts = cur ? optionsFor(i, cur.mode) : [];
        return (
          <div key={i} className="relative flex items-center gap-1"
            onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOpen(null); setActiveIndex(-1); } }}
          >
            {suggestions.length > 0 && (
              <button type="button" title="Show recent labels" aria-label="Show recent labels"
                onClick={() => toggleArrow(i)}
                className="text-slate-400 hover:text-white px-0.5 shrink-0"><ChevronDown size={12} /></button>
            )}
            <input
              value={label}
              onChange={e => onType(i, e.target.value)}
              onKeyDown={e => onKey(i, e)}
              placeholder={placeholder ?? "What are you working on?"}
              maxLength={200}
              className="flex-1 min-w-64 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-[11px]"
            />
            {onPromote && label.trim().length > 0 && (
              // blur before promoting: this row is about to be removed, and because rows
              // are keyed by index the focused button would otherwise end up bound to the
              // label that shifts up — a stray Enter/Space would then promote that one.
              <button type="button" disabled={busy}
                onClick={e => { e.currentTarget.blur(); onPromote(label.trim()); }}
                title="Save as a Free task (keeps it for future pomodoros)"
                aria-label="Save as a Free task"
                className="text-slate-500 hover:text-emerald-400 disabled:opacity-40 px-1 shrink-0"><ArrowUpToLine size={12} /></button>
            )}
            {rows.length > 1 && (
              <button type="button" onClick={() => removeAt(i)} title="Remove slot"
                className="text-slate-500 hover:text-red-400 px-1 shrink-0"><X size={12} /></button>
            )}
            {cur && (
              <div className="absolute z-30 top-full left-5 mt-1 w-72 max-h-48 overflow-y-auto bg-slate-800 border border-slate-700 rounded shadow-lg">
                {opts.length === 0 ? (
                  <div className="px-2 py-1 text-[11px] text-slate-500 italic">No matching recent labels</div>
                ) : opts.map((s, j) => (
                  <button key={j} type="button"
                    ref={el => { if (j === activeIndex) el?.scrollIntoView({ block: "nearest" }); }}
                    onClick={() => pick(i, s)}
                    onMouseEnter={() => setActiveIndex(j)}
                    className={`block w-full text-left px-2 py-1 text-[11px] truncate ${j === activeIndex ? "bg-slate-700 text-white" : "text-slate-200 hover:bg-slate-700"}`}
                  >{s}</button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-3">
        {rows.length < MAX_FREE_SLOTS && (
          <button type="button" onClick={() => onChange([...rows, ""])}
            className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1">
            <Plus size={11} /> Add slot
          </button>
        )}
        {rows.length > 1 && <span className="text-[10px] text-slate-600">one time-unit per slot</span>}
      </div>
      </div>
    </div>
  );
}

// Free's block in the pomodoro picker. Free is the one project that carries two kinds of
// work at once, so they get one labelled row each and must never be confused:
//   Tasks:    real Task rows under project_id "free" — persist across pomodoros
//   One-off:  freeTaskLabels — this pomodoro only
// A name may appear in both; that is allowed, they are different things.
// Omit `tasks` to render the one-off row alone (used while the timer runs, where tasks
// are already shown read-only in the generic Tasks chip row).
function FreeBlock({
  color, labels, onChange, suggestions, placeholder,
  tasks, pickedTaskIds, onToggleTask, onSelectTask, onEnsureTask,
}: {
  color?: string;
  labels: string[];
  /** Takes an updater, not just an array: promote resolves after an await, so it must
   *  edit the latest labels rather than the array captured at render time. */
  onChange: Dispatch<SetStateAction<string[]>>;
  suggestions: string[];
  placeholder?: string;
  tasks?: Task[];
  pickedTaskIds?: string[];
  /** Toggles — for the task buttons, where clicking again should deselect. */
  onToggleTask?: (id: string) => void;
  /** Idempotent select — for promote/"+ new", where a double-fire must not deselect. */
  onSelectTask?: (id: string) => void;
  onEnsureTask?: (name: string) => Promise<string | null>;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const picked = pickedTaskIds ?? [];

  // Create-or-reuse a Free task by name, then select it. Shared by "+ new" and by
  // promoting a one-off slot.
  //
  // Everything after the await must go through an updater rather than a value captured
  // before it: `busy` guards the common case, but two different slots can still be in
  // flight together, and a stale snapshot would resurrect an already-promoted label or
  // undo a selection. Selection uses the idempotent onSelectTask for the same reason —
  // a toggle firing twice would deselect the task and drop the work entirely.
  async function commitTask(name: string, onDone?: () => void) {
    if (!onEnsureTask || !name.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const id = await onEnsureTask(name.trim());
      if (id) (onSelectTask ?? onToggleTask)?.(id);
      onDone?.();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  // Removes the promoted label by value, not by index: the array may have shifted while
  // the create was in flight, and splicing a stale index deletes the wrong row.
  async function promote(label: string) {
    await commitTask(label, () => {
      onChange(prev => {
        const i = prev.findIndex(l => l.trim() === label);
        if (i < 0) return prev;
        const next = prev.slice();
        next.splice(i, 1);
        return next;
      });
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs" style={{ color: color ?? "#64748b" }}>Free:</span>
      <div className="pl-2 flex flex-col gap-1">
        {tasks && (
          <div className="flex items-start gap-2">
            <span className="text-xs text-slate-500 w-16 shrink-0 pt-0.5" title="Saved Free tasks — reusable across pomodoros">
              Tasks:
            </span>
            <div className="flex items-center gap-1 flex-wrap min-w-0 flex-1">
              {tasks.map(t => (
                <button key={t.id} type="button" onClick={() => onToggleTask?.(t.id)}
                  className={`px-1.5 py-0.5 rounded text-[11px] border ${picked.includes(t.id) ? "border-white bg-slate-700" : "border-slate-700 hover:bg-slate-800"}`}
                >{t.name}</button>
              ))}
              {onEnsureTask && (adding ? (
                <input
                  autoFocus
                  value={draft}
                  disabled={busy}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitTask(draft, () => { setDraft(""); setAdding(false); });
                    } else if (e.key === "Escape") {
                      setDraft(""); setAdding(false); setErr(null);
                    }
                  }}
                  onBlur={() => { if (!draft.trim()) { setAdding(false); setErr(null); } }}
                  placeholder="New Free task…"
                  maxLength={200}
                  className="w-40 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px]"
                />
              ) : (
                <button type="button" onClick={() => setAdding(true)}
                  className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-0.5 px-1">
                  <Plus size={11} /> new
                </button>
              ))}
            </div>
          </div>
        )}
        <FreeSlotsEditor
          labels={labels}
          onChange={onChange}
          placeholder={placeholder}
          suggestions={suggestions}
          onPromote={onEnsureTask ? promote : undefined}
          busy={busy}
        />
        {err && <div className="text-[11px] text-red-400 pl-[4.5rem]">{err}</div>}
      </div>
    </div>
  );
}


export function PomodoroPage() {
  const { settings } = useSettings();
  const { projects, projectById, tasksByProject, taskById, refresh, updateTask } = useProjects();
  const [active, setActive] = useState<LiveTimerState | null>(() => loadActive());
  const [now, setNow] = useState(Date.now());
  // Seeded from the live timer, like freeTaskLabels below: a refresh mid-pomodoro used to
  // reset these to [] while the timer itself survived, and stop-time then wrote that empty
  // array back over the persisted selections — silently dropping every picked task from
  // the logged record.
  const [pickedProjects, setPickedProjects] = useState<string[]>(() => loadActive()?.topicIds ?? []);
  const [showCompletedInPicker, setShowCompletedInPicker] = useState(false);
  const [showHiddenInPicker, setShowHiddenInPicker] = useState(false);
  const [pickedTasks, setPickedTasks] = useState<string[]>(() => loadActive()?.taskIds ?? []);
  const [freeTaskLabels, setFreeTaskLabels] = useState<string[]>(() => loadActive()?.freeTaskLabels ?? []);
  const [duration, setDuration] = useState<number>(settings.defaultPomodoroDuration);
  const [pomodoros, setPomodoros] = useState<Pomodoro[]>([]);
  const [showManual, setShowManual] = useState(false);
  const [postFlow, setPostFlow] = useState<
    | null
    | { stage: "notes"; pomodoro: Pomodoro }
    | { stage: "rest"; proposal: NextPomodoroProposal; restEndsAt: number; pausedAt: number | null }
    | { stage: "restart-prompt"; proposal: NextPomodoroProposal }
  >(() => {
    // Restore rest state from localStorage if present.
    const r = loadRest();
    if (r) return { stage: "rest", proposal: r.proposal, restEndsAt: r.restEndsAt, pausedAt: r.pausedAt ?? null };
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

  // When paused, "reference time" is frozen at pausedAt — so elapsed and remaining stop ticking.
  // When running, reference is `now`. accumulatedPausedMs is always subtracted from elapsed
  // and added to the target so a 25-min pomodoro means 25 mins of work, not wall-clock.
  const isPaused = !!(active && active.pausedAt);
  const accumulatedPausedMs = active?.accumulatedPausedMs ?? 0;
  const referenceMs = active ? (active.pausedAt ?? now) : now;
  const targetMs = active
    ? active.startedAt + accumulatedPausedMs + active.targetDurationMinutes * 60_000
    : 0;
  const remainingMs = active ? targetMs - referenceMs : 0;
  const elapsedMs = active ? referenceMs - active.startedAt - accumulatedPausedMs : 0;

  const startTimerFromProposal = useCallback(async (proposal: NextPomodoroProposal, freeLabels?: string[]) => {
    if (settings.notificationsEnabled) ensureNotificationPermission();
    // The first user-gesture call to playBeep also unlocks the AudioContext.
    if (settings.audioEnabled) playBeep(settings.startBeepSound);
    const labels = cleanFreeLabels(freeLabels ?? proposal.freeTaskLabels);
    const s: LiveTimerState = {
      startedAt: Date.now(),
      targetDurationMinutes: proposal.durationMinutes,
      topicIds: proposal.projectIds,
      taskIds: proposal.taskIds,
      freeTaskLabels: labels,
    };
    saveActive(s);
    setActive(s);
    setPickedProjects(proposal.projectIds);
    setPickedTasks(proposal.taskIds);
    setFreeTaskLabels(labels);
    setDuration(proposal.durationMinutes);
    setNow(Date.now());
  }, [settings.audioEnabled, settings.notificationsEnabled, settings.startBeepSound]);

  // Use the timer state's taskIds (which is persisted to localStorage) — single source of truth.
  const finalizePomodoro = useCallback(async (state: LiveTimerState, endedAtMs: number) => {
    const startedAt = new Date(state.startedAt).toISOString();
    const endedAt = new Date(endedAtMs).toISOString();
    const accumulatedPausedMs = state.accumulatedPausedMs ?? 0;
    const inProgressPausedMs = state.pausedAt ? Math.max(0, endedAtMs - state.pausedAt) : 0;
    const paused_ms = accumulatedPausedMs + inProgressPausedMs;
    const r = await apiRequest<Pomodoro>("POST", "/api/pomodoros", {
      started_at: startedAt,
      ended_at: endedAt,
      target_duration_minutes: state.targetDurationMinutes,
      project_ids: state.topicIds,
      task_ids: state.taskIds ?? [],
      notes: "",
      freeTaskLabels: cleanFreeLabels(state.freeTaskLabels),
      paused_ms,
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
    if (active.pausedAt) return;  // can't auto-stop while paused
    if (now < targetMs) return;
    if (firedAutoStopRef.current === active.startedAt) return;
    firedAutoStopRef.current = active.startedAt;
    if (settings.audioEnabled) playBeep(settings.endBeepSound);
    const names = active.topicIds.map(id => projectById.get(id)?.name ?? id.slice(0, 6)).join(", ");
    if (settings.notificationsEnabled) notify("Pomodoro complete", names);
    // Sync the latest taskIds + freeTaskLabels from React state into the timer
    // before finalizing — covers the case where the user edited either during
    // a running pomodoro and let it auto-complete.
    const synced: LiveTimerState = { ...active, taskIds: pickedTasks, freeTaskLabels: cleanFreeLabels(freeTaskLabels) };
    finalizePomodoro(synced, targetMs);
  }, [active, now, targetMs, settings.audioEnabled, settings.notificationsEnabled, settings.endBeepSound, projectById, finalizePomodoro, pickedTasks, freeTaskLabels]);

  // End-of-rest watcher — same dedup pattern.
  const firedRestEndRef = useRef<number | null>(null);
  useEffect(() => {
    if (postFlow?.stage !== "rest") {
      firedRestEndRef.current = null;
      return;
    }
    if (postFlow.pausedAt) return;        // don't auto-end a paused rest
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
  // Idempotent counterpart, for selecting a task we just created. A toggle here would
  // deselect on a second fire and silently drop the task from the pomodoro.
  function selectTask(id: string) {
    setPickedTasks(prev => prev.includes(id) ? prev : [...prev, id]);
  }

  async function startTimer() {
    if (pickedProjects.length === 0) return;
    await startTimerFromProposal(
      { projectIds: pickedProjects, taskIds: pickedTasks, durationMinutes: duration },
      freeTaskLabels
    );
  }

  async function stopTimer() {
    if (!active) return;
    // Always sync taskIds + freeTaskLabels from current React state into the active timer before finalizing.
    const synced: LiveTimerState = { ...active, taskIds: pickedTasks, freeTaskLabels: cleanFreeLabels(freeTaskLabels) };
    saveActive(synced);
    await finalizePomodoro(synced, Date.now());
  }

  // Fold the picker's current selections into a live-timer record before persisting it.
  // keepGoing/pause/resume rewrite the whole record, so spreading `active` alone would
  // write back the tasks and labels as they were at Start and discard anything edited
  // since — the One-off row stays editable for the entire pomodoro.
  const withCurrentSelections = useCallback((base: LiveTimerState): LiveTimerState => ({
    ...base,
    taskIds: pickedTasks,
    freeTaskLabels: cleanFreeLabels(freeTaskLabels),
  }), [pickedTasks, freeTaskLabels]);

  function keepGoing() {
    if (!active) return;
    const next = withCurrentSelections({ ...active, targetDurationMinutes: active.targetDurationMinutes + settings.defaultPomodoroDuration });
    saveActive(next);
    setActive(next);
  }

  function pauseTimer() {
    if (!active || active.pausedAt) return;
    const next = withCurrentSelections({ ...active, pausedAt: Date.now() });
    saveActive(next);
    setActive(next);
  }

  function resumeTimer() {
    if (!active || !active.pausedAt) return;
    const additional = Date.now() - active.pausedAt;
    const next = withCurrentSelections({
      ...active,
      pausedAt: null,
      accumulatedPausedMs: (active.accumulatedPausedMs ?? 0) + additional,
    });
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
  const todayMinutes = todayPoms.reduce((s, p) => s + pomodoroMinutes(p), 0);
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

  // Last 20 distinct Free-slot labels, most-recent first — offered as reuse suggestions.
  // Derived from logged pomodoros (server returns them newest-first; sort defensively).
  const freeLabelSuggestions = useMemo(() => {
    const ordered = [...pomodoros].sort((a, b) => b.started_at.localeCompare(a.started_at));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of ordered) {
      for (const label of p.freeTaskLabels ?? []) {
        const key = label.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(label.trim());
        if (out.length >= 20) return out;
      }
    }
    return out;
  }, [pomodoros]);

  const hiddenInPickerCount = projects.filter(p => p.hidden).length;
  const eligibleProjects = projects.filter(p => {
    if (!showCompletedInPicker && p.completed_at) return false;
    if (!showHiddenInPicker && p.hidden) return false;
    return true;
  });
  const eligibleTasksForPicked = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const pid of pickedProjects) {
      const ts = (tasksByProject.get(pid) ?? []).filter(t => !t.completed_at);
      map.set(pid, ts);
    }
    return map;
  }, [pickedProjects, tasksByProject]);

  // Create-or-reuse a Free task by name and return its id. Backs both "+ new" and
  // promoting a one-off slot. Task names are unique per project (server-enforced,
  // case-insensitive), so a collision resolves to the existing row rather than failing —
  // and a completed match is reopened, since selecting a task the picker hides would
  // look like a no-op. Goes through apiRequest rather than the context's createTask,
  // which discards the 409's `details.existingId`.
  const ensureFreeTask = useCallback(async (rawName: string): Promise<string | null> => {
    const name = rawName.trim();
    if (!name) return null;
    const existing = (tasksByProject.get(FREE_PROJECT_ID) ?? [])
      .find(t => t.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (existing.completed_at) await updateTask(existing.id, { completed_at: null });
      return existing.id;
    }
    const r = await apiRequest<Task>("POST", "/api/tasks", { project_id: FREE_PROJECT_ID, name });
    if (r.ok) { await refresh(); return (r.body as Task).id; }
    // Lost a race against another tab creating the same name. The local list was stale, so
    // it may also be stale about completion: fetch the duplicate and reopen it if needed,
    // the same as the found-locally branch above. Skipping this returned an id the picker
    // then filtered out as completed, so the click looked like it did nothing.
    const dupId = (r.body as any)?.details?.existingId;
    if (r.status === 409 && typeof dupId === "string") {
      const dup = await apiRequest<Task>("GET", `/api/tasks/${dupId}`);
      if (dup.ok && (dup.body as Task).completed_at) {
        await updateTask(dupId, { completed_at: null });   // refreshes the context itself
      } else {
        await refresh();
      }
      return dupId;
    }
    throw new Error((r.body as any)?.error ?? "could not create Free task");
  }, [tasksByProject, updateTask, refresh]);

  const totalPages = Math.max(1, Math.ceil(pomodoros.length / PAGE_SIZE));
  const pageItems = pomodoros.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const restIsPaused = postFlow?.stage === "rest" && !!postFlow.pausedAt;
  const restReferenceMs = postFlow?.stage === "rest" ? (postFlow.pausedAt ?? now) : now;
  const restRemainingMs = postFlow?.stage === "rest" ? Math.max(0, postFlow.restEndsAt - restReferenceMs) : 0;

  function cancelRest() {
    if (postFlow?.stage !== "rest") return;
    // Prefill picker with the rest's proposal so user can reconfigure.
    setPickedProjects(postFlow.proposal.projectIds);
    setPickedTasks(postFlow.proposal.taskIds);
    setFreeTaskLabels(postFlow.proposal.freeTaskLabels ?? []);
    setDuration(postFlow.proposal.durationMinutes);
    clearRest();
    setPostFlow(null);
  }
  function skipRest() {
    if (postFlow?.stage !== "rest") return;
    clearRest();
    setPostFlow({ stage: "restart-prompt", proposal: postFlow.proposal });
  }

  function pauseRest() {
    if (postFlow?.stage !== "rest" || postFlow.pausedAt) return;
    const pausedAt = Date.now();
    saveRest({ restEndsAt: postFlow.restEndsAt, proposal: postFlow.proposal, pausedAt });
    setPostFlow({ ...postFlow, pausedAt });
  }

  function resumeRest() {
    if (postFlow?.stage !== "rest" || !postFlow.pausedAt) return;
    const additional = Date.now() - postFlow.pausedAt;
    const newEndsAt = postFlow.restEndsAt + additional;
    saveRest({ restEndsAt: newEndsAt, proposal: postFlow.proposal, pausedAt: null });
    setPostFlow({ ...postFlow, restEndsAt: newEndsAt, pausedAt: null });
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
              <div className="text-xs text-amber-300/80 flex items-center gap-2">
                <span>resting · of {settings.restMinutes} min</span>
                {restIsPaused && <span className="text-amber-200">⏸ paused</span>}
              </div>
              <div className="flex-1" />
              {restIsPaused ? (
                <button onClick={resumeRest} className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-sm text-white">
                  <Play size={14} /> Resume
                </button>
              ) : (
                <button onClick={pauseRest} className="inline-flex items-center gap-1 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 rounded text-sm text-white">
                  <Pause size={14} /> Pause
                </button>
              )}
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
                <div className="text-xs text-slate-400 flex items-center gap-2">
                  <span>elapsed {fmtMmSs(elapsedMs)} / target {active.targetDurationMinutes}m</span>
                  {isPaused && <span className="text-amber-300">⏸ paused</span>}
                </div>
              )}
              <div className="flex-1" />
              {!active ? (
                <button onClick={startTimer} disabled={pickedProjects.length === 0}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white disabled:opacity-50">Start</button>
              ) : (
                <>
                  <button onClick={keepGoing} disabled={isPaused} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm disabled:opacity-40">Keep going (+{settings.defaultPomodoroDuration}m)</button>
                  {isPaused ? (
                    <button onClick={resumeTimer} className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-sm text-white">
                      <Play size={14} /> Resume
                    </button>
                  ) : (
                    <button onClick={pauseTimer} className="inline-flex items-center gap-1 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 rounded text-sm text-white">
                      <Pause size={14} /> Pause
                    </button>
                  )}
                  <button onClick={stopTimer} className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-sm text-white">Stop</button>
                  <button onClick={discardActive} title="Discard without saving" className="px-2 py-1.5 text-xs text-slate-500 hover:text-white">discard</button>
                </>
              )}
            </div>

            {/* Project picker */}
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500">Projects:</span>
              {!active && (
                <label className="flex items-center gap-1 text-xs text-slate-400 ml-2">
                  <input
                    type="checkbox"
                    checked={showCompletedInPicker}
                    onChange={e => setShowCompletedInPicker(e.target.checked)}
                  />
                  Show completed
                </label>
              )}
              {!active && hiddenInPickerCount > 0 && (
                <label className="flex items-center gap-1 text-xs text-slate-400">
                  <input
                    type="checkbox"
                    checked={showHiddenInPicker}
                    onChange={e => setShowHiddenInPicker(e.target.checked)}
                  />
                  Show hidden
                </label>
              )}
              {!active ? (
                eligibleProjects.length === 0
                  ? <span className="text-xs text-slate-500">No projects.</span>
                  : eligibleProjects.map(p => {
                    const isCompleted = !!p.completed_at;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={isCompleted ? undefined : () => toggleProject(p.id)}
                        disabled={isCompleted}
                        title={isCompleted ? "Project is completed — reopen it from the Projects tab to log time" : undefined}
                        className={`px-2 py-0.5 rounded text-xs border ${
                          isCompleted ? "border-transparent opacity-40 cursor-not-allowed" :
                          pickedProjects.includes(p.id) ? "border-white" : "border-transparent opacity-70 hover:opacity-100"
                        }`}
                        style={{ backgroundColor: p.color, color: "#fff" }}
                      >{p.name}</button>
                    );
                  })
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
                      <FreeBlock key={pid} color={proj?.color}
                        labels={freeTaskLabels} onChange={setFreeTaskLabels}
                        suggestions={freeLabelSuggestions}
                        tasks={tasksForP}
                        pickedTaskIds={pickedTasks}
                        onToggleTask={toggleTask}
                        onSelectTask={selectTask}
                        onEnsureTask={ensureFreeTask} />
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

            {/* Active free-label slots — editable while timer runs (synced to live state at stop time). */}
            {active && active.topicIds.includes(FREE_PROJECT_ID) && (
              <div className="mt-2">
                <FreeBlock
                  labels={freeTaskLabels}
                  onChange={setFreeTaskLabels}
                  color={projectById.get(FREE_PROJECT_ID)?.color ?? "#64748b"}
                  suggestions={freeLabelSuggestions}
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
                const min = pomodoroMinutes(p);
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
          freeLabelSuggestions={freeLabelSuggestions}
          onEnsureFreeTask={ensureFreeTask}
        />
      )}

      {postFlow?.stage === "notes" && (
        <NotesAndNextModal
          pomodoro={postFlow.pomodoro}
          restMinutes={settings.restMinutes}
          onCancel={() => {
            setPickedProjects(postFlow.pomodoro.project_ids);
            setPickedTasks(postFlow.pomodoro.task_ids);
            setFreeTaskLabels(postFlow.pomodoro.freeTaskLabels ?? []);
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
              freeTaskLabels: postFlow.pomodoro.freeTaskLabels ?? [],
            };
            const restMin = Number.isFinite(settings.restMinutes) && settings.restMinutes > 0 ? settings.restMinutes : 5;
            const restEndsAt = Date.now() + restMin * 60_000;
            saveRest({ restEndsAt, proposal, pausedAt: null });
            setPostFlow({ stage: "rest", proposal, restEndsAt, pausedAt: null });
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
            }, postFlow.pomodoro.freeTaskLabels ?? []);
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
            await startTimerFromProposal(proposal, proposal.freeTaskLabels ?? []);
          }}
          onCancel={() => {
            setPickedProjects(postFlow.proposal.projectIds);
            setPickedTasks(postFlow.proposal.taskIds);
            setFreeTaskLabels(postFlow.proposal.freeTaskLabels ?? []);
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
 * Free project's freeTaskLabels render as one white pill per slot. Project with
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
        const isFree = pid === FREE_PROJECT_ID;
        const freeLabels = isFree ? (pomodoro.freeTaskLabels ?? []) : [];
        const hasAny = tasks.length > 0 || freeLabels.length > 0;
        return (
          <div key={pid} className="flex flex-wrap items-center gap-1">
            <ProjectChip project={proj} label={proj?.name ?? "[deleted]"} />
            {hasAny && <span className="text-slate-500 mx-0.5" aria-hidden>→</span>}
            {tasks.map(tid => (
              <ProjectChip key={tid} color="#ffffff" label={taskById.get(tid)?.name ?? "[deleted]"} />
            ))}
            {freeLabels.map((label, i) => (
              <ProjectChip key={`label:${i}`} color="#ffffff" label={label}
                className={ONE_OFF_CHIP_ON_WHITE} title={`one-off label · ${label}`} />
            ))}
            {!hasAny && (
              <span className="text-xs text-slate-500 italic">
                {isFree ? "(no task or label)" : "(project-level)"}
              </span>
            )}
          </div>
        );
      })}
    </div>
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

function ManualPomodoroModal({ onClose, onSaved, projects, freeLabelSuggestions, onEnsureFreeTask }: {
  onClose: () => void; onSaved: () => void; projects: Project[]; freeLabelSuggestions: string[];
  onEnsureFreeTask: (name: string) => Promise<string | null>;
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
  const [freeLabels, setFreeLabels] = useState<string[]>([]);
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
  // Idempotent, for a task we just created — see PomodoroPage.selectTask.
  function selectTask(id: string) {
    setTaskIds(prev => prev.includes(id) ? prev : [...prev, id]);
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
      freeTaskLabels: projectIds.includes(FREE_PROJECT_ID) ? cleanFreeLabels(freeLabels) : [],
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
                    <FreeBlock key={pid} color={proj?.color}
                      labels={freeLabels} onChange={setFreeLabels}
                      placeholder="What were you working on?"
                      suggestions={freeLabelSuggestions}
                      tasks={(tasksByProject.get(FREE_PROJECT_ID) ?? []).filter(t => !t.completed_at)}
                      pickedTaskIds={taskIds}
                      onToggleTask={toggleTask}
                      onSelectTask={selectTask}
                      onEnsureTask={onEnsureFreeTask} />
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
