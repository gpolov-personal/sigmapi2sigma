import { Router } from "express";
import { loadAccounts } from "../lib/accounts.js";

export const accountsRouter = Router();

// Exposes account names and their launcher (claudep/claudew) so the UI can render
// resume commands in the same form the user types by hand. configDir is deliberately
// not returned — the UI never needs the path, only how to launch.
accountsRouter.get("/accounts", (_req, res) => {
  res.json({
    accounts: loadAccounts().map(a => ({ name: a.name, launcher: a.launcher })),
  });
});
