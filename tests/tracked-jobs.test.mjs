import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.mjs";
import { resolveStateFile } from "../plugins/codex/scripts/lib/state.mjs";
import { createJobProgressUpdater, touchJobHeartbeatSafely } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("heartbeat lock failures are swallowed by the interval callback", () => {
  assert.doesNotThrow(() => touchJobHeartbeatSafely("/repo", "job-1", null, () => {
    throw new Error("Timed out acquiring state lock");
  }));
});

test("a progress patch lost to lock contention does not throw into the worker", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const lockFile = `${stateFile}.lock`;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    const update = createJobProgressUpdater(workspace, "contended-job");
    assert.doesNotThrow(() => update({ threadId: "thr_x", turnId: "turn_x" }));
  } finally {
    fs.unlinkSync(lockFile);
  }
});
