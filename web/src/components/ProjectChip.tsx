import { Project, Task } from "../api";
import { projectAbbreviation } from "../utils";

interface Props {
  project?: Project | null;
  task?: Task | null;
  label?: string;
  color?: string;
  onClick?: () => void;
  title?: string;
  className?: string;
  maxLen?: number;
}

function readableTextColor(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const l = (r * 299 + g * 587 + b * 114) / 1000;
  return l > 140 ? "#0f172a" : "#fff";
}

function trunc(s: string, max = 28): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function ProjectChip({ project, task, label, color, onClick, title, className, maxLen = 28 }: Props) {
  const bg = project?.color ?? color ?? "#475569";
  const text = readableTextColor(bg);
  const display: string | { prefix: string; task: string } = label ?? (task && project
    ? { prefix: projectAbbreviation(project), task: trunc(task.name, maxLen) }
    : trunc(project?.name ?? task?.name ?? "Free", maxLen));
  const tooltip = title ?? (task && project
    ? `${project.name} › ${task.name}`
    : project?.name ?? (typeof display === "string" ? display : ""));
  const interactive = !!onClick;
  return (
    <span
      onClick={onClick}
      title={tooltip}
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${interactive ? "cursor-pointer hover:opacity-80" : ""} ${className ?? ""}`}
      style={{ backgroundColor: bg, color: text }}
    >
      {typeof display === "string" ? display : (
        <>
          <span className="opacity-80 mr-1">{display.prefix}</span>
          <span className="opacity-60 mr-1">›</span>
          <span>{display.task}</span>
        </>
      )}
    </span>
  );
}

export { ProjectChip as TaskChip };
