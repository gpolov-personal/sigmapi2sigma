import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useProjects } from "../ProjectsContext";
import { ProjectChip } from "./ProjectChip";

interface Props {
  tmuxSessionName: string;
  className?: string;
}

export function ProjectAssignmentMenu({ tmuxSessionName, className }: Props) {
  const { projects, assignmentsByTmux, projectById, setAssignment } = useProjects();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const currentProjectId = assignmentsByTmux.get(tmuxSessionName) ?? null;
  const currentProject = currentProjectId ? projectById.get(currentProjectId) ?? null : null;

  const assignedProjectIds = useMemo(() => new Set(assignmentsByTmux.values()), [assignmentsByTmux]);

  const eligible = projects.filter(p => {
    if (p.completed_at) return false;
    if (p.id === currentProjectId) return false;
    if (assignedProjectIds.has(p.id)) return false;
    return true;
  });

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function handlePick(projectId: string | null) {
    setError(null);
    try {
      await setAssignment(tmuxSessionName, projectId);
      setOpen(false);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  return (
    <div ref={ref} className={`relative inline-block ${className ?? ""}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1"
        title="Click to change project"
      >
        <ProjectChip project={currentProject} />
        <ChevronDown size={12} className="text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-40 mt-1 min-w-[14rem] max-h-72 overflow-auto bg-slate-800 border border-slate-700 rounded shadow-lg">
          {currentProjectId && (
            <button
              onClick={() => handlePick(null)}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-700 text-slate-300"
            >
              ⨯ Unassign (Free)
            </button>
          )}
          {eligible.length === 0 && !currentProjectId && (
            <div className="px-3 py-2 text-xs text-slate-500">No available projects</div>
          )}
          {eligible.map(p => (
            <button
              key={p.id}
              onClick={() => handlePick(p.id)}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-700 flex items-center gap-2"
            >
              <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: p.color }} />
              <span className="text-slate-200">{p.name}</span>
            </button>
          ))}
          {error && <div className="px-3 py-1 text-xs text-red-400">{error}</div>}
        </div>
      )}
    </div>
  );
}
