import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./pathEncoding.js";

/**
 * Pane→conversation bindings written by the SessionStart hook (sp2s-bind.sh, installed
 * from the dotfiles repo). Nothing on disk otherwise links a tmux pane to a Claude
 * conversation, so without these we can only guess by newest .jsonl mtime — which
 * returns one answer for every pane in a project and cannot tell two panes apart.
 */
export interface PaneBinding {
  ts: string;
  source: string;          // startup | resume | clear | compact | fork
  sessionId: string;
  transcriptPath: string;
  paneId: string;          // tmux "%N" — the join key
  tmuxSession: string;
  windowIndex: number;
  paneIndex: number;
  cwd: string;
  configDir: string;       // CLAUDE_CONFIG_DIR the session runs under
}

export const PANE_BINDINGS_FILE = path.join(DATA_DIR, "pane-bindings.jsonl");

function parseLine(line: string): PaneBinding | null {
  let j: any;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j.paneId !== "string" || typeof j.sessionId !== "string") return null;
  if (!j.paneId || !j.sessionId) return null;
  return {
    ts: typeof j.ts === "string" ? j.ts : "",
    source: typeof j.source === "string" ? j.source : "unknown",
    sessionId: j.sessionId,
    transcriptPath: typeof j.transcriptPath === "string" ? j.transcriptPath : "",
    paneId: j.paneId,
    tmuxSession: typeof j.tmuxSession === "string" ? j.tmuxSession : "",
    windowIndex: Number.isFinite(j.windowIndex) ? j.windowIndex : -1,
    paneIndex: Number.isFinite(j.paneIndex) ? j.paneIndex : -1,
    cwd: typeof j.cwd === "string" ? j.cwd : "",
    configDir: typeof j.configDir === "string" ? j.configDir : "",
  };
}

/**
 * Newest binding per paneId, keyed by paneId.
 *
 * Resolves by **file order, not timestamp**: the log is append-only so later lines are
 * newer, and this machine's clock is not monotonic (WSL jumps on suspend/resume), which
 * makes `ts` unsafe to sort on. `ts` is retained for humans only.
 *
 * Exported for tests.
 */
export function latestByPaneId(lines: string[]): Map<string, PaneBinding> {
  const out = new Map<string, PaneBinding>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const b = parseLine(line);
    if (!b) continue;
    out.set(b.paneId, b);   // later line wins
  }
  return out;
}

/** Read the bindings log. Returns an empty map when the hook has never run. */
export async function readPaneBindings(): Promise<Map<string, PaneBinding>> {
  let txt: string;
  try { txt = await fs.readFile(PANE_BINDINGS_FILE, "utf8"); }
  catch { return new Map(); }
  return latestByPaneId(txt.split("\n"));
}
