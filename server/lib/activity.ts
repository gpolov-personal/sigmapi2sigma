import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./pathEncoding.js";
import { listAllSessionFiles, readMessagesInRange, JsonlMessage } from "./jsonl.js";

export interface CommandEntry {
  ts: string;
  tmuxSession: string;
  tmuxPane: string;
  cwd: string;
  cmd: string;
}

export interface ConversationActivity {
  sessionId: string;
  cwd: string | null;
  jsonlPath: string;
  userPromptCount: number;
  totalMessageCount: number;
  firstUserPrompt: string | null;
  lastUserPrompt: string | null;
  allUserPrompts: { ts: string; preview: string }[];
  truncated: boolean;
  durationMinutes: number;
}

export interface ActivitySlice {
  pomodoroId: string;
  range: { from: string; to: string };
  conversations: ConversationActivity[];
  commands: CommandEntry[];
  warnings: string[];
}

const PROMPT_PREVIEW_CHARS = 200;
const MAX_PROMPTS = 100;

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateRangeFiles(from: Date, to: Date): string[] {
  const files: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cur.getTime() <= end.getTime()) {
    files.push(`${dateOnly(cur)}.jsonl`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return files;
}

async function loadCommandsInRange(
  fromIso: string,
  toIso: string,
  tmuxSessionNames: Set<string>
): Promise<{ commands: CommandEntry[]; installed: boolean }> {
  const dir = path.join(DATA_DIR, "shell-history");
  let allFiles: string[];
  try {
    allFiles = (await fs.readdir(dir)).filter(f => f.endsWith(".jsonl"));
  } catch {
    return { commands: [], installed: false };
  }
  const candidates = new Set(dateRangeFiles(new Date(fromIso), new Date(toIso)));
  const targetFiles = allFiles.filter(f => candidates.has(f));

  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);

  const out: CommandEntry[] = [];
  for (const f of targetFiles) {
    let text: string;
    try { text = await fs.readFile(path.join(dir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let j: any; try { j = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(j.ts ?? "");
      if (!Number.isFinite(ts) || ts < from || ts > to) continue;
      if (tmuxSessionNames.size > 0 && !tmuxSessionNames.has(j.tmuxSession)) continue;
      out.push({
        ts: j.ts,
        tmuxSession: j.tmuxSession ?? "",
        tmuxPane: j.tmuxPane ?? "",
        cwd: j.cwd ?? "",
        cmd: j.cmd ?? "",
      });
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return { commands: out, installed: true };
}

function extractUserPromptText(m: JsonlMessage): string | null {
  if (m.type !== "user") return null;
  const c = m.message?.content;
  if (typeof c === "string" && c.length > 0) return c;
  if (Array.isArray(c)) {
    const text = c
      .filter((x: any) => x?.type === "text" && typeof x.text === "string")
      .map((x: any) => x.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return null;
}

async function buildConversationActivity(
  jsonlPath: string,
  sessionId: string,
  fromIso: string,
  toIso: string
): Promise<ConversationActivity | null> {
  const events = await readMessagesInRange(jsonlPath, fromIso, toIso);
  if (events.length === 0) return null;

  let cwd: string | null = null;
  for (const e of events) if (typeof e.cwd === "string") { cwd = e.cwd; break; }

  const userPrompts: { ts: string; preview: string }[] = [];
  let firstUserPrompt: string | null = null;
  let lastUserPrompt: string | null = null;
  let userPromptCount = 0;

  for (const e of events) {
    const txt = extractUserPromptText(e);
    if (!txt) continue;
    userPromptCount++;
    if (firstUserPrompt === null) firstUserPrompt = txt;
    lastUserPrompt = txt;
    if (userPrompts.length < MAX_PROMPTS) {
      userPrompts.push({
        ts: e.timestamp ?? "",
        preview: txt.length > PROMPT_PREVIEW_CHARS ? txt.slice(0, PROMPT_PREVIEW_CHARS) : txt,
      });
    }
  }

  const tsList = events.map(e => Date.parse(e.timestamp ?? "")).filter(Number.isFinite) as number[];
  const span = tsList.length > 1 ? Math.max(0, Math.max(...tsList) - Math.min(...tsList)) : 0;
  const durationMinutes = span / 60_000;

  return {
    sessionId,
    cwd,
    jsonlPath,
    userPromptCount,
    totalMessageCount: events.length,
    firstUserPrompt,
    lastUserPrompt,
    allUserPrompts: userPrompts,
    truncated: userPromptCount > MAX_PROMPTS,
    durationMinutes,
  };
}

export async function computeActivitySlice(
  pomodoroId: string,
  fromIso: string,
  toIso: string,
  tmuxSessionNames: string[],
  claudeSessionIds: string[]
): Promise<ActivitySlice> {
  const warnings: string[] = [];
  const tmuxSet = new Set(tmuxSessionNames);

  const cmdsP = loadCommandsInRange(fromIso, toIso, tmuxSet);

  const allFiles = await listAllSessionFiles();
  const fileBySid = new Map<string, string>();
  for (const f of allFiles) {
    const id = path.basename(f, ".jsonl");
    fileBySid.set(id, f);
  }

  const conversations: ConversationActivity[] = [];
  for (const sid of claudeSessionIds) {
    const file = fileBySid.get(sid);
    if (!file) {
      warnings.push(`session ${sid}: jsonl not found`);
      continue;
    }
    const ca = await buildConversationActivity(file, sid, fromIso, toIso);
    if (ca) conversations.push(ca);
  }

  const { commands, installed } = await cmdsP;
  if (!installed) {
    warnings.push("shell-hook not installed; commands list may be empty");
  }
  if (claudeSessionIds.length === 0) {
    warnings.push("no claude sessions captured at pomodoro start; conversations slice empty");
  }

  return {
    pomodoroId,
    range: { from: fromIso, to: toIso },
    conversations,
    commands,
    warnings,
  };
}
