import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { BeepSound } from "../api";
import { useSettings } from "../SettingsContext";

interface Props { open: boolean; onClose: () => void; }

const BEEP_OPTIONS: { value: BeepSound; label: string }[] = [
  { value: "classic", label: "Classic — 600 Hz double beep" },
  { value: "chime",   label: "Chime — three ascending tones" },
  { value: "soft",    label: "Soft — gentle 440 Hz" },
];

export function SettingsModal({ open, onClose }: Props) {
  const { settings, save } = useSettings();
  const [workdayHours, setWorkdayHours] = useState(settings.workdayHours);
  const [defaultPomodoroDuration, setDefaultPomodoroDuration] = useState(settings.defaultPomodoroDuration);
  const [restMinutes, setRestMinutes] = useState(settings.restMinutes);
  const [startBeepSound, setStartBeepSound] = useState<BeepSound>(settings.startBeepSound);
  const [endBeepSound, setEndBeepSound] = useState<BeepSound>(settings.endBeepSound);
  const [audioEnabled, setAudioEnabled] = useState(settings.audioEnabled);
  const [notificationsEnabled, setNotificationsEnabled] = useState(settings.notificationsEnabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setWorkdayHours(settings.workdayHours);
      setDefaultPomodoroDuration(settings.defaultPomodoroDuration);
      setRestMinutes(settings.restMinutes);
      setStartBeepSound(settings.startBeepSound);
      setEndBeepSound(settings.endBeepSound);
      setAudioEnabled(settings.audioEnabled);
      setNotificationsEnabled(settings.notificationsEnabled);
      setError(null);
    }
  }, [open, settings]);

  if (!open) return null;

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      await save({
        workdayHours,
        defaultPomodoroDuration,
        restMinutes,
        startBeepSound,
        endBeepSound,
        audioEnabled,
        notificationsEnabled,
      });
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function preview(sound: BeepSound) {
    import("../lib/liveTimer").then(m => m.playBeep(sound));
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-md bg-slate-900 border-l border-slate-700 p-6 overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm text-slate-300">Workday hours (1 workday = N h)</span>
            <input
              type="number" min={1} max={24} step={0.5} value={workdayHours}
              onChange={e => setWorkdayHours(Number(e.target.value))}
              className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">Default pomodoro duration (min)</span>
            <input
              type="number" min={1} max={180} value={defaultPomodoroDuration}
              onChange={e => setDefaultPomodoroDuration(Number(e.target.value))}
              className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">Rest duration (min)</span>
            <input
              type="number" min={1} max={60} value={restMinutes}
              onChange={e => setRestMinutes(Number(e.target.value))}
              className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">Start beep (when a pomodoro starts)</span>
            <div className="mt-1 flex gap-2">
              <select
                value={startBeepSound}
                onChange={e => setStartBeepSound(e.target.value as BeepSound)}
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
              >
                {BEEP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button
                onClick={() => preview(startBeepSound)}
                className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded"
              >Preview</button>
            </div>
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">End beep (pomodoro / rest finished)</span>
            <div className="mt-1 flex gap-2">
              <select
                value={endBeepSound}
                onChange={e => setEndBeepSound(e.target.value as BeepSound)}
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
              >
                {BEEP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button
                onClick={() => preview(endBeepSound)}
                className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded"
              >Preview</button>
            </div>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox" checked={audioEnabled}
              onChange={e => setAudioEnabled(e.target.checked)}
            />
            <span className="text-sm text-slate-300">Audio beeps</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox" checked={notificationsEnabled}
              onChange={e => setNotificationsEnabled(e.target.checked)}
            />
            <span className="text-sm text-slate-300">Browser notifications on auto-stop</span>
          </label>
          {error && <div className="text-sm text-red-400">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button
              disabled={busy}
              onClick={handleSave}
              className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50"
            >Save</button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-white text-sm"
            >Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
