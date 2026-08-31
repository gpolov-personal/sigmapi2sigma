import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Pomodoro } from "../api";
import { useSettings } from "../SettingsContext";
import { useProjects } from "../ProjectsContext";
import { Task } from "../api";
import { formatDuration } from "../utils";
import { attributePomodoro, pomodoroMinutes } from "../lib/pomodoro";

interface DayCell {
  date: Date;       // local midnight
  totalMin: number;
  byProject: Map<string, number>;
}

interface Props {
  pomodoros: Pomodoro[];
  selectedProjectIds: Set<string>;        // empty = "All"
  onSelectDay: (date: Date) => void;
}


// Mon-Sun layout (ISO style): Monday at the top row.
const DAYS_OF_WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfLocalDay(d: Date): Date {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}

// Mon=0..Sun=6.
function dow(d: Date): number {
  return (d.getDay() + 6) % 7;
}

// 5-step intensity scale: 0, ≤30m, ≤2h, ≤4h, >4h.
function intensity(min: number): 0 | 1 | 2 | 3 | 4 {
  if (min <= 0) return 0;
  if (min <= 30) return 1;
  if (min <= 120) return 2;
  if (min <= 240) return 3;
  return 4;
}

export function HeatmapCalendar({ pomodoros, selectedProjectIds, onSelectDay }: Props) {
  const { settings } = useSettings();
  const { projectById, taskById } = useProjects();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);

  // Build all days from Jan 1 to Dec 31 of the selected year.
  const days = useMemo<DayCell[]>(() => {
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    const out: DayCell[] = [];
    const cur = new Date(start);
    while (cur.getTime() <= end.getTime()) {
      out.push({ date: new Date(cur), totalMin: 0, byProject: new Map() });
      cur.setDate(cur.getDate() + 1);
    }
    const indexByKey = new Map<string, DayCell>();
    for (const c of out) indexByKey.set(c.date.toDateString(), c);
    for (const p of pomodoros) {
      const day = startOfLocalDay(new Date(p.started_at));
      const cell = indexByKey.get(day.toDateString());
      if (!cell) continue;
      const { byProject: byProj } = attributePomodoro(p, taskById);
      for (const [pid, mins] of byProj.entries()) {
        if (selectedProjectIds.size > 0 && !selectedProjectIds.has(pid)) continue;
        cell.byProject.set(pid, (cell.byProject.get(pid) ?? 0) + mins);
        cell.totalMin += mins;
      }
    }
    return out;
  }, [pomodoros, selectedProjectIds, year, taskById]);

  // Group days into weekly columns starting on Monday. Pad the first column
  // with leading nulls so Jan 1 lands at its weekday row in column 1.
  const weeks = useMemo(() => {
    if (days.length === 0) return [];
    const cols: (DayCell | null)[][] = [];
    let current: (DayCell | null)[] = new Array(7).fill(null);
    for (const c of days) {
      const wday = dow(c.date);
      current[wday] = c;
      if (wday === 6) {
        cols.push(current);
        current = new Array(7).fill(null);
      }
    }
    if (current.some(x => x !== null)) cols.push(current);
    return cols;
  }, [days]);

  // Determine the dominant single color: when exactly one project is selected, use its color; otherwise neutral cyan.
  const useProjectColor = selectedProjectIds.size === 1
    ? projectById.get([...selectedProjectIds][0])?.color
    : null;

  const palette = useProjectColor
    ? buildScale(useProjectColor)
    : ["#1e293b", "#0c4a6e", "#075985", "#0369a1", "#0284c7"]; // slate-800 → sky-600

  // Compute month labels: position label at the first column whose first non-null day is in that month.
  const monthLabels = useMemo(() => {
    const labels: { col: number; text: string }[] = [];
    let lastMonth = -1;
    weeks.forEach((col, i) => {
      const firstReal = col.find(d => d !== null) as DayCell | undefined;
      if (!firstReal) return;
      const m = firstReal.date.getMonth();
      if (m !== lastMonth) {
        labels.push({ col: i, text: MONTH_LABELS[m] });
        lastMonth = m;
      }
    });
    return labels;
  }, [weeks]);

  // Single CSS grid that holds: a label corner, a month-label row, a weekday-label column,
  // and the 53 × 7 cell body. Sharing the grid guarantees labels align with cells.
  const numCols = weeks.length;
  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: `auto repeat(${numCols}, minmax(0, 1fr))`,
    gridTemplateRows: `auto repeat(7, minmax(0, 1fr))`,
    columnGap: "3px",
    rowGap: "3px",
    width: "100%",
    // Force a comfortable square cell shape: each row height tracks viewport width / cols.
    // Aspect-ratio on the grid keeps the cells roughly square at any width.
    aspectRatio: `${numCols + 1.6} / 8`,
    maxWidth: "100%",
  };

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={() => setYear(y => y - 1)} className="px-2 py-1 hover:bg-slate-800 rounded">
          <ChevronLeft size={16} />
        </button>
        <div className="text-sm font-semibold w-16 text-center">{year}</div>
        <button onClick={() => setYear(y => y + 1)} className="px-2 py-1 hover:bg-slate-800 rounded">
          <ChevronRight size={16} />
        </button>
        {year !== currentYear && (
          <button
            onClick={() => setYear(currentYear)}
            className="ml-2 px-2 py-1 text-xs bg-slate-800 border border-slate-700 rounded hover:bg-slate-700"
          >This year</button>
        )}
      </div>
      <div style={gridStyle}>
        {/* corner */}
        <div style={{ gridColumn: 1, gridRow: 1 }} />
        {/* month labels */}
        {monthLabels.map(l => (
          <div
            key={`m-${l.col}`}
            className="text-[11px] text-slate-500 leading-none"
            style={{ gridColumn: l.col + 2, gridRow: 1 }}
          >
            {l.text}
          </div>
        ))}
        {/* weekday labels */}
        {DAYS_OF_WEEK.map((d, i) => (
          <div
            key={d}
            className="text-[10px] text-slate-500 leading-none flex items-center pr-1"
            style={{ gridColumn: 1, gridRow: i + 2 }}
          >
            {d}
          </div>
        ))}
        {/* cells */}
        {weeks.map((col, ci) =>
          col.map((cell, ri) => {
            const gridCol = ci + 2;
            const gridRow = ri + 2;
            if (!cell) return <div key={`e-${ci}-${ri}`} style={{ gridColumn: gridCol, gridRow }} />;
            const lvl = intensity(cell.totalMin);
            const bg = palette[lvl];
            const tooltip = buildTooltip(cell, settings.workdayHours, projectById);
            return (
              <button
                key={`c-${ci}-${ri}`}
                onClick={() => onSelectDay(cell.date)}
                title={tooltip}
                className="rounded-sm hover:ring-1 hover:ring-white/60 w-full h-full"
                style={{ gridColumn: gridCol, gridRow, backgroundColor: bg }}
              />
            );
          })
        )}
      </div>

      <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-500">
        <span>less</span>
        {palette.map((c, i) => <span key={i} className="w-4 h-4 rounded-sm" style={{ backgroundColor: c }} />)}
        <span>more</span>
        <span className="ml-3">scale: 0 · ≤30m · ≤2h · ≤4h · &gt;4h</span>
      </div>
    </div>
  );
}

function buildTooltip(cell: DayCell, workdayHours: number, projectById: Map<string, { name: string }>): string {
  const dateStr = cell.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (cell.totalMin === 0) return `${dateStr} — nothing`;
  const head = `${dateStr} — ${formatDuration(cell.totalMin, workdayHours)}`;
  const items: string[] = [];
  for (const [pid, mins] of [...cell.byProject.entries()].sort((a, b) => b[1] - a[1])) {
    const p = projectById.get(pid);
    items.push(`${p?.name ?? "[deleted]"}: ${formatDuration(mins, workdayHours)}`);
  }
  return items.length > 0 ? `${head}\n${items.join("\n")}` : head;
}

// Build a 5-step monochrome scale from a base hex color.
function buildScale(hex: string): string[] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return ["#1e293b", "#374151", "#4b5563", "#6b7280", "#9ca3af"];
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const steps = [0.10, 0.30, 0.55, 0.78, 1.00];
  return steps.map(alpha => {
    // Composite color over slate-900 (#0f172a) for dark theme.
    const bg = { r: 15, g: 23, b: 42 };
    const cr = Math.round(bg.r + (r - bg.r) * alpha);
    const cg = Math.round(bg.g + (g - bg.g) * alpha);
    const cb = Math.round(bg.b + (b - bg.b) * alpha);
    return `rgb(${cr},${cg},${cb})`;
  });
}
