import { test } from "node:test";
import assert from "node:assert/strict";
import { latestByPaneId } from "./paneBindings.js";

const row = (o: Record<string, unknown>) => JSON.stringify({
  ts: "2026-07-21T12:00:00+02:00",
  source: "startup",
  sessionId: "sess-a",
  transcriptPath: "/p/sess-a.jsonl",
  paneId: "%1",
  tmuxSession: "unip",
  windowIndex: 1,
  paneIndex: 1,
  cwd: "/proj",
  configDir: "/home/dsu/.claude-work",
  ...o,
});

test("two panes in one project keep distinct conversations", () => {
  // The regression this exists for: mtime returns one answer for both panes, so a
  // restore relaunches both onto one conversation and drops the other.
  const m = latestByPaneId([
    row({ paneId: "%1", sessionId: "opus-checker" }),
    row({ paneId: "%2", sessionId: "fable-implementer" }),
  ]);
  assert.equal(m.get("%1")?.sessionId, "opus-checker");
  assert.equal(m.get("%2")?.sessionId, "fable-implementer");
});

test("later line wins for the same pane (/clear rebinds it)", () => {
  const m = latestByPaneId([
    row({ paneId: "%1", sessionId: "before-clear", source: "startup" }),
    row({ paneId: "%1", sessionId: "after-clear", source: "clear" }),
  ]);
  assert.equal(m.get("%1")?.sessionId, "after-clear");
  assert.equal(m.get("%1")?.source, "clear");
  assert.equal(m.size, 1);
});

test("file order wins over timestamp — the clock is not monotonic here", () => {
  // WSL jumps the clock on suspend/resume, so a later append can carry an earlier ts.
  const m = latestByPaneId([
    row({ paneId: "%1", sessionId: "first", ts: "2026-07-21T18:00:00+02:00" }),
    row({ paneId: "%1", sessionId: "second", ts: "2026-07-21T06:00:00+02:00" }),
  ]);
  assert.equal(m.get("%1")?.sessionId, "second");
});

test("malformed and blank lines are skipped, not fatal", () => {
  const m = latestByPaneId([
    "not json",
    "",
    "   ",
    "{}",
    JSON.stringify({ paneId: "%1" }),              // no sessionId
    JSON.stringify({ sessionId: "orphan" }),        // no paneId
    JSON.stringify({ paneId: "", sessionId: "x" }), // empty paneId
    row({ paneId: "%3", sessionId: "good" }),
  ]);
  assert.equal(m.size, 1);
  assert.equal(m.get("%3")?.sessionId, "good");
});

test("missing optional fields fall back to safe defaults", () => {
  const m = latestByPaneId([JSON.stringify({ paneId: "%4", sessionId: "s" })]);
  const b = m.get("%4")!;
  assert.equal(b.windowIndex, -1);
  assert.equal(b.paneIndex, -1);
  assert.equal(b.source, "unknown");
  assert.equal(b.configDir, "");
});

test("empty input yields an empty map", () => {
  assert.equal(latestByPaneId([]).size, 0);
});
