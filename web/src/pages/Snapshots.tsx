import { useEffect, useState } from "react";
import { getJSON, postJSON, apiRequest, TmuxSession } from "../api";
import { relativeTime } from "../utils";
import { AccountBadge } from "../components/AccountBadge";

interface SnapEntry { name: string; mtime: number; ts: string; sessions: TmuxSession[] }

export function Snapshots() {
  const [snaps, setSnaps] = useState<SnapEntry[]>([]);
  const [restoreLog, setRestoreLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const r = await getJSON<{ snapshots: SnapEntry[] }>("/api/snapshots");
    setSnaps(r.snapshots);
  }
  useEffect(() => { refresh(); }, []);

  async function takeSnapshot() {
    setBusy(true);
    try { await postJSON("/api/snapshot"); await refresh(); }
    catch (e: any) { setRestoreLog(`snapshot failed: ${e.message ?? e}`); }
    finally { setBusy(false); }
  }

  async function restore(snapshotName: string, dryRun: boolean, force: boolean) {
    setBusy(true);
    setRestoreLog("Running…");
    try {
      const res = await postJSON<{
        ok: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string;
      }>("/api/restore", { snapshotName, dryRun, force });
      const header = res.ok ? "" : `RESTORE FAILED (exit ${res.exitCode ?? "?"})\n\n`;
      setRestoreLog(
        header +
        (res.stdout ?? "(no stdout)") +
        (res.stderr ? `\n\n--- warnings/errors ---\n${res.stderr}` : "") +
        (res.error  ? `\n\n--- node error ---\n${res.error}`  : "")
      );
    } catch (e: any) {
      setRestoreLog(`request failed (network/500 before any output): ${e.message ?? e}`);
    } finally { setBusy(false); await refresh(); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={takeSnapshot}
          disabled={busy}
          className="px-3 py-1.5 bg-blue-600 rounded text-sm hover:bg-blue-500 disabled:opacity-50"
        >
          Snapshot now
        </button>
        <button onClick={refresh} className="px-3 py-1 bg-slate-800 border border-slate-700 rounded text-sm">Refresh</button>
      </div>

      {snaps.length === 0 && (
        <div className="text-slate-500 text-sm">No snapshots yet. Click "Snapshot now" or wait for cron.</div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(22rem, 1fr))" }}>
        {snaps.map(s => (
          <div key={s.name} className="border border-slate-800 rounded p-4 bg-slate-900/30 space-y-2">
            <div className="flex justify-between items-center">
              <div className="font-mono text-sm">{s.name}</div>
              <div className="text-xs text-slate-500">{relativeTime(s.mtime)}</div>
            </div>
            <div className="text-xs text-slate-400">
              {s.sessions.length} sessions, {s.sessions.reduce((a, x) => a + x.windows.length, 0)} windows,{" "}
              {s.sessions.reduce((a, x) => a + x.windows.reduce((b, w) => b + w.panes.length, 0), 0)} panes
            </div>
            <ul className="text-xs text-slate-300 space-y-0.5">
              {s.sessions.map(ss => {
                const claudePanes = ss.windows.flatMap(w => w.panes).filter(p => p.claudeSessionId);
                const nPanes = ss.windows.reduce((a, w) => a + w.panes.length, 0);
                const nClaude = claudePanes.length;
                const accounts = [...new Set(
                  claudePanes.map(p => p.claudeAccount).filter((a): a is string => !!a)
                )].sort();
                return (
                  <li key={ss.name} className="flex items-center gap-1.5">
                    <span className="truncate">
                      <b>{ss.name}</b> · {ss.windows.length}w · {nPanes}p · {nClaude > 0 ? `${nClaude} claude` : "no claude"}
                    </span>
                    {accounts.length > 0 && <AccountBadge accounts={accounts} />}
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                onClick={() => restore(s.name, true, false)}
                disabled={busy}
                className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs"
              >
                Dry-run restore
              </button>
              <button
                onClick={() => restore(s.name, false, false)}
                disabled={busy}
                className="px-2 py-1 bg-blue-600 rounded text-xs"
              >
                Restore
              </button>
              <button
                onClick={() => restore(s.name, false, true)}
                disabled={busy}
                className="px-2 py-1 bg-red-600 rounded text-xs"
                title="Kills any tmux session with a colliding name first"
              >
                Restore --force
              </button>
            </div>
          </div>
        ))}
      </div>

      {restoreLog !== null && (
        <div className="border border-slate-800 rounded bg-slate-950/50">
          <div className="px-3 py-2 text-xs text-slate-500 border-b border-slate-800 flex justify-between">
            <span>restore output</span>
            <button onClick={() => setRestoreLog(null)} className="hover:text-white">clear</button>
          </div>
          <pre className="p-3 text-xs whitespace-pre-wrap break-words">{restoreLog}</pre>
        </div>
      )}

      <BackupsSection />
    </div>
  );
}

interface BackupFile { filename: string; ts: string; sizeBytes: number; mtime: number }
interface BackupsResponse {
  backups: BackupFile[];
  count: number;
  totalBytes: number;
  backupRemote: string | null;
  rcloneInstalled: boolean;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function BackupsSection() {
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [editingRemote, setEditingRemote] = useState(false);
  const [remoteInput, setRemoteInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);

  async function refresh() {
    const r = await apiRequest<BackupsResponse>("GET", "/api/backups");
    if (r.ok) {
      const body = r.body as BackupsResponse;
      setData(body);
      setRemoteInput(body.backupRemote ?? "");
    }
  }

  useEffect(() => { refresh(); const id = setInterval(refresh, 60_000); return () => clearInterval(id); }, []);

  async function backupNow() {
    setBusy(true); setLog("Running backup…");
    const r = await apiRequest<{ ok: boolean; stdout: string; stderr: string; exitCode?: number }>(
      "POST", "/api/backups/now", {}
    );
    setBusy(false);
    const body = r.body as { ok: boolean; stdout: string; stderr: string; exitCode?: number };
    setLog(
      (body.ok ? "" : `BACKUP FAILED (exit ${body.exitCode ?? "?"})\n\n`) +
      (body.stdout || "(no stdout)") +
      (body.stderr ? `\n\n--- stderr ---\n${body.stderr}` : "")
    );
    await refresh();
  }

  async function restoreBackup(filename: string) {
    if (!confirm(`Restore from ${filename}?\n\nA pre-restore backup of your current state is created automatically before swapping files.`)) return;
    if (!confirm(`Really sure?\n\nThis will OVERWRITE your current projects, tasks, assignments, pomodoros, settings and last 3 days of shell history with the contents of ${filename}.\n\nClick OK to proceed.`)) return;
    setBusy(true); setLog(`Restoring from ${filename}…`);
    const r = await apiRequest<{ ok: boolean; stdout: string; stderr: string; exitCode?: number }>(
      "POST", `/api/backups/${encodeURIComponent(filename)}/restore`, {}
    );
    setBusy(false);
    const body = r.body as { ok: boolean; stdout: string; stderr: string; exitCode?: number };
    setLog(
      (body.ok ? "Restore OK — restart the dev server to pick up changes.\n\n" : `RESTORE FAILED (exit ${body.exitCode ?? "?"})\n\n`) +
      (body.stdout || "(no stdout)") +
      (body.stderr ? `\n\n--- stderr ---\n${body.stderr}` : "")
    );
    await refresh();
  }

  async function saveRemote() {
    setBusy(true);
    const r = await apiRequest<BackupsResponse>("PUT", "/api/backups/config", {
      backupRemote: remoteInput.trim() || null,
    });
    setBusy(false);
    if (r.ok) { await refresh(); setEditingRemote(false); }
    else { setLog(`Saving remote failed: ${(r.body as { error: string }).error}`); }
  }

  if (!data) return null;

  const last = data.backups[0];

  return (
    <div className="border border-slate-800 rounded bg-slate-900/30 mt-8">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-3">
        <h2 className="font-semibold">Backups</h2>
        <span className="text-xs text-slate-500">
          {data.count} bundle{data.count === 1 ? "" : "s"} · {fmtBytes(data.totalBytes)}
          {last && <> · last {relativeTime(last.mtime)}</>}
        </span>
        <button onClick={backupNow} disabled={busy}
          className="ml-auto px-3 py-1 bg-blue-600 rounded text-xs hover:bg-blue-500 disabled:opacity-50"
        >Backup now</button>
        <button onClick={refresh} className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs">Refresh</button>
      </div>

      {/* Cloud remote config */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2 text-sm">
        <span className="text-slate-400">Cloud remote:</span>
        {editingRemote ? (
          <>
            <input
              value={remoteInput} onChange={e => setRemoteInput(e.target.value)}
              placeholder="e.g. gdrive:sigmapi2sigma"
              className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs font-mono"
            />
            <button onClick={saveRemote} disabled={busy} className="px-2 py-0.5 bg-blue-600 rounded text-xs">Save</button>
            <button onClick={() => { setEditingRemote(false); setRemoteInput(data.backupRemote ?? ""); }}
              className="text-xs text-slate-400">Cancel</button>
          </>
        ) : (
          <>
            <span className="font-mono text-slate-300">{data.backupRemote ?? "(local-only)"}</span>
            <button onClick={() => setEditingRemote(true)} className="text-xs text-slate-400 hover:text-white">edit</button>
          </>
        )}
        {!data.rcloneInstalled && (
          <span className="ml-auto text-xs text-amber-400/80" title="Install rclone to enable cloud sync">⚠ rclone not installed</span>
        )}
      </div>

      {/* Backup list */}
      {data.backups.length === 0 ? (
        <div className="p-4 text-sm text-slate-500">No backups yet. Click "Backup now" or wait for the cron entry.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">Bundle</th>
              <th className="text-left px-4 py-2">When</th>
              <th className="text-left px-4 py-2">Size</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {data.backups.map(b => (
              <tr key={b.filename} className="border-t border-slate-800">
                <td className="px-4 py-1.5 font-mono text-xs">{b.filename}</td>
                <td className="px-4 py-1.5 text-xs text-slate-400">{relativeTime(b.mtime)}</td>
                <td className="px-4 py-1.5 text-xs text-slate-400">{fmtBytes(b.sizeBytes)}</td>
                <td className="px-4 py-1.5">
                  <button onClick={() => restoreBackup(b.filename)} disabled={busy}
                    className="px-2 py-0.5 text-xs bg-slate-800 border border-slate-700 rounded hover:bg-slate-700"
                  >Restore</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {log !== null && (
        <div className="border-t border-slate-800 bg-slate-950/50">
          <div className="px-4 py-2 text-xs text-slate-500 flex justify-between">
            <span>backup output</span>
            <button onClick={() => setLog(null)} className="hover:text-white">clear</button>
          </div>
          <pre className="px-4 pb-3 text-xs whitespace-pre-wrap break-words">{log}</pre>
        </div>
      )}
    </div>
  );
}
