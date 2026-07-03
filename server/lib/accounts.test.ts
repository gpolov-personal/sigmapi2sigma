import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveAccounts } from "./accounts.js";

const deps = (existing: string[]) => ({
  homedir: "/home/dsu",
  dirExists: (p: string) => existing.includes(p),
});

test("no config file falls back to a single default account at ~/.claude", () => {
  const accs = resolveAccounts(null, deps(["/home/dsu/.claude"]));
  assert.deepEqual(accs, [{
    name: "default",
    configDir: "/home/dsu/.claude",
    projectsDir: "/home/dsu/.claude/projects",
  }]);
});

test("valid two-account config expands ~ and derives projectsDir", () => {
  const raw = { accounts: [
    { name: "P", path: "~/.claude-personal" },
    { name: "W", path: "/home/dsu/.claude-work" },
  ]};
  const accs = resolveAccounts(raw, deps(["/home/dsu/.claude-personal", "/home/dsu/.claude-work"]));
  assert.equal(accs[0].configDir, "/home/dsu/.claude-personal");
  assert.equal(accs[0].projectsDir, "/home/dsu/.claude-personal/projects");
  assert.equal(accs[1].name, "W");
});

test("missing path directory is fatal", () => {
  const raw = { accounts: [{ name: "W", path: "~/.claude-work" }] };
  assert.throws(() => resolveAccounts(raw, deps([])), /account 'W' path does not exist/);
});

test("duplicate names are fatal", () => {
  const raw = { accounts: [
    { name: "P", path: "~/a" }, { name: "P", path: "~/b" },
  ]};
  assert.throws(() => resolveAccounts(raw, deps(["/home/dsu/a", "/home/dsu/b"])), /duplicate account name 'P'/);
});

test("empty accounts array is fatal", () => {
  assert.throws(() => resolveAccounts({ accounts: [] }, deps([])), /non-empty array/);
});

test("account without a name is fatal", () => {
  assert.throws(() => resolveAccounts({ accounts: [{ path: "~/a" }] }, deps(["/home/dsu/a"])), /non-empty 'name'/);
});
