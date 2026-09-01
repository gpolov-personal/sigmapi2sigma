import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutDerivedTitles } from "./savedTmux.js";
import type { TmuxSession } from "./tmux.js";

function sessionWithPane(overrides: Record<string, unknown>): TmuxSession {
  return {
    name: "proj",
    windows: [{
      index: 1,
      name: "win",
      layout: "",
      panes: [{
        index: 1,
        paneId: "%1",
        pid: 123,
        cmd: "claude",
        cwd: "/home/u/proj",
        claudeLastCwd: "/home/u/proj",
        claudeSessionId: "sid-1",
        claudeSessionSource: "binding",
        claudeCustomTitle: null,
        claudeAiTitle: null,
        claudeTranscriptMissing: false,
        claudeAccount: "P",
        claudePermissionMode: "default",
        ...overrides,
      }],
    }],
  } as TmuxSession;
}

test("withoutDerivedTitles blanks the name a live pane carried, so a later /rename is not shadowed", () => {
  const pinned = withoutDerivedTitles(sessionWithPane({
    claudeCustomTitle: "old-name",
    claudeAiTitle: "old auto title",
    claudeTranscriptMissing: true,
  }));
  const pane = pinned.windows[0].panes[0];
  assert.equal(pane.claudeCustomTitle, null);
  assert.equal(pane.claudeAiTitle, null);
  assert.equal(pane.claudeTranscriptMissing, false);
});

test("withoutDerivedTitles keeps everything the restore path needs", () => {
  const pinned = withoutDerivedTitles(sessionWithPane({ claudeCustomTitle: "old-name" }));
  const pane = pinned.windows[0].panes[0];
  assert.equal(pinned.name, "proj");
  assert.equal(pane.claudeSessionId, "sid-1");
  assert.equal(pane.cwd, "/home/u/proj");
  assert.equal(pane.claudeAccount, "P");
  assert.equal(pane.claudePermissionMode, "default");
});

test("withoutDerivedTitles does not mutate the caller's live tree", () => {
  const live = sessionWithPane({ claudeCustomTitle: "old-name" });
  withoutDerivedTitles(live);
  assert.equal(live.windows[0].panes[0].claudeCustomTitle, "old-name");
});
