import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Account {
  name: string;
  configDir: string;   // absolute CLAUDE_CONFIG_DIR
  projectsDir: string; // configDir/projects
  /** Shell function/command that launches claude under this account (e.g. "claudew").
   *  When set, restore/resume invoke it instead of prefixing CLAUDE_CONFIG_DIR, so
   *  restored panes read identically to hand-launched ones. null → env-prefix form. */
  launcher: string | null;
}

/** A launcher is interpolated verbatim into a command string typed into a live
 *  shell, so it must be a bare command word — no whitespace, quoting or operators. */
const LAUNCHER_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function expandHomeIn(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

export interface ResolveDeps {
  homedir: string;
  dirExists: (p: string) => boolean;
}

/** Pure core: parsed accounts.json (or null if the file is absent) → validated
 *  account list, or throw on invalid config (decision A). */
export function resolveAccounts(raw: any | null, deps: ResolveDeps): Account[] {
  if (raw === null) {
    const configDir = path.join(deps.homedir, ".claude");
    return [{ name: "default", configDir, projectsDir: path.join(configDir, "projects"), launcher: null }];
  }
  if (typeof raw !== "object" || !Array.isArray(raw.accounts) || raw.accounts.length === 0) {
    throw new Error("accounts.json: 'accounts' must be a non-empty array");
  }
  const out: Account[] = [];
  const seen = new Set<string>();
  for (const a of raw.accounts) {
    if (!a || typeof a.name !== "string" || a.name.length === 0) {
      throw new Error("accounts.json: every account needs a non-empty 'name'");
    }
    if (typeof a.path !== "string" || a.path.length === 0) {
      throw new Error(`accounts.json: account '${a.name}' needs a non-empty 'path'`);
    }
    if (seen.has(a.name)) throw new Error(`accounts.json: duplicate account name '${a.name}'`);
    seen.add(a.name);
    let launcher: string | null = null;
    if (a.launcher !== undefined && a.launcher !== null) {
      if (typeof a.launcher !== "string" || !LAUNCHER_RE.test(a.launcher)) {
        throw new Error(
          `accounts.json: account '${a.name}' has an invalid 'launcher' — must be a bare command word like "claudew"`,
        );
      }
      launcher = a.launcher;
    }
    const configDir = path.resolve(expandHomeIn(a.path, deps.homedir));
    if (!deps.dirExists(configDir)) {
      throw new Error(`accounts.json: account '${a.name}' path does not exist: ${configDir}`);
    }
    out.push({ name: a.name, configDir, projectsDir: path.join(configDir, "projects"), launcher });
  }
  return out;
}

let cached: Account[] | null = null;

export function clearAccountsCache(): void { cached = null; }

export function loadAccounts(): Account[] {
  if (cached) return cached;
  const cfg = path.join(os.homedir(), ".sigmapi2sigma", "accounts.json");
  let raw: any | null = null;
  if (fs.existsSync(cfg)) {
    let txt: string;
    try { txt = fs.readFileSync(cfg, "utf8"); }
    catch (e: any) { throw new Error(`accounts.json: cannot read ${cfg}: ${e.message}`); }
    try { raw = JSON.parse(txt); }
    catch { throw new Error(`accounts.json: ${cfg} is not valid JSON`); }
  }
  cached = resolveAccounts(raw, {
    homedir: os.homedir(),
    dirExists: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  });
  return cached;
}

export function accountForConfigDir(dir: string): string | null {
  const target = path.resolve(dir);
  for (const a of loadAccounts()) if (a.configDir === target) return a.name;
  return null;
}
