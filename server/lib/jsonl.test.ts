import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeTaggedFiles } from "./jsonl.js";

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
