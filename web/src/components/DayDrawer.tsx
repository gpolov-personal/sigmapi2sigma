import { useState, ReactElement } from "react";
import { X } from "lucide-react";
import { Pomodoro } from "../api";
import { useSettings } from "../SettingsContext";
import { useProjects } from "../ProjectsContext";
import { ProjectChip } from "./ProjectChip";
import { PomodoroDetailDrawer } from "./PomodoroDetailDrawer";
import { formatDuration } from "../utils";

interface Props {
  date: Date;                 // any moment in the target day; we use local-day boundaries
  pomodoros: Pomodoro[];      // pre-filtered to this day OR full list (we filter again)
  onClose: () => void;
}

function isSameLocalDay(ts: number, d: Date): boolean {
  const a = new Date(ts);
  return a.getFullYear() === d.getFullYear() && a.getMonth() === d.getMonth() && a.getDate() === d.getDate();
}

function pomDurMin(p: Pomodoro): number {
  return Math.max(0, (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000);
}

export function DayDrawer({ date, pomodoros, onClose }: Props) {
  const { settings } = useSettings();
  const { projectById, taskById } = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const dayPoms = pomodoros
    .filter(p => isSameLocalDay(Date.parse(p.started_at), date))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));

  const totalMin = dayPoms.reduce((s, p) => s + pomDurMin(p), 0);

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-xl bg-slate-900 border-l border-slate-700 p-6 overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-lg font-semibold">
              {date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            </div>
            <div className="text-sm text-slate-400">
              {dayPoms.length} pomodoro{dayPoms.length === 1 ? "" : "s"} · {formatDuration(totalMin, settings.workdayHours)}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        {dayPoms.length === 0 ? (
          <div className="text-sm text-slate-500">No pomodoros on this day.</div>
        ) : (
          <div className="space-y-2">
            {dayPoms.map(p => {
              const min = pomDurMin(p);
              const start = new Date(p.started_at);
              const end = new Date(p.ended_at);
              const fmt = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className="w-full text-left border border-slate-800 rounded p-3 bg-slate-950/40 hover:bg-slate-900/60"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-mono">{fmt(start)} – {fmt(end)}</div>
                    <div className="text-xs text-slate-400">{formatDuration(min, settings.workdayHours)}</div>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {(() => {
                      const tasksByProj = new Map<string, string[]>();
                      for (const tid of p.task_ids) {
                        const t = taskById.get(tid);
                        if (!t) continue;
                        const arr = tasksByProj.get(t.project_id);
                        if (arr) arr.push(tid); else tasksByProj.set(t.project_id, [tid]);
                      }
                      const out: ReactElement[] = [];
                      for (const pid of p.project_ids) {
                        const proj = projectById.get(pid);
                        const tasks = tasksByProj.get(pid) ?? [];
                        if (tasks.length === 0) {
                          out.push(<ProjectChip key={pid} project={proj} label={proj ? undefined : "[deleted]"} />);
                        } else {
                          for (const tid of tasks) {
                            const t = taskById.get(tid);
                            out.push(<ProjectChip key={`${pid}:${tid}`} project={proj} task={t ?? null} label={proj ? undefined : "[deleted]"} />);
                          }
                        }
                      }
                      return out;
                    })()}
                  </div>
                  {p.notes && (
                    <div className="text-xs text-slate-400 mt-1 truncate">{p.notes.split("\n")[0]}</div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {selectedId && (
          <PomodoroDetailDrawer pomodoroId={selectedId} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </div>
  );
}
