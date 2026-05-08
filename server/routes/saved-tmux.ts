import { Router } from "express";
import { readSavedTmux } from "../lib/savedTmux.js";

export const savedTmuxRouter = Router();

savedTmuxRouter.get("/saved-tmux", async (_req, res) => {
  const file = await readSavedTmux();
  res.json(file);
});
