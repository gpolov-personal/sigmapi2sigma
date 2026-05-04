import { useEffect, useState, ReactElement } from "react";
import { X } from "lucide-react";
import { ActivitySlice, Pomodoro, apiRequest } from "../api";
import { useSettings } from "../SettingsContext";
import { useProjects } from "../ProjectsContext";
import { ProjectChip } from "./ProjectChip";
import { formatDuration } from "../utils";

interface Props { pomodoroId: string; onClose: () => void; }

function durMin(p: Pomodoro): number {
  return Math.max(0, (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000);
}

export function PomodoroDetailDrawer({ pomodoroId, onClose }: Props) {
  const { projectById, taskById } = useProjects();
  const { settings } = useSettings();
  const [pomodoro, setPomodoro] = useState<Pomodoro | null>(null);
  const [slice, setSlice] = useState<ActivitySlice | null>(null);
  const [tab, setTab] = useState<"conversations" | "commands">("conversations");
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pr = await apiRequest<Pomodoro>("GET", `/api/pomodoros/${pomodoroId}`);
      if (cancelled) return;
      if (!pr.ok) { setError((pr.body as { error: string }).error); return; }
      setPomodoro(pr.body as Pomodoro);
      setNotes((pr.body as Pomodoro).notes);
      const ar = await apiRequest<ActivitySlice>("GET", `/api/pomodoros/${pomodoroId}/activity`);
      if (cancelled) return;
      if (ar.ok) setSlice(ar.body as ActivitySlice);
    })();
    return () => { cancelled = true; };
  }, [pomodoroId]);

  async function saveNotes() {
    if (!pomodoro) return;
    setSavingNotes(true);
    try {
      const r = await apiRequest<Pomodoro>("PATCH", `/api/pomodoros/${pomodoroId}`, { notes });
      if (r.ok) setPomodoro(r.body as Pomodoro);
    } finally { setSavingNotes(false); }
  }

  if (error) {
    return (
      <div className="fixed inset-0 z-50 flex">
        <div className="flex-1 bg-black/40" onClick={onClose} />
        <div className="w-full max-w-xl bg-slate-900 border-l border-slate-700 p-6">
          <div className="flex justify-between mb-2"><h2 className="text-lg">Error</h2><button onClick={onClose}><X size={18} /></button></div>
          <div className="text-sm text-red-400">{error}</div>
        </div>
      </div>
    );
  }

  if (!pomodoro) {
    return (
      <div className="fixed inset-0 z-50 flex">
        <div className="flex-1 bg-black/40" onClick={onClose} />
        <div className="w-full max-w-xl bg-slate-900 border-l border-slate-700 p-6 text-slate-400 text-sm">Loading…</div>
      </div>
    );
  }

  const minutes = durMin(pomodoro);
  const start = new Date(pomodoro.started_at);
  const end = new Date(pomodoro.ended_at);
  const fmt = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-2xl bg-slate-900 border-l border-slate-700 p-6 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-sm text-slate-400">{start.toLocaleDateString()}</div>
            <div className="text-lg font-semibold">
              {fmt(start)} → {fmt(end)} · {formatDuration(minutes, settings.workdayHours)}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="flex flex-wrap gap-1 mb-4">
          {(() => {
            // Build the same chip list as the recent table.
            const tasksByProj = new Map<string, string[]>();
            for (const tid of pomodoro.task_ids) {
              const t = taskById.get(tid);
              if (!t) continue;
              const arr = tasksByProj.get(t.project_id);
              if (arr) arr.push(tid); else tasksByProj.set(t.project_id, [tid]);
            }
            const out: ReactElement[] = [];
            for (const pid of pomodoro.project_ids) {
              const proj = projectById.get(pid);
              const tasks = tasksByProj.get(pid) ?? [];
              if (tasks.length === 0) {
                out.push(<ProjectChip key={pid} project={proj} label={proj ? undefined : `[deleted]`} />);
              } else {
                for (const tid of tasks) {
                  const t = taskById.get(tid);
                  out.push(<ProjectChip key={`${pid}:${tid}`} project={proj} task={t ?? null} label={proj ? undefined : `[deleted]`} />);
                }
              }
            }
            return out;
          })()}
        </div>

        <label className="block mb-4">
          <span className="text-sm text-slate-300">Notes</span>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            onBlur={saveNotes}
            rows={3}
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
          />
          {savingNotes && <span className="text-xs text-slate-500">saving…</span>}
        </label>

        <div className="border-b border-slate-800 mb-3 flex gap-1">
          <button
            onClick={() => setTab("conversations")}
            className={`px-3 py-1.5 text-sm ${tab === "conversations" ? "border-b-2 border-blue-500 text-white" : "text-slate-400"}`}
          >Conversations ({slice?.conversations.length ?? "…"})</button>
          <button
            onClick={() => setTab("commands")}
            className={`px-3 py-1.5 text-sm ${tab === "commands" ? "border-b-2 border-blue-500 text-white" : "text-slate-400"}`}
          >Commands ({slice?.commands.length ?? "…"})</button>
        </div>

        {!slice && <div className="text-sm text-slate-500">Loading activity…</div>}

        {slice && tab === "conversations" && (
          <div className="space-y-3">
            {slice.conversations.length === 0 && (
              <div className="text-sm text-slate-500">
                No claude sessions captured. This pomodoro had no tmux assignment at the time, or tmux wasn't running.
              </div>
            )}
            {slice.conversations.map(c => {
              const isExpanded = expanded.has(c.sessionId);
              return (
                <div key={c.sessionId} className="border border-slate-800 rounded p-3 bg-slate-950/40">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-xs text-slate-400">{c.sessionId.slice(0, 12)}…</div>
                    <div className="text-xs text-slate-500">
                      {c.userPromptCount} user prompt{c.userPromptCount === 1 ? "" : "s"} · {c.totalMessageCount} events · {formatDuration(c.durationMinutes, settings.workdayHours)}
                    </div>
                  </div>
                  {c.cwd && <div className="font-mono text-xs text-slate-500 mt-1 break-all">{c.cwd}</div>}
                  {c.firstUserPrompt && (
                    <div className="mt-2 text-sm">
                      <div className="text-xs text-slate-500">first</div>
                      <div className="text-slate-300 italic">"{c.firstUserPrompt.slice(0, 200)}"</div>
                    </div>
                  )}
                  {c.lastUserPrompt && c.lastUserPrompt !== c.firstUserPrompt && (
                    <div className="mt-1 text-sm">
                      <div className="text-xs text-slate-500">last</div>
                      <div className="text-slate-300 italic">"{c.lastUserPrompt.slice(0, 200)}"</div>
                    </div>
                  )}
                  {c.allUserPrompts.length > 0 && (
                    <button
                      onClick={() => setExpanded(prev => {
                        const next = new Set(prev);
                        if (next.has(c.sessionId)) next.delete(c.sessionId); else next.add(c.sessionId);
                        return next;
                      })}
                      className="mt-2 text-xs text-blue-400 hover:text-blue-300"
                    >{isExpanded ? "Collapse" : `Expand all ${c.allUserPrompts.length}${c.truncated ? "+" : ""}`}</button>
                  )}
                  {isExpanded && (
                    <div className="mt-2 space-y-2">
                      {c.allUserPrompts.map((p, i) => (
                        <div key={i} className="border-l-2 border-slate-700 pl-2">
                          <div className="text-xs text-slate-500">{new Date(p.ts).toLocaleTimeString()}</div>
                          <div className="text-xs text-slate-300 whitespace-pre-wrap">{p.preview}</div>
                        </div>
                      ))}
                      {c.truncated && (
                        <div className="text-xs text-slate-500">… truncated at 100 prompts</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {slice && tab === "commands" && (
          <div className="space-y-2">
            {slice.commands.length === 0 ? (
              <div className="text-sm text-slate-500">
                No commands captured.
                {slice.warnings.find(w => w.includes("shell-hook")) &&
                  <> Install hook (<code>npm run install-shell-hook</code>) to enable.</>}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-slate-500 text-left">
                  <tr>
                    <th className="pr-2 py-1">time</th>
                    <th className="pr-2 py-1">tmux</th>
                    <th className="pr-2 py-1">cwd</th>
                    <th className="py-1">cmd</th>
                  </tr>
                </thead>
                <tbody>
                  {slice.commands.map((c, i) => (
                    <tr key={i} className="border-t border-slate-800 align-top">
                      <td className="pr-2 py-1 text-slate-400 whitespace-nowrap">{new Date(c.ts).toLocaleTimeString()}</td>
                      <td className="pr-2 py-1 font-mono text-slate-400">{c.tmuxSession}</td>
                      <td className="pr-2 py-1 font-mono text-slate-500">{c.cwd}</td>
                      <td className="py-1 font-mono text-slate-200 break-all">{c.cmd}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {slice && slice.warnings.length > 0 && (
          <div className="mt-4 text-xs text-amber-400/80 space-y-0.5">
            {slice.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}
