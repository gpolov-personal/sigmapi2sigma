import { useEffect, useState } from "react";
import { getJSON, ShellEntry } from "../api";
import { relativeTime } from "../utils";

export function ShellHistory() {
  const [days, setDays] = useState(7);
  const [tmuxSession, setTmuxSession] = useState("");
  const [tmuxPane, setTmuxPane] = useState("");
  const [cwdContains, setCwdContains] = useState("");
  const [cmdContains, setCmdContains] = useState("");
  const [entries, setEntries] = useState<ShellEntry[]>([]);
  const [installed, setInstalled] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set("days", String(days));
      if (tmuxSession) p.set("tmuxSession", tmuxSession);
      if (tmuxPane)    p.set("tmuxPane", tmuxPane);
      if (cwdContains) p.set("cwdContains", cwdContains);
      if (cmdContains) p.set("cmdContains", cmdContains);
      const r = await getJSON<{ entries: ShellEntry[]; installed: boolean }>(`/api/shell-history?${p}`);
      setEntries(r.entries);
      setInstalled(r.installed);
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, [days, tmuxSession, tmuxPane, cwdContains, cmdContains]);

  if (!installed) {
    return (
      <div className="border border-amber-800 bg-amber-950/40 rounded p-4 text-sm space-y-2">
        <p><b>Shell hook not installed.</b> Per-tmux-pane command history is empty.</p>
        <p>Install with: <code className="bg-slate-900 px-2 py-0.5 rounded">npm run install-shell-hook</code></p>
        <p className="text-slate-400 text-xs">The hook appends to <code>~/.zshrc</code>, prints the diff first. Only logs while inside tmux.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Label>Last days</Label>
        <select value={days} onChange={e => setDays(Number(e.target.value))} className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm">
          {[1, 3, 7, 14, 30, 60].map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <Input placeholder="tmux session" value={tmuxSession} onChange={setTmuxSession} />
        <Input placeholder="tmux pane id (e.g. %4)" value={tmuxPane} onChange={setTmuxPane} />
        <Input placeholder="cwd contains…" value={cwdContains} onChange={setCwdContains} />
        <Input placeholder="cmd contains…" value={cmdContains} onChange={setCmdContains} />
        <span className="text-xs text-slate-500">{entries.length} entries {loading ? "…" : ""}</span>
      </div>

      <div className="border border-slate-800 rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-slate-400 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2 whitespace-nowrap">When</th>
              <th className="text-left px-3 py-2">Tmux</th>
              <th className="text-left px-3 py-2">Pane</th>
              <th className="text-left px-3 py-2">cwd</th>
              <th className="text-left px-3 py-2">Command</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice().reverse().map((e, i) => (
              <tr key={i} className="border-t border-slate-800 hover:bg-slate-900/60">
                <td className="px-3 py-1 whitespace-nowrap text-slate-400 text-xs">{relativeTime(new Date(e.ts).getTime())}</td>
                <td className="px-3 py-1 text-slate-300">{e.tmuxSession ?? ""}</td>
                <td className="px-3 py-1 font-mono text-xs text-slate-400">{e.tmuxPane ?? ""}</td>
                <td className="px-3 py-1 font-mono text-xs text-slate-300">{e.cwd ?? ""}</td>
                <td className="px-3 py-1 font-mono text-xs text-white">{e.cmd ?? ""}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">No commands recorded.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Label(p: { children: any }) { return <label className="text-sm text-slate-400">{p.children}</label>; }
function Input(p: { placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      placeholder={p.placeholder}
      value={p.value}
      onChange={e => p.onChange(e.target.value)}
      className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
    />
  );
}
