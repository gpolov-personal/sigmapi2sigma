import { useEffect, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { Sessions } from "./pages/Sessions";
import { TmuxMap } from "./pages/TmuxMap";
import { ShellHistory } from "./pages/ShellHistory";
import { Snapshots } from "./pages/Snapshots";
import { Projects } from "./pages/Projects";
import { PomodoroPage } from "./pages/Pomodoro";
import { Calendar } from "./pages/Calendar";
import { SettingsProvider } from "./SettingsContext";
import { ProjectsProvider } from "./ProjectsContext";
import { SettingsModal } from "./components/SettingsModal";
import { fmtMmSs, loadActive, loadRest } from "./lib/liveTimer";

type Tab = "sessions" | "tmux" | "shell" | "snapshots" | "projects" | "pomodoro" | "calendar";

const TABS: { id: Tab; label: string }[] = [
  { id: "sessions", label: "Sessions" },
  { id: "tmux", label: "Tmux Map" },
  { id: "shell", label: "Shell History" },
  { id: "snapshots", label: "Snapshots" },
  { id: "projects", label: "Projects" },
  { id: "pomodoro", label: "Pomodoro" },
  { id: "calendar", label: "Calendar" },
];

// Compute the dynamic suffix for the Pomodoro tab (Work / Break / Done countdown).
// Reads localStorage every tick; cheap (~µs).
function usePomodoroTabLabel(): string {
  const [label, setLabel] = useState("Pomodoro");
  useEffect(() => {
    const tick = () => {
      const rest = loadRest();
      if (rest) {
        const remaining = rest.restEndsAt - Date.now();
        if (remaining > 0) { setLabel(`Pomodoro · Break ${fmtMmSs(remaining)}`); return; }
        setLabel("Pomodoro · Break done"); return;
      }
      const active = loadActive();
      if (active) {
        const targetMs = active.targetDurationMinutes * 60_000;
        const remaining = targetMs - (Date.now() - active.startedAt);
        if (remaining > 0) { setLabel(`Pomodoro · Work ${fmtMmSs(remaining)}`); return; }
        setLabel("Pomodoro · Done"); return;
      }
      setLabel("Pomodoro");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return label;
}

export function App() {
  return (
    <SettingsProvider>
      <ProjectsProvider>
        <AppInner />
      </ProjectsProvider>
    </SettingsProvider>
  );
}

function AppInner() {
  const [tab, setTab] = useState<Tab>("sessions");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pomodoroLabel = usePomodoroTabLabel();
  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-6 px-6 py-3 border-b border-slate-800 bg-slate-900">
        <h1 className="font-serif text-2xl tracking-tight text-white">
          ΣΠ <span className="text-slate-500">∪</span> ΠΣ
        </h1>
        <nav className="flex gap-1">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded text-sm ${
                tab === t.id
                  ? "bg-slate-700 text-white"
                  : "text-slate-400 hover:text-white hover:bg-slate-800"
              }`}
            >
              {t.id === "pomodoro" ? pomodoroLabel : t.label}
            </button>
          ))}
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-800"
        >
          <SettingsIcon size={18} />
        </button>
      </header>
      <main className="flex-1 overflow-auto p-6">
        {tab === "sessions" && <Sessions />}
        {tab === "tmux" && <TmuxMap />}
        {tab === "shell" && <ShellHistory />}
        {tab === "snapshots" && <Snapshots />}
        {tab === "projects" && <Projects />}
        {tab === "pomodoro" && <PomodoroPage />}
        {tab === "calendar" && <Calendar />}
      </main>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
