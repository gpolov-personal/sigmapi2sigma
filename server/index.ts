import express from "express";
import { sessionsRouter } from "./routes/sessions.js";
import { tmuxRouter } from "./routes/tmux.js";
import { shellHistoryRouter } from "./routes/shell-history.js";
import { snapshotsRouter } from "./routes/snapshots.js";
import { savedTmuxRouter } from "./routes/saved-tmux.js";
import { projectsRouter } from "./routes/projects.js";
import { tasksRouter } from "./routes/tasks.js";
import { assignmentsRouter } from "./routes/assignments.js";
import { settingsRouter } from "./routes/settings.js";
import { pomodorosRouter } from "./routes/pomodoros.js";
import { backupsRouter } from "./routes/backups.js";
import { accountsRouter } from "./routes/accounts.js";
import { loadAccounts } from "./lib/accounts.js";

const app = express();

// Validate account config before serving. Bad accounts.json is fatal (decision A).
try {
  const accounts = loadAccounts();
  console.log(`sigmapi2sigma accounts: ${accounts.map(a => `${a.name}→${a.configDir}`).join(", ")}`);
} catch (e: any) {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
}

app.use(express.json({ limit: "1mb" }));

app.use("/api", sessionsRouter);
app.use("/api", tmuxRouter);
app.use("/api", shellHistoryRouter);
app.use("/api", snapshotsRouter);
app.use("/api", projectsRouter);
app.use("/api", tasksRouter);
app.use("/api", assignmentsRouter);
app.use("/api", settingsRouter);
app.use("/api", pomodorosRouter);
app.use("/api", backupsRouter);
app.use("/api", savedTmuxRouter);
app.use("/api", accountsRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 5174);
app.listen(PORT, HOST, () => {
  console.log(`sigmapi2sigma backend http://${HOST}:${PORT}`);
});
