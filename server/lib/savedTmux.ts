import path from "node:path";
import { DATA_DIR } from "./pathEncoding.js";
import { readJsonSafe, writeJsonAtomic } from "./dataStore.js";
import type { TmuxSession } from "./tmux.js";

// Read-modify-write functions below assume a single-writer environment, matching
// the rest of ~/.sigmapi2sigma/*.json stores. Concurrent pin/forget calls can
// race; we accept this trade-off rather than introducing a mutex layer.

export const SAVED_TMUX_FILE = path.join(DATA_DIR, "saved-tmux.json");

export interface SavedSessionMeta {
  savedAt: string;     // ISO when the user clicked "Save for later"
  lastSeenAt: string;  // ISO of the snapshot the session data was copied from (or "now" if from live)
}

export interface SavedTmuxFile {
  version: 1;
  ts: string;                              // last-write time of this file
  sessions: TmuxSession[];                 // restore.sh consumes this directly
  meta: Record<string, SavedSessionMeta>;  // keyed by session name
}

const EMPTY: SavedTmuxFile = { version: 1, ts: new Date(0).toISOString(), sessions: [], meta: {} };

export async function readSavedTmux(): Promise<SavedTmuxFile> {
  const raw = await readJsonSafe<Partial<SavedTmuxFile>>(SAVED_TMUX_FILE, EMPTY);
  return {
    version: 1,
    ts: typeof raw.ts === "string" ? raw.ts : EMPTY.ts,
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    meta: raw.meta && typeof raw.meta === "object" ? raw.meta : {},
  };
}

async function writeSavedTmux(data: SavedTmuxFile): Promise<void> {
  data.ts = new Date().toISOString();
  await writeJsonAtomic(SAVED_TMUX_FILE, data);
}

/**
 * Pin a session. If a saved entry with the same name already exists, replace it
 * (the user explicitly re-saved it, presumably with fresher data).
 */
export async function pinSession(
  session: TmuxSession,
  lastSeenAt: string,
): Promise<SavedTmuxFile> {
  const file = await readSavedTmux();
  const idx = file.sessions.findIndex(s => s.name === session.name);
  if (idx >= 0) file.sessions[idx] = session;
  else file.sessions.push(session);
  file.meta[session.name] = {
    savedAt: file.meta[session.name]?.savedAt ?? new Date().toISOString(),
    lastSeenAt,
  };
  await writeSavedTmux(file);
  return file;
}

/**
 * Forget a saved session. Returns true if anything was removed.
 */
export async function forgetSession(name: string): Promise<boolean> {
  const file = await readSavedTmux();
  const before = file.sessions.length;
  file.sessions = file.sessions.filter(s => s.name !== name);
  delete file.meta[name];
  if (file.sessions.length === before) return false;
  await writeSavedTmux(file);
  return true;
}
