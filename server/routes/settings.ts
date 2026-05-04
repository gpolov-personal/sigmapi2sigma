import { Router } from "express";
import { SETTINGS_FILE, readJsonSafe, writeJsonAtomic } from "../lib/dataStore.js";

export const settingsRouter = Router();

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

const DEFAULTS: Settings = {
  schemaVersion: 3,
  workdayHours: 8,
  defaultPomodoroDuration: 25,
  restMinutes: 5,
  startBeepSound: "soft",
  endBeepSound: "classic",
  audioEnabled: true,
  notificationsEnabled: true,
};

const BEEPS: BeepSound[] = ["classic", "chime", "soft"];

// Migrate legacy v1 (had wuMinutes) and v2 (had single beepSound) → v3.
function migrate(loaded: any): Settings {
  if (!loaded || typeof loaded !== "object") return { ...DEFAULTS };
  const merged: any = { ...DEFAULTS, ...loaded };
  delete merged.wuMinutes;
  // v2 → v3: split beepSound into startBeepSound + endBeepSound.
  if (merged.beepSound !== undefined) {
    if (loaded.endBeepSound === undefined) merged.endBeepSound = merged.beepSound;
    delete merged.beepSound;
  }
  if (!BEEPS.includes(merged.startBeepSound)) merged.startBeepSound = DEFAULTS.startBeepSound;
  if (!BEEPS.includes(merged.endBeepSound)) merged.endBeepSound = DEFAULTS.endBeepSound;
  merged.schemaVersion = 3;
  return merged as Settings;
}

async function loadOrInit(): Promise<Settings> {
  const cur = await readJsonSafe<Settings | null>(SETTINGS_FILE, null);
  if (cur === null) {
    await writeJsonAtomic(SETTINGS_FILE, DEFAULTS);
    return { ...DEFAULTS };
  }
  const migrated = migrate(cur);
  const dirty =
    migrated.schemaVersion !== (cur as any).schemaVersion ||
    (cur as any).wuMinutes !== undefined ||
    (cur as any).beepSound !== undefined;
  if (dirty) await writeJsonAtomic(SETTINGS_FILE, migrated);
  return migrated;
}

function validate(patch: any): { error: string } | null {
  if (patch.workdayHours !== undefined) {
    if (typeof patch.workdayHours !== "number" || patch.workdayHours < 1 || patch.workdayHours > 24) {
      return { error: "workdayHours must be number 1-24" };
    }
  }
  if (patch.defaultPomodoroDuration !== undefined) {
    if (
      !Number.isInteger(patch.defaultPomodoroDuration) ||
      patch.defaultPomodoroDuration < 1 ||
      patch.defaultPomodoroDuration > 180
    ) {
      return { error: "defaultPomodoroDuration must be integer 1-180" };
    }
  }
  if (patch.restMinutes !== undefined) {
    if (!Number.isInteger(patch.restMinutes) || patch.restMinutes < 1 || patch.restMinutes > 60) {
      return { error: "restMinutes must be integer 1-60" };
    }
  }
  if (patch.startBeepSound !== undefined && !BEEPS.includes(patch.startBeepSound)) {
    return { error: `startBeepSound must be one of: ${BEEPS.join(", ")}` };
  }
  if (patch.endBeepSound !== undefined && !BEEPS.includes(patch.endBeepSound)) {
    return { error: `endBeepSound must be one of: ${BEEPS.join(", ")}` };
  }
  if (patch.audioEnabled !== undefined && typeof patch.audioEnabled !== "boolean") {
    return { error: "audioEnabled must be boolean" };
  }
  if (
    patch.notificationsEnabled !== undefined &&
    typeof patch.notificationsEnabled !== "boolean"
  ) {
    return { error: "notificationsEnabled must be boolean" };
  }
  return null;
}

settingsRouter.get("/settings", async (_req, res) => {
  const s = await loadOrInit();
  res.json(s);
});

settingsRouter.put("/settings", async (req, res) => {
  const body = req.body ?? {};
  const err = validate(body);
  if (err) return res.status(400).json(err);
  const cur = await loadOrInit();
  const next: Settings = {
    ...cur,
    ...(body.workdayHours !== undefined ? { workdayHours: body.workdayHours } : {}),
    ...(body.defaultPomodoroDuration !== undefined
      ? { defaultPomodoroDuration: body.defaultPomodoroDuration }
      : {}),
    ...(body.restMinutes !== undefined ? { restMinutes: body.restMinutes } : {}),
    ...(body.startBeepSound !== undefined ? { startBeepSound: body.startBeepSound } : {}),
    ...(body.endBeepSound !== undefined ? { endBeepSound: body.endBeepSound } : {}),
    ...(body.audioEnabled !== undefined ? { audioEnabled: body.audioEnabled } : {}),
    ...(body.notificationsEnabled !== undefined
      ? { notificationsEnabled: body.notificationsEnabled }
      : {}),
  };
  await writeJsonAtomic(SETTINGS_FILE, next);
  res.json(next);
});
