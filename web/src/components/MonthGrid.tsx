import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Pomodoro } from "../api";
import { useSettings } from "../SettingsContext";
import { useProjects } from "../ProjectsContext";
import { Task } from "../api";
import { formatDuration } from "../utils";

interface Props {
  pomodoros: Pomodoro[];
  monthStart: Date;
  onMonthChange: (d: Date) => void;
  selectedProjectIds: Set<string>;
  onSelectDay: (date: Date) => void;
}

function attributeProjectMins(p: Pomodoro, taskById: Map<string, Task>): Map<string, number> {
  const dur = Math.max(0, (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000);
  const tasksByProj = new Map<string, string[]>();
  for (const tid of p.task_ids) {
    const t = taskById.get(tid);
    if (!t || !p.project_ids.includes(t.project_id)) continue;
    const arr = tasksByProj.get(t.project_id);
    if (arr) arr.push(tid); else tasksByProj.set(t.project_id, [tid]);
  }
  let unitCount = 0;
  for (const pid of p.project_ids) {
    unitCount += (tasksByProj.get(pid)?.length ?? 0) || 1;
  }
  const per = unitCount > 0 ? dur / unitCount : 0;
  const byProject = new Map<string, number>();
  for (const pid of p.project_ids) {
    const n = (tasksByProj.get(pid)?.length ?? 0) || 1;
    byProject.set(pid, (byProject.get(pid) ?? 0) + per * n);
  }
  return byProject;
}

const HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfLocalDay(d: Date): Date {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}
// Mon=0..Sun=6.
function dow(d: Date): number {
  return (d.getDay() + 6) % 7;
}
export function MonthGrid({ pomodoros, monthStart, onMonthChange, selectedProjectIds, onSelectDay }: Props) {
  const { settings } = useSettings();
  const { projectById, taskById } = useProjects();

  // Build cells: leading blanks until isoDow of day 1, then days of month, then trailing blanks to fill rows.
  const cells = useMemo(() => {
    const year = monthStart.getFullYear();
    const month = monthStart.getMonth();
    const first = new Date(year, month, 1);
    const lead = dow(first);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const arr: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) arr.push(null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(new Date(year, month, d));
    while (arr.length % 7 !== 0) arr.push(null);
    return arr;
  }, [monthStart]);

  // Aggregate per day.
  const byDay = useMemo(() => {
    const m = new Map<string, { totalMin: number; perProject: Map<string, number> }>();
    for (const p of pomodoros) {
      const ts = startOfLocalDay(new Date(p.started_at));
      const key = ts.toDateString();
      const byProj = attributeProjectMins(p, taskById);
      let cur = m.get(key);
      if (!cur) { cur = { totalMin: 0, perProject: new Map() }; m.set(key, cur); }
      for (const [pid, mins] of byProj.entries()) {
        if (selectedProjectIds.size > 0 && !selectedProjectIds.has(pid)) continue;
        cur.perProject.set(pid, (cur.perProject.get(pid) ?? 0) + mins);
        cur.totalMin += mins;
      }
    }
    return m;
  }, [pomodoros, selectedProjectIds, taskById]);

  // Cap bar to 1 workday for normalization (so a normal day reaches near 100%).
  const capMinutes = settings.workdayHours * 60;

  function prevMonth() {
    const d = new Date(monthStart); d.setMonth(d.getMonth() - 1);
    onMonthChange(d);
  }
  function nextMonth() {
    const d = new Date(monthStart); d.setMonth(d.getMonth() + 1);
    onMonthChange(d);
  }
  function goToday() {
    const t = new Date(); t.setDate(1); t.setHours(0, 0, 0, 0);
    onMonthChange(t);
  }

  const monthLabel = monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={prevMonth} className="px-2 py-1 hover:bg-slate-800 rounded"><ChevronLeft size={16} /></button>
        <div className="text-sm font-semibold w-40 text-center">{monthLabel}</div>
        <button onClick={nextMonth} className="px-2 py-1 hover:bg-slate-800 rounded"><ChevronRight size={16} /></button>
        <button onClick={goToday} className="ml-2 px-2 py-1 text-xs bg-slate-800 border border-slate-700 rounded hover:bg-slate-700">Today</button>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {HEADERS.map(h => (
          <div key={h} className="text-[10px] text-slate-500 text-center pb-1">{h}</div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={i} className="h-20" />;
          const data = byDay.get(d.toDateString());
          const total = data?.totalMin ?? 0;
          const ratio = Math.min(1, total / capMinutes);
          const isToday = d.toDateString() === new Date().toDateString();
          return (
            <button
              key={i}
              onClick={() => onSelectDay(d)}
              className={`relative h-20 border rounded flex flex-col items-stretch p-1.5 text-left bg-slate-950/40 hover:bg-slate-900/60 ${
                isToday ? "border-blue-500" : "border-slate-800"
              }`}
              title={total > 0 ? `${formatDuration(total, settings.workdayHours)} on ${d.toLocaleDateString()}` : ""}
            >
              <div className="text-xs text-slate-300">{d.getDate()}</div>
              <div className="flex-1" />
              {data && data.perProject.size > 0 && (
                <div className="h-1.5 w-full rounded overflow-hidden flex bg-slate-800">
                  {[...data.perProject.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([pid, mins]) => {
                      const p = projectById.get(pid);
                      const widthPct = (mins / capMinutes) * 100;
                      return (
                        <div
                          key={pid}
                          style={{ backgroundColor: p?.color ?? "#475569", width: `${widthPct}%` }}
                          title={`${p?.name ?? "[deleted]"}: ${formatDuration(mins, settings.workdayHours)}`}
                        />
                      );
                    })}
                </div>
              )}
              {total > 0 && (
                <div className="text-[9px] text-slate-500 mt-0.5">{formatDuration(total, settings.workdayHours)}</div>
              )}
            </button>
          );
        })}
      </div>

      <div className="text-[10px] text-slate-500">Bars are scaled vs. a {settings.workdayHours}-hour workday cap.</div>
    </div>
  );
}
