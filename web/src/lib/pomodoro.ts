import { FREE_PROJECT_ID } from "../api";
import type { Pomodoro, Task } from "../api";

/**
 * Attributable duration of a pomodoro in minutes.
 *
 * Wall-clock elapsed (ended_at - started_at) minus paused_ms.
 * Legacy records without paused_ms are treated as 0 (no pauses).
 */
export function pomodoroMinutes(p: Pomodoro): number {
  const elapsed = Date.parse(p.ended_at) - Date.parse(p.started_at);
  const paused  = p.paused_ms ?? 0;
  return Math.max(0, (elapsed - paused) / 60000);
}

/**
 * How a pomodoro's minutes are attributed to projects and tasks.
 *
 * The duration is split evenly across "units". A unit is:
 *   - each picked task, plus
 *   - each picked project that has no task picked under it.
 *
 * The Free project is the exception: it carries real tasks *and* one-off labels, so it
 * contributes one unit per picked Free task plus one per non-empty label, falling back to
 * a single project-level unit when it has neither. Labels have no stable id, so they
 * never appear in `byTask`.
 *
 * This is the single source of truth. It used to be copy-pasted into four call sites,
 * which is exactly how two of them ended up with no Free rule at all and silently
 * mis-weighted every multi-project pomodoro. Import it; do not re-implement it.
 */
export function attributePomodoro(
  p: Pomodoro,
  taskById: Map<string, Task>,
): { byProject: Map<string, number>; byTask: Map<string, number> } {
  const dur = pomodoroMinutes(p);

  // Group the picked tasks under their project, dropping any that no longer resolve or
  // whose project is not part of this pomodoro.
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
    if (pid === FREE_PROJECT_ID) {
      const labels = p.freeTaskLabels ?? [];
      for (const t of tasks) units.push({ project: pid, task: t });
      for (let i = 0; i < labels.length; i++) units.push({ project: pid, task: null });
      if (tasks.length === 0 && labels.length === 0) units.push({ project: pid, task: null });
    } else if (tasks.length === 0) {
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
