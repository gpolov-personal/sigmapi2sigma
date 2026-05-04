import { useEffect, useMemo, useState } from "react";
import { Pomodoro, apiRequest } from "../api";
import { useProjects } from "../ProjectsContext";
import { HeatmapCalendar } from "../components/HeatmapCalendar";
import { MonthGrid } from "../components/MonthGrid";
import { DayDrawer } from "../components/DayDrawer";

type SubTab = "year" | "month";

export function Calendar() {
  const { projects } = useProjects();
  const [tab, setTab] = useState<SubTab>("year");
  const [pomodoros, setPomodoros] = useState<Pomodoro[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [monthStart, setMonthStart] = useState<Date>(() => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d;
  });

  useEffect(() => {
    apiRequest<{ pomodoros: Pomodoro[] }>("GET", "/api/pomodoros").then(r => {
      if (r.ok) setPomodoros((r.body as { pomodoros: Pomodoro[] }).pomodoros);
      setLoading(false);
    });
  }, []);

  const visibleProjects = useMemo(() => {
    const ref = new Set<string>();
    for (const p of pomodoros) for (const pid of p.project_ids) ref.add(pid);
    return [
      ...projects.filter(p => ref.has(p.id)),
      ...projects.filter(p => !ref.has(p.id)),
    ];
  }, [projects, pomodoros]);

  function toggleProject(id: string) {
    setSelectedProjectIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={() => setTab("year")}
          className={`px-3 py-1.5 rounded text-sm ${tab === "year" ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-slate-800"}`}
        >Year</button>
        <button onClick={() => setTab("month")}
          className={`px-3 py-1.5 rounded text-sm ${tab === "month" ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-slate-800"}`}
        >Month</button>
      </div>

      {visibleProjects.length > 0 && (
        <div className="flex flex-wrap gap-1 items-center">
          <button onClick={() => setSelectedProjectIds(new Set())}
            className={`px-2 py-0.5 rounded text-xs border ${selectedProjectIds.size === 0 ? "border-white bg-slate-700" : "border-slate-700 hover:bg-slate-800"}`}
          >All</button>
          {visibleProjects.map(p => {
            const active = selectedProjectIds.has(p.id);
            return (
              <button key={p.id} onClick={() => toggleProject(p.id)}
                className={`px-2 py-0.5 rounded text-xs border ${active ? "border-white" : "border-transparent opacity-60 hover:opacity-100"}`}
                style={{ backgroundColor: p.color, color: "#fff" }}
              >{p.name}</button>
            );
          })}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : tab === "year" ? (
        <HeatmapCalendar
          pomodoros={pomodoros}
          selectedProjectIds={selectedProjectIds}
          onSelectDay={setSelectedDay}
        />
      ) : (
        <MonthGrid
          pomodoros={pomodoros}
          monthStart={monthStart}
          onMonthChange={setMonthStart}
          selectedProjectIds={selectedProjectIds}
          onSelectDay={setSelectedDay}
        />
      )}

      {selectedDay && (
        <DayDrawer
          date={selectedDay}
          pomodoros={pomodoros}
          onClose={() => setSelectedDay(null)}
        />
      )}
    </div>
  );
}
