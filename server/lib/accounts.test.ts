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
    launcher: null,
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

test("launcher is optional and defaults to null", () => {
  const raw = { accounts: [{ name: "P", path: "~/.claude-personal" }] };
  const accs = resolveAccounts(raw, deps(["/home/dsu/.claude-personal"]));
  assert.equal(accs[0].launcher, null);
});

test("valid launcher is carried through", () => {
  const raw = { accounts: [{ name: "W", path: "~/.claude-work", launcher: "claudew" }] };
  const accs = resolveAccounts(raw, deps(["/home/dsu/.claude-work"]));
  assert.equal(accs[0].launcher, "claudew");
});

test("launcher with shell metacharacters is fatal", () => {
  // The launcher is interpolated into a command string sent to a live shell via
  // tmux send-keys, so anything but a bare command word must be rejected here.
  for (const bad of ["claudew; rm -rf /", "claude w", "$(id)", "claude|x", ""]) {
    const raw = { accounts: [{ name: "W", path: "~/.claude-work", launcher: bad }] };
    assert.throws(
      () => resolveAccounts(raw, deps(["/home/dsu/.claude-work"])),
      /account 'W' has an invalid 'launcher'/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("non-string launcher is fatal", () => {
  const raw = { accounts: [{ name: "W", path: "~/.claude-work", launcher: 42 }] };
  assert.throws(
    () => resolveAccounts(raw, deps(["/home/dsu/.claude-work"])),
    /account 'W' has an invalid 'launcher'/,
  );
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
