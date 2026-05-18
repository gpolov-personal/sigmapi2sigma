import type { Pomodoro } from "../api";

/**
 * Attributable duration of a pomodoro in minutes.
 *
 * Wall-clock elapsed (ended_at - started_at) minus paused_ms.
 * Legacy records without paused_ms are treated as 0 (no pauses).
 */
export function pomodoroMinutes(p: Pomodoro): number {
  const elapsed = Date.parse(p.ended_at) - Date.parse(p.started_at);
  const paused  = (p as any).paused_ms ?? 0;
  return Math.max(0, (elapsed - paused) / 60000);
}
