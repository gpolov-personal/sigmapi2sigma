import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { loadAccounts } from "./accounts.js";

export interface SessionMeta {
  id: string;
  jsonlPath: string;
  projectDir: string;
  cwd: string | null;         // Launch cwd (LWD)
  lastCwd: string | null;     // Most recent cwd captured on any message (CWD)
  gitBranch: string | null;
  version: string | null;
  permissionMode: string | null; // e.g. "bypassPermissions", "default", "acceptEdits"
  mtime: number;
  size: number;
  firstTs: string | null;
  lastTs: string | null;
  lastUserPrompt: string | null;
  lastUserTs: string | null;
  accounts: string[];   // account names whose dirs hold this UUID; [] until attached by caller
}

function safeParse(line: string): any | null {
  try { return JSON.parse(line); } catch { return null; }
}

// Read first ~16KB to extract cwd/gitBranch/version from the first user message.
async function readHeader(fd: fsSync.promises.FileHandle, size: number) {
  const n = Math.min(size, 16 * 1024);
  const buf = Buffer.alloc(n);
  await fd.read(buf, 0, n, 0);
  const lines = buf.toString("utf8").split("\n");
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let firstTs: string | null = null;
  let permissionMode: string | null = null;
  for (const raw of lines) {
    if (!raw) continue;
    const j = safeParse(raw);
    if (!j) continue;
    if (!firstTs && typeof j.timestamp === "string") firstTs = j.timestamp;
    if (j.cwd && !cwd) cwd = j.cwd;
    if (j.gitBranch && !gitBranch) gitBranch = j.gitBranch;
    if (j.version && !version) version = j.version;
    if (typeof j.permissionMode === "string" && !permissionMode) permissionMode = j.permissionMode;
    if (cwd && gitBranch && version && firstTs && permissionMode) break;
  }
  return { cwd, gitBranch, version, firstTs, permissionMode };
}

// Tail-read last N bytes and walk lines backward to find the last user prompt
// (type:"user" with string message.content).
async function readTail(fd: fsSync.promises.FileHandle, size: number) {
  const n = Math.min(size, 512 * 1024);
  const start = size - n;
  const buf = Buffer.alloc(n);
  await fd.read(buf, 0, n, start);
  const text = buf.toString("utf8");
  const lines = text.split("\n").filter(Boolean);
  // Skip the first (possibly truncated) partial line.
  const safeLines = start > 0 ? lines.slice(1) : lines;

  let lastTs: string | null = null;
  let lastCwd: string | null = null;
  let lastUserPrompt: string | null = null;
  let lastUserTs: string | null = null;

  for (let i = safeLines.length - 1; i >= 0; i--) {
    const j = safeParse(safeLines[i]);
    if (!j) continue;
    if (!lastTs && typeof j.timestamp === "string") lastTs = j.timestamp;
    if (!lastCwd && typeof j.cwd === "string") lastCwd = j.cwd;
    if (
      !lastUserPrompt &&
      j.type === "user" &&
      j.message &&
      typeof j.message.content === "string" &&
      j.message.content.length > 0
    ) {
      lastUserPrompt = j.message.content;
      lastUserTs = typeof j.timestamp === "string" ? j.timestamp : null;
    }
    if (lastTs && lastCwd && lastUserPrompt) break;
  }
  return { lastTs, lastCwd, lastUserPrompt, lastUserTs };
}

const cache = new Map<string, { key: string; value: SessionMeta }>();

export async function readSessionMeta(jsonlPath: string): Promise<SessionMeta | null> {
  let stat;
  try { stat = await fs.stat(jsonlPath); } catch { return null; }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(jsonlPath);
  if (cached && cached.key === key) return cached.value;

  if (stat.size === 0) return null;

  const fd = await fs.open(jsonlPath, "r");
  try {
    const [{ cwd, gitBranch, version, firstTs, permissionMode }, { lastTs, lastCwd, lastUserPrompt, lastUserTs }] =
      await Promise.all([readHeader(fd, stat.size), readTail(fd, stat.size)]);

    const id = path.basename(jsonlPath, ".jsonl");
    const projectDir = path.basename(path.dirname(jsonlPath));
    const meta: SessionMeta = {
      id,
      jsonlPath,
      projectDir,
      cwd,
      lastCwd: lastCwd ?? cwd,
      gitBranch,
      version,
      permissionMode,
      mtime: stat.mtimeMs,
      size: stat.size,
      firstTs,
      lastTs,
      lastUserPrompt,
      lastUserTs,
      accounts: [],
    };
    cache.set(jsonlPath, { key, value: meta });
    return meta;
  } finally {
    await fd.close();
  }
}

export interface TaggedFile { path: string; account: string; }

// Every top-level session jsonl across all configured accounts, tagged by account.
export async function listAllSessionFiles(): Promise<TaggedFile[]> {
  const out: TaggedFile[] = [];
  for (const acc of loadAccounts()) {
    let entries;
    try { entries = await fs.readdir(acc.projectsDir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const proj = path.join(acc.projectsDir, e.name);
      let files;
      try { files = await fs.readdir(proj); } catch { continue; }
      for (const f of files) if (f.endsWith(".jsonl")) out.push({ path: path.join(proj, f), account: acc.name });
    }
  }
  return out;
}

export interface DedupedSession { id: string; path: string; accounts: string[]; }

// Pure grouping helper (unit-tested): one entry per UUID, accounts = sorted set,
// representative path = newest mtime (surfaces the active side of a diverged copy).
export function dedupeTaggedFiles(
  rows: { id: string; path: string; account: string; mtime: number }[]
): DedupedSession[] {
  const byId = new Map<string, { path: string; mtime: number; accounts: Set<string> }>();
  for (const r of rows) {
    const cur = byId.get(r.id);
    if (!cur) byId.set(r.id, { path: r.path, mtime: r.mtime, accounts: new Set([r.account]) });
    else { cur.accounts.add(r.account); if (r.mtime > cur.mtime) { cur.mtime = r.mtime; cur.path = r.path; } }
  }
  return [...byId.entries()].map(([id, v]) => ({ id, path: v.path, accounts: [...v.accounts].sort() }));
}

// Deduped sessions across all accounts.
export async function listDedupedSessions(): Promise<DedupedSession[]> {
  const tagged = await listAllSessionFiles();
  const rows: { id: string; path: string; account: string; mtime: number }[] = [];
  for (const t of tagged) {
    let mtime = 0;
    try { mtime = (await fs.stat(t.path)).mtimeMs; } catch { continue; }
    rows.push({ id: path.basename(t.path, ".jsonl"), path: t.path, account: t.account, mtime });
  }
  return dedupeTaggedFiles(rows);
}

export interface JsonlMessage {
  type: string;
  message?: { role?: string; content?: any };
  timestamp?: string;
  cwd?: string;
  [k: string]: any;
}

// Return all parseable events whose timestamp falls in [fromIso, toIso].
// Events without a parseable timestamp are skipped (e.g. file-history-snapshot).
export async function readMessagesInRange(
  jsonlPath: string,
  fromIso: string,
  toIso: string
): Promise<JsonlMessage[]> {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  let text: string;
  try { text = await fs.readFile(jsonlPath, "utf8"); } catch { return []; }
  const out: JsonlMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const j = safeParse(line);
    if (!j) continue;
    if (typeof j.timestamp !== "string") continue;
    const t = Date.parse(j.timestamp);
    if (!Number.isFinite(t)) continue;
    if (t < from || t > to) continue;
    out.push(j);
  }
  return out;
}

// Read the full conversation for detail view (first+last N messages).
export async function readSessionDetail(jsonlPath: string, limit = 40) {
  const content = await fs.readFile(jsonlPath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const messages: any[] = [];
  for (const line of lines) {
    const j = safeParse(line);
    if (!j) continue;
    if (j.type === "user" || j.type === "assistant") messages.push(j);
  }
  return {
    totalMessages: messages.length,
    head: messages.slice(0, limit),
    tail: messages.slice(-limit),
  };
}
