import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeTaggedFiles, pickTitles, resolveActivityMs } from "./jsonl.js";

test("dedupeTaggedFiles groups a shared UUID into one entry with both accounts, newest path wins", () => {
  const rows = [
    { id: "u1", path: "/P/proj/u1.jsonl", account: "P", mtime: 100 },
    { id: "u1", path: "/W/proj/u1.jsonl", account: "W", mtime: 200 },
    { id: "u2", path: "/P/proj/u2.jsonl", account: "P", mtime: 50 },
  ];
  const out = dedupeTaggedFiles(rows).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(out, [
    { id: "u1", path: "/W/proj/u1.jsonl", accounts: ["P", "W"] }, // newer W copy wins
    { id: "u2", path: "/P/proj/u2.jsonl", accounts: ["P"] },
  ]);
});

test("pickTitles takes the newest entry of each kind, so a later /rename wins", () => {
  const lines = [
    JSON.stringify({ type: "custom-title", customTitle: "first name", sessionId: "u1" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "ai-title", aiTitle: "auto topic", sessionId: "u1" }),
    JSON.stringify({ type: "custom-title", customTitle: "second name", sessionId: "u1" }),
  ];
  assert.deepEqual(pickTitles(lines), { customTitle: "second name", aiTitle: "auto topic" });
});

test("pickTitles ignores prompts that merely mention the type tags, and unparseable lines", () => {
  const lines = [
    'not json at all',
    JSON.stringify({ type: "user", message: { role: "user", content: 'what is a "custom-title" line?' } }),
  ];
  assert.deepEqual(pickTitles(lines), { customTitle: null, aiTitle: null });
});

test("pickTitles returns nulls for a session that was never renamed or auto-titled", () => {
  const lines = [JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi" } })];
  assert.deepEqual(pickTitles(lines), { customTitle: null, aiTitle: null });
});

test("resolveActivityMs prefers the last message timestamp over mtime", () => {
  const lastTs = "2026-09-01T07:00:00.000Z";
  // mtime is later than lastTs: a metadata-only append (e.g. /rename) touched the file.
  assert.equal(resolveActivityMs(lastTs, Date.parse("2026-09-01T09:00:00.000Z")), Date.parse(lastTs));
});

test("resolveActivityMs falls back to mtime when there is no usable timestamp", () => {
  assert.equal(resolveActivityMs(null, 1234), 1234);
  assert.equal(resolveActivityMs("not-a-date", 1234), 1234);
});
