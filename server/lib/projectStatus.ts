// Pure derivation of project status fields. Inputs are plain data — no I/O here.
//
// progress:      not_started | in_progress | completed
//                completed_at takes precedence; else pomodoro count decides.
//
// engagement:    active | parked
//                anchor = max(pomodoro.ended_at) across ALL projects, null if no pomodoros.
//                A project is active iff (progress != completed) AND it has any pomodoro
//                whose ended_at falls within [anchor - X*3600*1000, anchor], where
//                X = activeWindowHours. Completed projects are always parked.
//
// tmux_attached: boolean
//                True iff there is an assignment row tmuxName→this.id AND that
//                tmuxName appears in the supplied liveSessionNames set.

export type Progress = "not_started" | "in_progress" | "completed";
export type Engagement = "active" | "parked";

export interface DerivedStatus {
  progress: Progress;
  engagement: Engagement;
  tmux_attached: boolean;
  tmux_session_name: string | null;
  last_pomodoro_at: string | null;
}

export interface ProjectStatusAnchor {
  ts: string | null;
  activeWindowHours: number;
}

export interface DeriveInputs {
  projects: { id: string; completed_at: string | null }[];
  pomodoros: { project_ids: string[]; ended_at: string }[];
  assignments: Record<string, string>;
  liveSessionNames: Set<string>;
  activeWindowHours: number;
}

export interface DeriveOutput {
  anchor: ProjectStatusAnchor;
  byProjectId: Map<string, DerivedStatus>;
}

export function deriveProjectStatus(input: DeriveInputs): DeriveOutput {
  const { projects, pomodoros, assignments, liveSessionNames, activeWindowHours } = input;

  // Anchor = max(pomodoro.ended_at) across ALL projects.
  let anchorMs: number | null = null;
  let anchorIso: string | null = null;
  for (const p of pomodoros) {
    const ms = Date.parse(p.ended_at);
    if (!Number.isFinite(ms)) continue;
    if (anchorMs === null || ms > anchorMs) {
      anchorMs = ms;
      anchorIso = p.ended_at;
    }
  }

  const cutoffMs = anchorMs !== null
    ? anchorMs - activeWindowHours * 3600 * 1000
    : null;

  // Bucket pomodoros by project for engagement + last_pomodoro_at lookups.
  // Each pomodoro can list multiple project_ids; it counts for each of them.
  const lastEndedMsByProject = new Map<string, number>();
  const lastEndedIsoByProject = new Map<string, string>();
  const hasInWindowByProject = new Map<string, boolean>();

  for (const p of pomodoros) {
    const ms = Date.parse(p.ended_at);
    if (!Number.isFinite(ms)) continue;
    for (const pid of p.project_ids) {
      const prev = lastEndedMsByProject.get(pid);
      if (prev === undefined || ms > prev) {
        lastEndedMsByProject.set(pid, ms);
        lastEndedIsoByProject.set(pid, p.ended_at);
      }
      if (cutoffMs !== null && ms >= cutoffMs && ms <= (anchorMs as number)) {
        hasInWindowByProject.set(pid, true);
      }
    }
  }

  // Reverse assignments for the tmux_attached lookup.
  const tmuxNameByProject = new Map<string, string>();
  for (const [tname, pid] of Object.entries(assignments)) {
    if (liveSessionNames.has(tname)) tmuxNameByProject.set(pid, tname);
  }

  const byProjectId = new Map<string, DerivedStatus>();
  for (const proj of projects) {
    const completed = !!proj.completed_at;
    const hasPomodoro = lastEndedMsByProject.has(proj.id);
    const progress: Progress = completed
      ? "completed"
      : hasPomodoro ? "in_progress" : "not_started";

    const engagement: Engagement = (() => {
      if (completed) return "parked";
      if (anchorMs === null) return "parked";
      return hasInWindowByProject.get(proj.id) ? "active" : "parked";
    })();

    const tmuxName = tmuxNameByProject.get(proj.id) ?? null;

    byProjectId.set(proj.id, {
      progress,
      engagement,
      tmux_attached: tmuxName !== null,
      tmux_session_name: tmuxName,
      last_pomodoro_at: lastEndedIsoByProject.get(proj.id) ?? null,
    });
  }

  return {
    anchor: { ts: anchorIso, activeWindowHours },
    byProjectId,
  };
}
