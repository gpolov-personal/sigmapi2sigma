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

type Group = { label: string; tabs: { id: Tab; label: string }[]; demoted?: boolean };

const NAV_GROUPS: Group[] = [
  {
    label: "WORK",
    tabs: [
      { id: "projects",  label: "Projects" },
      { id: "pomodoro",  label: "Pomodoro" },
      { id: "calendar",  label: "Calendar" },
    ],
  },
  {
    label: "ENVIRONMENT",
    tabs: [
      { id: "sessions",  label: "Sessions" },
      { id: "tmux",      label: "Tmux Map" },
    ],
  },
  {
    label: "TOOLS",
    demoted: true,
    tabs: [
      { id: "snapshots", label: "Snapshots" },
      { id: "shell",     label: "Shell History" },
    ],
  },
];

// Compute the dynamic suffix for the Pomodoro tab (Work / Break / Done countdown).
// Reads localStorage every tick; cheap (~µs).
function usePomodoroTabLabel(): string {
  const [label, setLabel] = useState("Pomodoro");
  useEffect(() => {
    const tick = () => {
      const rest = loadRest();
      if (rest) {
        const isPaused = !!rest.pausedAt;
        const reference = rest.pausedAt ?? Date.now();
        const remaining = rest.restEndsAt - reference;
        const prefix = isPaused ? "Pomodoro · ⏸ Break" : "Pomodoro · Break";
        if (remaining > 0) { setLabel(`${prefix} ${fmtMmSs(remaining)}`); return; }
        setLabel("Pomodoro · Break done"); return;
      }
      const active = loadActive();
      if (active) {
        const isPaused = !!active.pausedAt;
        const accumulatedPausedMs = active.accumulatedPausedMs ?? 0;
        const reference = active.pausedAt ?? Date.now();
        const targetAt = active.startedAt + accumulatedPausedMs + active.targetDurationMinutes * 60_000;
        const remaining = targetAt - reference;
        const prefix = isPaused ? "Pomodoro · ⏸ Work" : "Pomodoro · Work";
        if (remaining > 0) { setLabel(`${prefix} ${fmtMmSs(remaining)}`); return; }
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
  const [tab, setTab] = useState<Tab>("pomodoro");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pomodoroLabel = usePomodoroTabLabel();
  return (
    <div className="flex flex-col h-full">
      <header className="flex flex-col border-b border-slate-800 bg-slate-900">
        <div className="flex items-center gap-6 px-6 pt-3 pb-2">
          <h1 className="font-serif text-2xl tracking-tight text-white">
            ΣΠ <span className="text-slate-500">∪</span> ΠΣ
          </h1>
          <div className="flex-1" />
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-800"
          >
            <SettingsIcon size={18} />
          </button>
        </div>
        <nav className="flex items-end px-6 pb-2 gap-4">
          {NAV_GROUPS.map((g, i) => (
            <NavGroup
              key={g.label}
              group={g}
              activeTab={tab}
              onSelect={setTab}
              pomodoroLabel={pomodoroLabel}
              showDividerBefore={i > 0}
            />
          ))}
        </nav>
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

function NavGroup({
  group,
  activeTab,
  onSelect,
  pomodoroLabel,
  showDividerBefore,
}: {
  group: Group;
  activeTab: Tab;
  onSelect: (t: Tab) => void;
  pomodoroLabel: string;
  showDividerBefore: boolean;
}) {
  const demoted = !!group.demoted;
  const labelClass = "text-[10px] uppercase tracking-wider text-slate-500 mb-0.5";
  const tabBase = demoted
    ? "px-2 py-1 rounded text-xs"
    : "px-3 py-1.5 rounded text-sm";
  const tabIdle = demoted
    ? "text-slate-600 hover:text-white hover:bg-slate-800"
    : "text-slate-400 hover:text-white hover:bg-slate-800";
  const tabActive = "bg-slate-700 text-white";

  return (
    <div
      className={[
        "flex flex-col",
        showDividerBefore ? "border-l border-slate-800 pl-4" : "",
        demoted ? "ml-auto" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className={labelClass}>{group.label}</div>
      <div className="flex gap-1 flex-wrap">
        {group.tabs.map(t => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`${tabBase} ${activeTab === t.id ? tabActive : tabIdle}`}
          >
            {t.id === "pomodoro" ? pomodoroLabel : t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
