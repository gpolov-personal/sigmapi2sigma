import path from "node:path";
import fs from "node:fs/promises";
import { DATA_DIR } from "./pathEncoding.js";

export const TMUX_BINDINGS_FILE = path.join(DATA_DIR, "tmux-bindings.jsonl");

function parseTs(s: string): number {
  const n = Date.parse(s);
  return Number.isNaN(n) ? 0 : n;  // Unparseable timestamps lose the newest-wins race.
}

export interface TmuxBinding {
  ts: string;
  claudeSessionId: string;
  tmuxSession: string;
  windowIndex: number;
  paneIndex: number;
  cwd: string;
}

/**
 * Read the entire bindings file. Lines that fail to parse are silently skipped.
 * The file is small (a few hundred KB at most under normal use) so we read it whole.
 */
export async function readBindings(): Promise<TmuxBinding[]> {
  let txt: string;
  try { txt = await fs.readFile(TMUX_BINDINGS_FILE, "utf8"); }
  catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
  const out: TmuxBinding[] = [];
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.ts === "string" &&
          typeof obj.claudeSessionId === "string" &&
          typeof obj.tmuxSession === "string" &&
          typeof obj.windowIndex === "number" &&
          typeof obj.paneIndex === "number" &&
          typeof obj.cwd === "string") {
        out.push(obj);
      }
    } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * Also harvest bindings from the rotated snapshot files. This covers the period
 * before the bindings log existed, and any time snapshot.sh failed to append.
 */
async function readBindingsFromSnapshots(): Promise<TmuxBinding[]> {
  const dir = path.join(DATA_DIR, "snapshots");
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
  const out: TmuxBinding[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    if (f !== "latest.json" && f !== "prev.json" && !/^prev\d+\.json$/.test(f)) continue;
    try {
      const txt = await fs.readFile(path.join(dir, f), "utf8");
      const parsed = JSON.parse(txt);
      if (typeof parsed.ts !== "string") continue;  // Skip malformed snapshots so they can't outrank good data.
      const ts = parsed.ts;
      for (const s of parsed.sessions ?? []) {
        for (const w of s.windows ?? []) {
          for (const p of w.panes ?? []) {
            if (!p?.claudeSessionId) continue;
            out.push({
              ts,
              claudeSessionId: p.claudeSessionId,
              tmuxSession: s.name,
              windowIndex: w.index,
              paneIndex: p.index,
              cwd: p.cwd ?? "",
            });
          }
        }
      }
    } catch { /* skip */ }
  }
  return out;
}

/**
 * For a set of session ids, return the most recent (by ts) binding for each one.
 * Sources combined: tmux-bindings.jsonl + the current snapshot rotation.
 */
export async function getLastLocationsBySessionId(ids: Set<string>): Promise<Map<string, TmuxBinding>> {
  const all = [...await readBindings(), ...await readBindingsFromSnapshots()];
  const newest = new Map<string, TmuxBinding>();
  for (const b of all) {
    if (!ids.has(b.claudeSessionId)) continue;
    const cur = newest.get(b.claudeSessionId);
    if (!cur || parseTs(cur.ts) < parseTs(b.ts)) newest.set(b.claudeSessionId, b);
  }
  return newest;
}
