export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
export async function getText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.text();
}
export async function postJSON<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

export interface ApiError { error: string; details?: any }
export interface ApiResult<T> { ok: boolean; status: number; body: T | ApiError }

export async function apiRequest<T>(
  method: string,
  url: string,
  body?: unknown
): Promise<ApiResult<T>> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: any = null;
  try {
    parsed = await r.json();
  } catch {
    parsed = null;
  }
  return { ok: r.ok, status: r.status, body: parsed };
}

export function isApiError<T>(r: ApiResult<T>): r is ApiResult<T> & { ok: false; body: ApiError } {
  return !r.ok;
}

export interface SessionMeta {
  id: string;
  jsonlPath: string;
  projectDir: string;
  cwd: string | null;
  lastCwd: string | null;
  gitBranch: string | null;
  version: string | null;
  permissionMode: string | null;
  mtime: number;
  size: number;
  firstTs: string | null;
  lastTs: string | null;
  lastUserPrompt: string | null;
  lastUserTs: string | null;
  /** Most recent (claudeSessionId, tmuxSession, window, pane) tuple ever observed for this session. */
  lastTmuxLocation: { tmuxSession: string; windowIndex: number; paneIndex: number; ts: string } | null;
}

export interface TmuxPane {
  index: number;
  paneId: string;
  pid: number;
  cmd: string;
  cwd: string;
  claudeLastCwd: string | null;
  claudeSessionId: string | null;
  claudePermissionMode: string | null;
}
export interface TmuxWindow { index: number; name: string; layout: string; panes: TmuxPane[]; }
export interface TmuxSession { name: string; windows: TmuxWindow[]; }
export interface TmuxResponse {
  source: "live" | "snapshot";
  tree: TmuxSession[];
  snapshot: { ts: string; sessions: TmuxSession[] } | null;
  snapshots: { ts: string; sessions: TmuxSession[] }[];
  livePaneIds: string[];
}

export interface ShellEntry {
  ts: string;
  tmuxSession?: string;
  tmuxPane?: string;
  cwd?: string;
  cmd?: string;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  tags: string[];
  notes: string;
  abbreviation: string | null;
  working_dir: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  system?: boolean;
}

export interface Task {
  id: string;
  project_id: string;
  name: string;
  notes: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export const FREE_PROJECT_ID = "free";

export type BeepSound = "classic" | "chime" | "soft";

export interface Settings {
  schemaVersion: number;
  workdayHours: number;
  defaultPomodoroDuration: number;
  restMinutes: number;
  startBeepSound: BeepSound;
  endBeepSound: BeepSound;
  audioEnabled: boolean;
  notificationsEnabled: boolean;
}

export interface Pomodoro {
  id: string;
  started_at: string;
  ended_at: string;
  target_duration_minutes: number;
  project_ids: string[];        // ≥1
  task_ids: string[];           // ≥0
  notes: string;
  /** Per-pomodoro task label for the Free project. Empty when Free isn't picked
   *  or the user didn't type a label. Renders as "Free › <label>" in chips. */
  freeTaskLabel: string;
  source: "live-timer" | "manual";
  context: {
    tmux_session_names: string[];
    claude_session_ids: string[];
  };
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

export interface CommandEntry {
  ts: string;
  tmuxSession: string;
  tmuxPane: string;
  cwd: string;
  cmd: string;
}

export interface ActivitySlice {
  pomodoroId: string;
  range: { from: string; to: string };
  conversations: ConversationActivity[];
  commands: CommandEntry[];
  warnings: string[];
}

export const PROJECT_PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#10b981", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
];

export interface SavedSessionMeta {
  savedAt: string;
  lastSeenAt: string;
}
export interface SavedTmuxFile {
  version: 1;
  ts: string;
  sessions: TmuxSession[];
  meta: Record<string, SavedSessionMeta>;
}
