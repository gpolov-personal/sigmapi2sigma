import { useEffect, useMemo, useState } from "react";
import type { TmuxResponse } from "../api";
import { getJSON, SessionMeta, postJSON, apiRequest } from "../api";
import { relativeTime, trunc, copy } from "../utils";
import { useProjects } from "../ProjectsContext";
import { ProjectChip } from "../components/ProjectChip";

const HOURS_OPTIONS = [1, 6, 24, 72, 168, 0];

export function Sessions() {
  const [hours, setHours] = useState<number>(24);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [tmux, setTmux] = useState<TmuxResponse | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<SessionMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const { assignmentsByTmux, projectById } = useProjects();

  async function refresh() {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([
        getJSON<{ sessions: SessionMeta[] }>(`/api/sessions?hours=${hours || 999999}`),
        getJSON<TmuxResponse>("/api/tmux"),
      ]);
      setSessions(s.sessions);
      setTmux(t);
    } finally { setLoading(false); }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [hours]);

  // Map claude session id → array of tmux locations (one JSONL can be running
  // in multiple panes simultaneously, e.g. two `claude --resume <id>` in different
  // tmux sessions in the same cwd).
  const liveById = useMemo(() => {
    const map = new Map<string, { tmuxSession: string; windowIndex: number; paneIndex: number; paneId: string }[]>();
    if (!tmux || tmux.source !== "live") return map;
    for (const s of tmux.tree) {
      for (const w of s.windows) {
        for (const p of w.panes) {
          if (!p.claudeSessionId) continue;
          const loc = { tmuxSession: s.name, windowIndex: w.index, paneIndex: p.index, paneId: p.paneId };
          const arr = map.get(p.claudeSessionId);
          if (arr) arr.push(loc); else map.set(p.claudeSessionId, [loc]);
        }
      }
    }
    return map;
  }, [tmux]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(s =>
      (s.cwd ?? "").toLowerCase().includes(q) ||
      (s.lastUserPrompt ?? "").toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q)
    );
  }, [sessions, filter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-400">Last:</label>
        <select
          value={hours}
          onChange={e => setHours(Number(e.target.value))}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
        >
          {HOURS_OPTIONS.map(h => (
            <option key={h} value={h}>{h === 0 ? "all time" : `${h}h`}</option>
          ))}
        </select>
        <input
          placeholder="filter by path / prompt / id"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-3 py-1 text-sm flex-1 min-w-64"
        />
        <button
          onClick={refresh}
          className="px-3 py-1 bg-slate-800 border border-slate-700 rounded text-sm hover:bg-slate-700"
        >
          {loading ? "..." : "Refresh"}
        </button>
        <span className="text-sm text-slate-500">{filtered.length} sessions</span>
      </div>

      <div className="border border-slate-800 rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2 w-2">Live</th>
              <th className="text-left px-3 py-2">LWD / CWD</th>
              <th className="text-left px-3 py-2">Branch</th>
              <th className="text-left px-3 py-2">Last interaction</th>
              <th className="text-left px-3 py-2">Last prompt</th>
              <th className="text-left px-3 py-2">Tmux</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(s => {
              const liveLocs = s.id ? liveById.get(s.id) : undefined;
              return (
                <tr
                  key={s.id}
                  onClick={() => setSelected(s)}
                  className="border-t border-slate-800 hover:bg-slate-900/60 cursor-pointer"
                >
                  <td className="px-3 py-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${liveLocs && liveLocs.length ? "bg-green-500" : "bg-slate-600"}`}
                          title={liveLocs && liveLocs.length > 1 ? `Running in ${liveLocs.length} panes simultaneously` : ""}/>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-300">
                    <CwdCell launchCwd={s.cwd} currentCwd={s.lastCwd} fallback={s.projectDir} />
                  </td>
                  <td className="px-3 py-2 text-slate-400">{s.gitBranch ?? ""}</td>
                  <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{relativeTime(s.mtime)}</td>
                  <td className="px-3 py-2 text-slate-300">{trunc(s.lastUserPrompt, 160)}</td>
                  <td className="px-3 py-2 text-xs font-mono text-slate-400 whitespace-nowrap">
                    {liveLocs && liveLocs.length > 0 ? (
                      <div className="space-y-0.5">
                        {liveLocs.map(loc => {
                          const projectId = assignmentsByTmux.get(loc.tmuxSession);
                          const project = projectId ? projectById.get(projectId) : null;
                          return (
                            <div key={loc.paneId} className="flex items-center gap-1.5">
                              <span>{loc.tmuxSession}:{loc.windowIndex}.{loc.paneIndex}</span>
                              {project && <ProjectChip project={project} />}
                            </div>
                          );
                        })}
                      </div>
                    ) : s.lastTmuxLocation ? (
                      (() => {
                        const loc = s.lastTmuxLocation;
                        const projectId = assignmentsByTmux.get(loc.tmuxSession);
                        const project = projectId ? projectById.get(projectId) : null;
                        return (
                          <div
                            className="flex items-center gap-1.5 text-slate-500"
                            title={`Last seen ${relativeTime(new Date(loc.ts).getTime())} (${new Date(loc.ts).toLocaleString()})`}
                          >
                            <span>{loc.tmuxSession}:{loc.windowIndex}.{loc.paneIndex}</span>
                            {project && <ProjectChip project={project} />}
                          </div>
                        );
                      })()
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No sessions.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <SessionDrawer
          session={selected}
          liveLocations={liveById.get(selected.id)}
          tmux={tmux}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function SessionDrawer({ session, liveLocations, tmux, onClose }: {
  session: SessionMeta;
  liveLocations?: { tmuxSession: string; windowIndex: number; paneIndex: number; paneId: string }[];
  tmux: TmuxResponse | null;
  onClose: () => void;
}) {
  // Default name: try to find the tmux session this claude conversation was last in.
  // Scan order: live tree → latest → prev → prev2 snapshot. First hit wins.
  const originalTmuxName = useMemo(() => {
    const scan = (sessions: TmuxResponse["tree"] | undefined) => {
      if (!sessions) return null;
      for (const s of sessions)
        for (const w of s.windows)
          for (const p of w.panes)
            if (p.claudeSessionId === session.id) return s.name;
      return null;
    };
    if (tmux?.source === "live") {
      const fromLive = scan(tmux.tree);
      if (fromLive) return fromLive;
    }
    for (const snap of tmux?.snapshots ?? []) {
      const hit = scan(snap.sessions);
      if (hit) return hit;
    }
    return null;
  }, [tmux, session.id]);

  // If no snapshot ever saw this session, fall back to the cwd basename
  // (e.g. "Greenfield_GitHub") rather than an opaque "csv-<id>".
  const cwdBasename = useMemo(() => {
    const c = session.cwd ?? "";
    const parts = c.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }, [session.cwd]);

  const [resuming, setResuming] = useState(false);
  const [resumeMsg, setResumeMsg] = useState<string | null>(null);
  const [tmuxName, setTmuxName] = useState<string>(
    originalTmuxName ?? cwdBasename ?? `csv-${session.id.slice(0, 8)}`
  );

  // Last 5 user prompts — fetched from /api/sessions/:id detail when drawer opens.
  const [recentPrompts, setRecentPrompts] = useState<{ ts: string | null; text: string }[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await apiRequest<{ meta: SessionMeta; detail: { totalMessages: number; head: any[]; tail: any[] } }>(
        "GET", `/api/sessions/${session.id}`
      );
      if (cancelled) return;
      if (!r.ok) { setRecentPrompts([]); return; }
      const detail = (r.body as { detail: { tail: any[] } }).detail;
      const userMsgs: { ts: string | null; text: string }[] = [];
      for (const m of detail.tail ?? []) {
        if (m?.type !== "user") continue;
        const c = m.message?.content;
        let text: string | null = null;
        if (typeof c === "string" && c.length > 0) text = c;
        else if (Array.isArray(c)) {
          const joined = c
            .filter((x: any) => x?.type === "text" && typeof x.text === "string")
            .map((x: any) => x.text)
            .join("\n").trim();
          if (joined.length > 0) text = joined;
        }
        if (text) userMsgs.push({ ts: typeof m.timestamp === "string" ? m.timestamp : null, text });
      }
      // Last 5 prompts (most recent last).
      setRecentPrompts(userMsgs.slice(-5));
    })();
    return () => { cancelled = true; };
  }, [session.id]);
  const resumeCmd = `claude --resume ${session.id}`;

  // Always launch at LWD: `claude --resume <uuid>` only finds the JSONL when run
  // from the same project dir the session was originally launched in.
  const resumeCwd = session.cwd;

  async function resumeInTmux() {
    setResuming(true);
    setResumeMsg(null);
    try {
      await postJSON("/api/resume", {
        sessionId: session.id,
        cwd: resumeCwd,
        tmuxSessionName: tmuxName,
        permissionMode: session.permissionMode ?? undefined,
      });
      const flag = session.permissionMode && session.permissionMode !== "default"
        ? ` (--permission-mode ${session.permissionMode})`
        : "";
      setResumeMsg(`Started in tmux session "${tmuxName}" at ${resumeCwd}${flag}.\nAttach with:  tmux attach -t ${tmuxName}`);
    } catch (e: any) {
      setResumeMsg(`Failed: ${e.message ?? e}`);
    } finally {
      setResuming(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex justify-end" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="w-[48rem] max-w-full bg-slate-900 border-l border-slate-800 overflow-auto p-6 space-y-4"
      >
        <div className="flex justify-between items-start">
          <div>
            <div className="text-xs text-slate-500 mb-1">Session ID</div>
            <div className="font-mono text-sm">{session.id}</div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">✕</button>
        </div>

        <Field label="Launch WD (LWD)">{session.cwd}</Field>
        <Field label="Current WD (CWD)">
          {session.lastCwd && session.lastCwd !== session.cwd
            ? <><span className="text-amber-400">{session.lastCwd}</span> <span className="text-xs text-slate-500">(informational — resume always launches at LWD)</span></>
            : session.cwd ?? "—"}
        </Field>
        <Field label="Git branch">{session.gitBranch ?? "—"}</Field>
        <Field label="Claude Code version">{session.version ?? "—"}</Field>
        <Field label="Permission mode">
          <span className={session.permissionMode === "bypassPermissions" ? "text-amber-300" : ""}>
            {session.permissionMode ?? "default"}
          </span>
          {session.permissionMode && session.permissionMode !== "default" && (
            <span className="text-xs text-slate-500 ml-2">(passed to --permission-mode on resume)</span>
          )}
        </Field>
        <Field label="JSONL path">{session.jsonlPath}</Field>
        {liveLocations && liveLocations.length > 0 && (
          <Field label={liveLocations.length > 1 ? `Live in ${liveLocations.length} tmux panes` : "Live in tmux"}>
            <div className="space-y-0.5">
              {liveLocations.map(loc => (
                <div key={loc.paneId}>{loc.tmuxSession}:{loc.windowIndex}.{loc.paneIndex} <span className="text-xs text-slate-500">({loc.paneId})</span></div>
              ))}
            </div>
          </Field>
        )}

        <div>
          <div className="text-xs text-slate-500 mb-1">
            Recent user prompts {recentPrompts && recentPrompts.length > 0 && <span>(last {recentPrompts.length})</span>}
          </div>
          {recentPrompts === null ? (
            <pre className="bg-slate-950 border border-slate-800 rounded p-3 text-sm whitespace-pre-wrap break-words text-slate-500">Loading…</pre>
          ) : recentPrompts.length === 0 ? (
            <pre className="bg-slate-950 border border-slate-800 rounded p-3 text-sm whitespace-pre-wrap break-words text-slate-500">
              {session.lastUserPrompt ?? "(none found)"}
            </pre>
          ) : (
            <div className="space-y-2">
              {recentPrompts.map((p, i) => (
                <PromptCard key={i} ts={p.ts} text={p.text} />
              ))}
            </div>
          )}
        </div>
        <div className="hidden">
          <pre className="bg-slate-950 border border-slate-800 rounded p-3 text-sm whitespace-pre-wrap break-words">
            {session.lastUserPrompt ?? "(none found in tail window)"}
          </pre>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500 w-32">tmux session name</label>
            <input
              value={tmuxName}
              onChange={e => setTmuxName(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm font-mono flex-1"
            />
            {originalTmuxName && tmuxName !== originalTmuxName && (
              <button
                onClick={() => setTmuxName(originalTmuxName)}
                className="text-xs text-slate-400 hover:text-white"
                title="Reset to the original tmux session name this conversation was in"
              >
                reset
              </button>
            )}
          </div>
          <div className="text-xs text-slate-500">
            {originalTmuxName
              ? `Default pulled from ${tmux?.source === "live" && tmux.tree.some(s => s.name === originalTmuxName) ? "live tmux" : "a recent snapshot"}.`
              : cwdBasename
                ? `No snapshot record of this session — using cwd basename as default.`
                : `No snapshot record — using session id as default.`}
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={() => copy(resumeCmd)}
              className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm hover:bg-slate-700"
            >
              Copy resume command
            </button>
            {resumeCwd && (
              <button
                onClick={resumeInTmux}
                disabled={resuming || !tmuxName.trim()}
                className="px-3 py-1.5 bg-blue-600 rounded text-sm hover:bg-blue-500 disabled:opacity-50"
                title={`Will launch at ${resumeCwd}`}
              >
                {resuming ? "Starting…" : "Resume in new tmux"}
              </button>
            )}
          </div>
        </div>
        {resumeMsg && (
          <div className="text-sm bg-slate-950 border border-slate-800 rounded p-3 whitespace-pre-wrap break-words">
            {resumeMsg}
          </div>
        )}
      </div>
    </div>
  );
}

function PromptCard({ ts, text }: { ts: string | null; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const PREVIEW = 500;
  const isLong = text.length > PREVIEW;
  const shown = expanded || !isLong ? text : text.slice(0, PREVIEW);
  return (
    <div className="bg-slate-950 border border-slate-800 rounded p-3">
      {ts && (
        <div className="text-xs text-slate-500 mb-1">{new Date(ts).toLocaleString()}</div>
      )}
      <pre className="text-sm whitespace-pre-wrap break-words">
        {shown}
        {isLong && !expanded && <span className="text-slate-500">…</span>}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-1 text-xs text-blue-400 hover:text-blue-300"
        >
          {expanded ? "Show less" : `Show full (${text.length} chars)`}
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div>
      <div className="text-xs text-slate-500 mb-0.5">{label}</div>
      <div className="font-mono text-sm break-all">{children}</div>
    </div>
  );
}

function CwdCell({ launchCwd, currentCwd, fallback }: { launchCwd: string | null; currentCwd: string | null; fallback: string }) {
  const l = launchCwd ?? fallback;
  const c = currentCwd ?? launchCwd ?? fallback;
  if (l === c) {
    return (
      <div>
        <span className="text-slate-500">LWD = CWD </span>
        <span>{l}</span>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <div><span className="text-slate-500">LWD </span><span>{l}</span></div>
      <div><span className="text-slate-500">CWD </span><span>{c}</span></div>
    </div>
  );
}
