import { useEffect, useMemo, useState } from "react";
import { getJSON, getText, postJSON, TmuxResponse, TmuxPane, TmuxWindow, TmuxSession, ShellEntry, SavedTmuxFile } from "../api";
import { copy, relativeTime, trunc } from "../utils";
import { ProjectAssignmentMenu } from "../components/ProjectAssignmentMenu";
import { BrainCircuit } from "lucide-react";

// Persisted fold state — keys are namespaced so section/saved/live can coexist.
const COLLAPSE_LS = "tmuxMap:collapsed";
const KEY_SAVED_SECTION = "section:saved";
const keyForSavedEntry  = (name: string) => `saved:${name}`;
const keyForLiveSession = (name: string) => `live:${name}`;

export function TmuxMap() {
  const [data, setData] = useState<TmuxResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [scrollback, setScrollback] = useState<{ paneId: string; text: string } | null>(null);
  const [cmdModal, setCmdModal] = useState<{ paneId: string; entries: ShellEntry[] } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_LS);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_LS, JSON.stringify([...collapsed])); }
    catch { /* full quota / private mode → ignore */ }
  }, [collapsed]);
  const [restoreLog, setRestoreLog] = useState<string | null>(null);
  type ForceContext = {
    name: string;
    source: "saved" | "snapshot";
    sourceLabel: string;
    liveSession: TmuxSession;
  };
  const [forceConfirm, setForceConfirm] = useState<ForceContext | null>(null);
  const [saved, setSaved] = useState<SavedTmuxFile | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [tmuxR, savedR] = await Promise.allSettled([
        getJSON<TmuxResponse>("/api/tmux"),
        getJSON<SavedTmuxFile>("/api/saved-tmux"),
      ]);
      if (tmuxR.status === "fulfilled") setData(tmuxR.value);
      if (savedR.status === "fulfilled") setSaved(savedR.value);
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 60_000); return () => clearInterval(id); }, []);

  const live = data?.source === "live";
  const liveIds = useMemo(() => new Set(data?.livePaneIds ?? []), [data]);

  // Merge the live tree with sessions found in any recent snapshot. Snapshots are ordered
  // newest-first (latest, prev, prev2, ...), so the first hit wins for "last seen at".
  const { sessions, lastSeenByName } = useMemo(() => {
    const result = { sessions: [] as typeof data extends { tree: infer T } ? T : any[], lastSeenByName: new Map<string, string>() };
    if (!data) return result;
    const byName = new Map<string, typeof data.tree[number]>();
    const liveList = data.source === "live" ? data.tree : [];
    for (const s of liveList) byName.set(s.name, s);
    for (const snap of data.snapshots ?? []) {
      for (const s of snap.sessions ?? []) {
        if (!byName.has(s.name)) {
          byName.set(s.name, s);
          if (snap.ts) result.lastSeenByName.set(s.name, snap.ts);
        }
      }
    }
    if (data.source === "snapshot" && byName.size === 0) {
      result.sessions = data.tree as any;
    } else {
      result.sessions = [...byName.values()] as any;
    }
    return result;
  }, [data]);

  const liveSessionNames = useMemo(
    () => new Set(data?.source === "live" ? data.tree.map(s => s.name) : []),
    [data]
  );

  // Detect LWDs that have >1 distinct active claude conversation. This is a bad pattern
  // (intentional invariant: at most one Claude conversation per LWD).
  // Same conversation in two panes does NOT count as a violation.
  const lwdViolations = useMemo(() => {
    const cwdToSessionIds = new Map<string, Set<string>>();
    if (!data || data.source !== "live") return new Map<string, string[]>();
    for (const s of data.tree) {
      for (const w of s.windows) {
        for (const p of w.panes) {
          if (p.cmd !== "claude" || !p.claudeSessionId) continue;
          const set = cwdToSessionIds.get(p.cwd) ?? new Set<string>();
          set.add(p.claudeSessionId);
          cwdToSessionIds.set(p.cwd, set);
        }
      }
    }
    const violations = new Map<string, string[]>();
    for (const [cwd, ids] of cwdToSessionIds) {
      if (ids.size > 1) violations.set(cwd, [...ids]);
    }
    return violations;
  }, [data]);

  function toggle(name: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }
  function foldAll() {
    const keys: string[] = [];
    if (saved && saved.sessions.length > 0) {
      keys.push(KEY_SAVED_SECTION);
      for (const s of saved.sessions) keys.push(keyForSavedEntry(s.name));
    }
    for (const s of (sessions as TmuxSession[])) keys.push(keyForLiveSession(s.name));
    setCollapsed(new Set(keys));
  }
  function unfoldAll() {
    setCollapsed(new Set());
  }

  async function openCommands(paneId: string) {
    const r = await getJSON<{ entries: ShellEntry[] }>(`/api/shell-history?tmuxPane=${encodeURIComponent(paneId)}&days=30`);
    setCmdModal({ paneId, entries: r.entries });
  }

  async function restoreOnly(sessionName: string, force: boolean) {
    setRestoreLog(`Restoring "${sessionName}"…`);
    try {
      const r = await postJSON<{
        ok: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string;
      }>("/api/restore", { only: sessionName, force });
      const header = r.ok ? "" : `RESTORE FAILED (exit ${r.exitCode ?? "?"})\n\n`;
      setRestoreLog(
        header +
        (r.stdout ?? "(no stdout)") +
        (r.stderr ? `\n\n--- warnings/errors ---\n${r.stderr}` : "") +
        (r.error  ? `\n\n--- node error ---\n${r.error}`  : "")
      );
      await refresh();
    } catch (e: any) {
      setRestoreLog(`request failed (network/500 before any output): ${e.message ?? e}`);
    }
  }

  async function restoreSaved(name: string, force: boolean) {
    setRestoreLog(`Restoring saved "${name}"…`);
    try {
      const r = await postJSON<{
        ok: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string;
      }>(`/api/saved-tmux/${encodeURIComponent(name)}/restore`, { force });
      const header = r.ok ? "" : `RESTORE FAILED (exit ${r.exitCode ?? "?"})\n\n`;
      setRestoreLog(
        header +
        (r.stdout ?? "(no stdout)") +
        (r.stderr ? `\n\n--- warnings/errors ---\n${r.stderr}` : "") +
        (r.error  ? `\n\n--- node error ---\n${r.error}`  : "")
      );
      await refresh();
    } catch (e: any) {
      setRestoreLog(`request failed: ${e.message ?? e}`);
    }
  }

  async function forget(name: string) {
    if (!confirm(`Forget saved session "${name}"? This removes the bookmark but doesn't touch tmux.`)) return;
    await fetch(`/api/saved-tmux/${encodeURIComponent(name)}`, { method: "DELETE" });
    await refresh();
  }

  function tryForceRestore(source: "saved" | "snapshot", name: string, sourceLabel: string) {
    if (!liveSessionNames.has(name)) {
      // No conflict — proceed without prompt.
      if (source === "saved") restoreSaved(name, true); else restoreOnly(name, true);
      return;
    }
    const liveSession = (data?.source === "live" ? data.tree : []).find(s => s.name === name);
    if (!liveSession) {
      // Defensive: liveSessionNames was true but lookup failed. Proceed without prompt.
      if (source === "saved") restoreSaved(name, true); else restoreOnly(name, true);
      return;
    }
    setForceConfirm({ name, source, sourceLabel, liveSession });
  }

  function confirmForce() {
    const ctx = forceConfirm;
    setForceConfirm(null);
    if (!ctx) return;
    if (ctx.source === "saved") restoreSaved(ctx.name, true); else restoreOnly(ctx.name, true);
  }

  async function saveForLater(name: string) {
    try {
      await postJSON("/api/saved-tmux/pin", { sessionName: name });
      await refresh();
    } catch (e: any) {
      setRestoreLog(`Save failed: ${e.message ?? e}`);
    }
  }

  return (
    <div className="space-y-4">
      <div className={`border rounded p-3 text-sm flex items-center gap-4 ${
        live && (data?.tree.length ?? 0) > 0 ? "border-green-800 bg-green-950/40" :
        live                                  ? "border-amber-800 bg-amber-950/40" :
                                                "border-slate-700 bg-slate-900/40"
      }`}>
        {live && (data?.tree.length ?? 0) > 0 ? (
          <span><b>Live</b> — reading tmux directly. {data?.tree.length} session{data!.tree.length === 1 ? "" : "s"} running.</span>
        ) : live ? (
          <span>
            <b>tmux is running but has no sessions.</b>
            {data?.snapshot
              ? ` Showing snapshot from ${relativeTime(new Date(data.snapshot.ts).getTime())} — every entry below is dead until restored.`
              : " No snapshot to compare against."}
          </span>
        ) : data?.snapshot ? (
          <span><b>tmux server isn't running.</b> Showing snapshot from {relativeTime(new Date(data.snapshot.ts).getTime())}; everything is "unknown" until tmux is up.</span>
        ) : (
          <span><b>tmux server isn't running</b> and no snapshot exists.</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={foldAll} disabled={sessions.length === 0}
            className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded text-xs disabled:opacity-40">
            Fold all
          </button>
          <button onClick={unfoldAll} disabled={sessions.length === 0}
            className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded text-xs disabled:opacity-40">
            Unfold all
          </button>
          <button onClick={refresh} className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded text-xs">
            {loading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="text-xs text-slate-400 flex flex-wrap gap-4 px-1">
        <span><span className="inline-block w-3 h-3 rounded-sm border border-green-700 align-middle mr-1"/> alive — currently in tmux</span>
        <span><span className="inline-block w-3 h-3 rounded-sm border border-red-700 align-middle mr-1"/> dead — tmux is running but this session/pane is gone (came from a snapshot)</span>
        <span><span className="inline-block w-3 h-3 rounded-sm border border-slate-600 border-dashed align-middle mr-1"/> unknown — tmux server isn't running at all; can't verify</span>
      </div>

      {lwdViolations.size > 0 && (
        <div className="border border-yellow-700 bg-yellow-950/40 rounded p-3 text-sm space-y-2">
          <div className="font-semibold text-yellow-300">⚠️ Multiple Claude conversations in the same LWD — bad pattern</div>
          <div className="text-yellow-200/90 text-xs">
            You usually want at most one Claude conversation per launch directory. Two distinct conversations in the same LWD make session resolution and the topic↔tmux assignment ambiguous. Consider closing one or moving it to a different cwd.
          </div>
          <ul className="text-xs space-y-1">
            {[...lwdViolations.entries()].map(([cwd, ids]) => (
              <li key={cwd}>
                <span className="font-mono text-yellow-200">{cwd}</span>
                <span className="text-yellow-400/70"> — {ids.length} conversations: </span>
                <span className="font-mono text-yellow-200">{ids.map(i => i.slice(0, 8)).join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {saved && saved.sessions.length > 0 && (
        <div className="border border-amber-700/60 bg-amber-950/20 rounded">
          <div className="px-4 py-2 font-semibold border-b border-amber-800/60 flex items-center gap-3">
            <button
              onClick={() => toggle(KEY_SAVED_SECTION)}
              className="text-slate-400 hover:text-white w-4"
            >{collapsed.has(KEY_SAVED_SECTION) ? "▶" : "▼"}</button>
            <span className="text-amber-300">📌 Saved for Later</span>
            <span className="text-xs text-slate-400">{saved.sessions.length} pinned · survives snapshot rotation</span>
          </div>
          {!collapsed.has(KEY_SAVED_SECTION) && (
          <div className="divide-y divide-amber-900/40">
            {saved.sessions.map(s => {
              const m = saved.meta[s.name];
              const aliveNow = liveSessionNames.has(s.name);
              const allPaneIds = s.windows.flatMap(w => w.panes.map(p => p.paneId));
              return (
                <div key={s.name} className="px-4 py-2">
                  <div className="flex items-center gap-3 mb-2">
                    <button
                      onClick={() => toggle(keyForSavedEntry(s.name))}
                      className="text-slate-400 hover:text-white w-4"
                    >{collapsed.has(keyForSavedEntry(s.name)) ? "▶" : "▼"}</button>
                    <span className="font-semibold">{s.name}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-200">saved</span>
                    {aliveNow && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/40 text-green-300">currently alive</span>
                    )}
                    <span className="text-xs text-slate-500">
                      {s.windows.length}w · {allPaneIds.length}p
                    </span>
                    {m && (
                      <span className="text-xs text-slate-500" title={`saved ${m.savedAt}; last seen ${m.lastSeenAt}`}>
                        saved {relativeTime(new Date(m.savedAt).getTime())} · last seen {relativeTime(new Date(m.lastSeenAt).getTime())}
                      </span>
                    )}
                    <div className="ml-auto flex gap-2">
                      <button
                        onClick={() => copy(`tmux attach -t ${s.name}`)}
                        className="text-xs text-slate-400 hover:text-white"
                      >copy attach</button>
                      <button
                        onClick={() => restoreSaved(s.name, false)}
                        disabled={aliveNow}
                        className="text-xs px-2 py-0.5 bg-blue-600 rounded hover:bg-blue-500 disabled:opacity-40"
                        title={aliveNow ? "Already running — kill it first or use --force" : "Recreate the tmux session from the saved data"}
                      >Restore</button>
                      <button
                        onClick={() => tryForceRestore(
                          "saved",
                          s.name,
                          m ? `saved-tmux.json (saved ${relativeTime(new Date(m.savedAt).getTime())})` : "saved-tmux.json"
                        )}
                        className="text-xs px-2 py-0.5 bg-red-700 rounded hover:bg-red-600"
                        title="Kill any existing session with this name first"
                      >Restore --force</button>
                      <button
                        onClick={() => forget(s.name)}
                        className="text-xs px-2 py-0.5 bg-slate-800 border border-slate-700 rounded hover:bg-slate-700"
                      >Forget</button>
                    </div>
                  </div>
                  {!collapsed.has(keyForSavedEntry(s.name)) && (
                    <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(22rem, 1fr))" }}>
                      {s.windows.flatMap(w => w.panes.map(p => (
                        <PaneCard
                          key={`${w.index}.${p.index}.${p.paneId}`}
                          pane={p}
                          state="unknown"
                          onCommands={() => openCommands(p.paneId)}
                        />
                      )))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}
        </div>
      )}

      {sessions.length === 0 && (
        <div className="text-slate-500 text-sm">No tmux sessions to show.</div>
      )}

      {(sessions as TmuxSession[]).map(s => {
        const allPaneIds = s.windows.flatMap((w: TmuxWindow) => w.panes.map((p: TmuxPane) => p.paneId));
        // 3-state: alive (in live tmux), dead (tmux up, session not there), unknown (tmux down).
        const sessionState: "alive" | "dead" | "unknown" =
          !live ? "unknown" : liveSessionNames.has(s.name) ? "alive" : "dead";
        const sessionBorder =
          sessionState === "alive"   ? "border-green-900" :
          sessionState === "dead"    ? "border-red-900" :
                                       "border-slate-700 border-dashed";
        const sessionBadge =
          sessionState === "alive"   ? "bg-green-900/40 text-green-300" :
          sessionState === "dead"    ? "bg-red-900/40 text-red-300" :
                                       "bg-slate-800 text-slate-400";
        const isCollapsed = collapsed.has(keyForLiveSession(s.name));
        return (
          <div key={s.name} className={`border rounded bg-slate-900/30 ${sessionBorder}`}>
            <div className="px-4 py-2 font-semibold border-b border-slate-800 flex items-center gap-3">
              <button onClick={() => toggle(keyForLiveSession(s.name))} className="text-slate-400 hover:text-white w-4">
                {isCollapsed ? "▶" : "▼"}
              </button>
              <span>{s.name}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${sessionBadge}`}>
                {sessionState}
              </span>
              <ProjectAssignmentMenu tmuxSessionName={s.name} />
              {sessionState !== "alive" && lastSeenByName.get(s.name) && (
                <span className="text-xs text-slate-500" title={`Source: ${lastSeenByName.get(s.name)}`}>
                  last seen {relativeTime(new Date(lastSeenByName.get(s.name)!).getTime())}
                </span>
              )}
              <span className="text-xs text-slate-500">
                {s.windows.length}w · {allPaneIds.length}p
              </span>
              <div className="ml-auto flex gap-2">
                <button
                  onClick={() => copy(`tmux attach -t ${s.name}`)}
                  className="text-xs text-slate-400 hover:text-white"
                >
                  copy attach
                </button>
                {sessionState !== "alive" && (
                  <>
                    {!saved?.sessions.some(x => x.name === s.name) && (
                      <button
                        onClick={() => saveForLater(s.name)}
                        className="text-xs px-2 py-0.5 bg-amber-700 rounded hover:bg-amber-600"
                        title="Pin this session into ~/.sigmapi2sigma/saved-tmux.json so it survives snapshot rotation"
                      >📌 Save for later</button>
                    )}
                    <button
                      onClick={() => restoreOnly(s.name, false)}
                      className="text-xs px-2 py-0.5 bg-blue-600 rounded hover:bg-blue-500"
                    >Restore this session</button>
                    <button
                      onClick={() => tryForceRestore(
                        "snapshot",
                        s.name,
                        data?.snapshot
                          ? `snapshot ${relativeTime(new Date(data.snapshot.ts).getTime())}`
                          : "the latest snapshot"
                      )}
                      className="text-xs px-2 py-0.5 bg-red-700 rounded hover:bg-red-600"
                      title="Kill any existing session with this name first"
                    >Restore --force</button>
                  </>
                )}
                {sessionState === "alive" && !saved?.sessions.some(x => x.name === s.name) && (
                  <button
                    onClick={() => saveForLater(s.name)}
                    className="text-xs px-2 py-0.5 bg-amber-700 rounded hover:bg-amber-600"
                    title="Bookmark this session before killing it — survives snapshot rotation"
                  >📌 Save for later</button>
                )}
              </div>
            </div>
            {!isCollapsed && (
              <div className="divide-y divide-slate-800">
                {s.windows.map((w: TmuxWindow) => (
                  <div key={w.index} className="px-4 py-2">
                    <div className="text-sm text-slate-300 mb-2">
                      <span className="text-slate-500">window </span>
                      <b>{w.index}</b>
                      <span className="text-slate-500 ml-2">{w.name}</span>
                    </div>
                    <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(22rem, 1fr))" }}>
                      {w.panes.map((p: TmuxPane) => {
                        const alive = live && liveIds.has(p.paneId);
                        const dead = live && !liveIds.has(p.paneId);
                        const lwdConflict = lwdViolations.has(p.cwd) && p.cmd === "claude";
                        return (
                          <PaneCard
                            key={p.paneId}
                            pane={p}
                            state={alive ? "alive" : dead ? "dead" : "unknown"}
                            lwdConflict={lwdConflict}
                            onCapture={alive ? async () => {
                              const t = await getText(`/api/panes/${encodeURIComponent(p.paneId)}/scrollback?lines=500`);
                              setScrollback({ paneId: p.paneId, text: t });
                            } : undefined}
                            onCommands={() => openCommands(p.paneId)}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {scrollback && (
        <ScrollbackModal
          title={`Pane ${scrollback.paneId} — screen buffer (commands + output, last 500 lines)`}
          paneId={scrollback.paneId}
          body={<pre className="flex-1 overflow-auto p-4 text-xs whitespace-pre-wrap break-words">{scrollback.text || "(empty)"}</pre>}
          onClose={() => setScrollback(null)}
        />
      )}
      {cmdModal && (
        <ScrollbackModal
          title={`Pane ${cmdModal.paneId} — commands run here (last 30 days)`}
          paneId={cmdModal.paneId}
          body={
            <div className="flex-1 overflow-auto">
              {cmdModal.entries.length === 0 ? (
                <div className="p-4 text-sm text-slate-500">
                  No commands recorded for this pane. Install the shell hook (<code>npm run install-shell-hook</code>) to enable capture.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-900 text-slate-400 text-xs uppercase sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 whitespace-nowrap">When</th>
                      <th className="text-left px-3 py-2">cwd</th>
                      <th className="text-left px-3 py-2">Command</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cmdModal.entries.slice().reverse().map((e, i) => (
                      <tr key={i} className="border-t border-slate-800">
                        <td className="px-3 py-1 whitespace-nowrap text-xs text-slate-400">{relativeTime(new Date(e.ts).getTime())}</td>
                        <td className="px-3 py-1 font-mono text-xs text-slate-300">{e.cwd}</td>
                        <td className="px-3 py-1 font-mono text-xs text-white">{e.cmd}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          }
          onClose={() => setCmdModal(null)}
        />
      )}
      {restoreLog !== null && (
        <div className="border border-slate-800 rounded bg-slate-950/50 mt-4">
          <div className="px-3 py-2 text-xs text-slate-500 border-b border-slate-800 flex justify-between">
            <span>restore output</span>
            <button onClick={() => setRestoreLog(null)} className="hover:text-white">clear</button>
          </div>
          <pre className="p-3 text-xs whitespace-pre-wrap break-words">{restoreLog}</pre>
        </div>
      )}
      {forceConfirm && (
        <ForceConfirmModal
          ctx={forceConfirm}
          onCancel={() => setForceConfirm(null)}
          onConfirm={confirmForce}
        />
      )}
    </div>
  );
}

function PaneCard({ pane, state, lwdConflict, onCapture, onCommands }:
  { pane: TmuxPane; state: "alive" | "dead" | "unknown"; lwdConflict?: boolean; onCapture?: () => void; onCommands: () => void }) {
  const isClaude = pane.cmd === "claude";
  // LWD conflict (multiple distinct claude conversations in same dir) overrides border color.
  // Claude panes get a thicker, brighter border + tinted background to stand out.
  const baseBorder = lwdConflict
    ? "border-yellow-600"
    : state === "alive"   ? (isClaude ? "border-cyan-500 border-l-4" : "border-green-700")
    : state === "dead"    ? "border-red-700"
    :                       "border-slate-700 border-dashed";
  const bg = isClaude && state === "alive" ? "bg-cyan-950/30" : "bg-slate-950/50";
  const badge =
    state === "alive"   ? <span className="text-xs text-green-400">alive</span> :
    state === "dead"    ? <span className="text-xs text-red-400">dead</span> :
                          <span className="text-xs text-slate-500">unknown</span>;

  return (
    <div className={`border rounded p-3 ${bg} ${baseBorder}`}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          {isClaude && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold bg-cyan-600/30 text-cyan-200 border border-cyan-700"
              title="Claude Code is running in this pane"
            >
              <BrainCircuit size={12} /> CLAUDE
            </span>
          )}
          <div className="text-xs font-mono text-slate-500">{pane.paneId} · pane {pane.index}</div>
        </div>
        <div className="flex items-center gap-2">
          {lwdConflict && (
            <span
              className="text-xs text-yellow-400"
              title="Multiple distinct Claude conversations are running in this LWD — bad pattern. Close one or move to a different directory."
            >
              ⚠ LWD conflict
            </span>
          )}
          {badge}
        </div>
      </div>
      {isClaude && pane.claudeSessionId && (
        <div className="mb-2 text-xs">
          <span className="text-cyan-400/70">session </span>
          <span className="font-mono text-cyan-200">{pane.claudeSessionId.slice(0, 12)}…</span>
        </div>
      )}
      <PaneCwd pane={pane} />
      {!isClaude && <div className="text-xs text-slate-400 mt-1">{pane.cmd}</div>}
      <div className="mt-2 flex gap-2 flex-wrap">
        <button
          onClick={onCommands}
          className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded text-xs hover:bg-slate-700"
          title="Commands recorded by the preexec hook (works for dead panes too)"
        >
          Commands
        </button>
        {onCapture && (
          <button
            onClick={onCapture}
            className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded text-xs hover:bg-slate-700"
            title="Raw scrollback: commands + output interleaved"
          >
            Screen buffer
          </button>
        )}
      </div>
    </div>
  );
}

function PaneCwd({ pane }: { pane: TmuxPane }) {
  // For claude panes: show LWD (tmux's pane_current_path = claude's launch dir)
  // and CWD (JSONL tail = the dir claude is logically "in" right now).
  // For everything else: just show CWD (tmux's pane_current_path is the real current dir).
  const isClaude = pane.cmd === "claude";
  if (isClaude) {
    const lwd = pane.cwd;
    const cwd = pane.claudeLastCwd ?? pane.cwd;
    if (lwd === cwd) {
      return (
        <div className="text-sm font-mono break-all" title={lwd}>
          <span className="text-slate-500 mr-1">LWD=CWD</span>
          {trunc(lwd, 50)}
        </div>
      );
    }
    return (
      <div className="text-sm font-mono break-all space-y-0.5">
        <div title={lwd}><span className="text-slate-500 mr-1">LWD</span>{trunc(lwd, 50)}</div>
        <div title={cwd} className="text-amber-300/80"><span className="text-slate-500 mr-1">CWD</span>{trunc(cwd, 50)}</div>
      </div>
    );
  }
  return (
    <div className="text-sm font-mono break-all" title={pane.cwd}>
      <span className="text-slate-500 mr-1">CWD</span>
      {trunc(pane.cwd, 50)}
    </div>
  );
}

function ScrollbackModal({ title, body, onClose }:
  { title: string; paneId: string; body: any; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="w-[80rem] max-w-full max-h-[90vh] bg-slate-900 border border-slate-800 rounded flex flex-col"
      >
        <div className="flex justify-between items-center px-4 py-2 border-b border-slate-800">
          <div className="font-mono text-sm">{title}</div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">✕</button>
        </div>
        {body}
      </div>
    </div>
  );
}

function ForceConfirmModal({ ctx, onCancel, onConfirm }: {
  ctx: { name: string; source: "saved" | "snapshot"; sourceLabel: string; liveSession: TmuxSession };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const allPanes = ctx.liveSession.windows.flatMap(w => w.panes);
  const cwds = [...new Set(allPanes.map(p => p.cwd))];
  const claudeIds = allPanes
    .filter(p => p.cmd === "claude" && p.claudeSessionId)
    .map(p => p.claudeSessionId!);

  // Esc key dismisses without action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div
        onClick={e => e.stopPropagation()}
        className="bg-slate-900 border border-red-700 rounded p-6 max-w-2xl w-full mx-4"
      >
        <h2 className="text-lg font-semibold text-red-300 mb-3">Replace running tmux session?</h2>
        <p className="text-sm mb-2">
          A live tmux session named <code className="text-amber-300">{ctx.name}</code> is currently running with:
        </p>
        <ul className="text-sm space-y-1 mb-3 text-slate-300">
          <li>• {ctx.liveSession.windows.length} window{ctx.liveSession.windows.length === 1 ? "" : "s"}, {allPanes.length} pane{allPanes.length === 1 ? "" : "s"}</li>
          {cwds.slice(0, 4).map(c => <li key={c} className="font-mono text-xs truncate">• cwd: {c}</li>)}
          {cwds.length > 4 && <li className="text-xs text-slate-500">  (+{cwds.length - 4} more cwds)</li>}
          {claudeIds.length > 0 && (
            <li>• {claudeIds.length} Claude conversation{claudeIds.length === 1 ? "" : "s"}</li>
          )}
        </ul>
        <p className="text-sm text-slate-400 mb-4">
          <b>Restore --force</b> will <b className="text-red-300">kill the running session</b> and recreate it from {ctx.sourceLabel}.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm hover:bg-slate-700"
          >Cancel</button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 bg-red-700 rounded text-sm hover:bg-red-600"
          >Replace</button>
        </div>
      </div>
    </div>
  );
}
