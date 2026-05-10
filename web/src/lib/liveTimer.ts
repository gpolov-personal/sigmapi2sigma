// localStorage-backed live pomodoro timer + browser notifications + Web Audio beep.

const KEY = "csv:active-pomodoro";
const REST_KEY = "csv:active-rest";

export interface LiveRestState {
  restEndsAt: number;
  proposal: { projectIds: string[]; taskIds: string[]; durationMinutes: number; freeTaskLabel?: string };
}

export function loadRest(): LiveRestState | null {
  try {
    const raw = localStorage.getItem(REST_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (
      typeof v?.restEndsAt === "number" &&
      v?.proposal &&
      Array.isArray(v.proposal.projectIds) &&
      Array.isArray(v.proposal.taskIds) &&
      typeof v.proposal.durationMinutes === "number"
    ) {
      return {
        restEndsAt: v.restEndsAt,
        proposal: {
          projectIds: v.proposal.projectIds,
          taskIds: v.proposal.taskIds,
          durationMinutes: v.proposal.durationMinutes,
          freeTaskLabel: typeof v.proposal.freeTaskLabel === "string" ? v.proposal.freeTaskLabel : "",
        },
      };
    }
  } catch {}
  return null;
}

export function saveRest(s: LiveRestState): void {
  try { localStorage.setItem(REST_KEY, JSON.stringify(s)); } catch {}
}

export function clearRest(): void {
  try { localStorage.removeItem(REST_KEY); } catch {}
}

export interface LiveTimerState {
  startedAt: number;
  targetDurationMinutes: number;
  topicIds: string[];        // legacy field name kept for backwards compat: holds project IDs
  taskIds?: string[];        // optional, defaults to [] on load
  freeTaskLabel?: string;    // optional Free-project label, defaults to "" on load
}

export function loadActive(): LiveTimerState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (
      typeof v?.startedAt === "number" &&
      typeof v?.targetDurationMinutes === "number" &&
      Array.isArray(v?.topicIds)
    ) {
      return {
        startedAt: v.startedAt,
        targetDurationMinutes: v.targetDurationMinutes,
        topicIds: v.topicIds,
        taskIds: Array.isArray(v.taskIds) ? v.taskIds : [],
        freeTaskLabel: typeof v.freeTaskLabel === "string" ? v.freeTaskLabel : "",
      };
    }
  } catch {}
  return null;
}

export function saveActive(s: LiveTimerState): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

export function clearActive(): void {
  try { localStorage.removeItem(KEY); } catch {}
}

export function fmtMmSs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

let _audioCtx: AudioContext | null = null;
function getAudio(): AudioContext | null {
  try {
    if (!_audioCtx) {
      const Ctor: any = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctor) return null;
      _audioCtx = new Ctor();
    }
    return _audioCtx;
  } catch { return null; }
}

export type BeepSound = "classic" | "chime" | "soft";

function tone(freq: number, duration = 0.18, volume = 0.2, type: OscillatorType = "sine", delay = 0): void {
  const ctx = getAudio();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.value = volume;
    osc.connect(gain).connect(ctx.destination);
    const t0 = ctx.currentTime + delay;
    osc.start(t0);
    osc.stop(t0 + duration);
  } catch {}
}

export function playBeep(sound: BeepSound = "classic"): void {
  switch (sound) {
    case "classic":
      tone(600, 0.18, 0.2, "sine", 0);
      tone(600, 0.18, 0.2, "sine", 0.25);
      return;
    case "chime":
      tone(660, 0.16, 0.18, "triangle", 0);
      tone(820, 0.16, 0.18, "triangle", 0.18);
      tone(990, 0.22, 0.18, "triangle", 0.36);
      return;
    case "soft":
      tone(440, 0.55, 0.14, "sine", 0);
      return;
  }
}

// Lightweight unlock/preview tap (used to unlock AudioContext on first user gesture).
export function audioPing(): void {
  tone(440, 0.05, 0.05, "sine", 0);
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const r = await Notification.requestPermission();
    return r === "granted";
  } catch { return false; }
}

export function notify(title: string, body: string): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try { new Notification(title, { body }); } catch {}
}
