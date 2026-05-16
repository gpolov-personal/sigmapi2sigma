import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";
import { apiRequest, Settings } from "./api";

const DEFAULTS: Settings = {
  schemaVersion: 4,
  workdayHours: 8,
  defaultPomodoroDuration: 25,
  restMinutes: 5,
  startBeepSound: "soft",
  endBeepSound: "classic",
  audioEnabled: true,
  notificationsEnabled: true,
  activeWindowHours: 72,
};

interface Ctx {
  settings: Settings;
  refresh: () => Promise<void>;
  save: (patch: Partial<Settings>) => Promise<void>;
}

const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);

  const refresh = useCallback(async () => {
    const r = await apiRequest<Settings>("GET", "/api/settings");
    if (r.ok) setSettings(r.body as Settings);
  }, []);

  const save = useCallback(async (patch: Partial<Settings>) => {
    const r = await apiRequest<Settings>("PUT", "/api/settings", patch);
    if (r.ok) setSettings(r.body as Settings);
    else throw new Error((r.body as { error: string }).error);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <SettingsContext.Provider value={{ settings, refresh, save }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside SettingsProvider");
  return ctx;
}
