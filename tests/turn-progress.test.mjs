import assert from "node:assert/strict";
import test from "node:test";

import { enrichJob, TURN_QUIET_WARN_MS } from "../plugins/codex/scripts/lib/job-control.mjs";
import { readJobFile, resolveJobFile, touchJobHeartbeat, transitionStoredJob } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { makeTempDir } from "./helpers.mjs";

test("enrichJob computes active turn quietness from last progress with deterministic env overrides", () => {
  const now = new Date("2026-07-17T12:20:00.000Z");
  const active = {
    id: "task-quiet",
    runStatus: "RUNNING",
    createdAt: "2026-07-17T12:00:00.000Z",
    startedAt: "2026-07-17T12:05:00.000Z",
    lastProgressAt: "2026-07-17T12:19:50.000Z"
  };

  const overridden = enrichJob(active, {
    now,
    env: { CODEX_COMPANION_TURN_QUIET_WARN_MS: "9000" }
  });
  assert.equal(overridden.turnQuietMs, 10_000);
  assert.equal(overridden.turnQuietWarning, true);

  const invalidOverride = enrichJob(active, {
    now,
    env: { CODEX_COMPANION_TURN_QUIET_WARN_MS: "9.5" }
  });
  assert.equal(TURN_QUIET_WARN_MS, 900_000);
  assert.equal(invalidOverride.turnQuietWarning, false);
});

test("enrichJob uses startedAt then createdAt fallbacks and omits quiet fields for terminal jobs", () => {
  const now = new Date("2026-07-17T12:20:00.000Z");
  const fromStarted = enrichJob({
    id: "task-started",
    runStatus: "RUNNING",
    createdAt: "2026-07-17T12:00:00.000Z",
    startedAt: "2026-07-17T12:19:00.000Z"
  }, { now, env: {} });
  assert.equal(fromStarted.turnQuietMs, 60_000);
  assert.equal(fromStarted.turnQuietWarning, false);

  const fromCreated = enrichJob({
    id: "task-created",
    runStatus: "QUEUED",
    createdAt: "2026-07-17T12:18:00.000Z"
  }, { now, env: { CODEX_COMPANION_TURN_QUIET_WARN_MS: "100000" } });
  assert.equal(fromCreated.turnQuietMs, 120_000);
  assert.equal(fromCreated.turnQuietWarning, true);

  const terminal = enrichJob({
    id: "task-done",
    runStatus: "FINISHED",
    createdAt: "2026-07-17T12:00:00.000Z",
    startedAt: "2026-07-17T12:01:00.000Z",
    lastProgressAt: "2026-07-17T12:02:00.000Z",
    completedAt: "2026-07-17T12:03:00.000Z"
  }, { now, env: { CODEX_COMPANION_TURN_QUIET_WARN_MS: "1" } });
  assert.equal(terminal.turnQuietMs, undefined);
  assert.equal(terminal.turnQuietWarning, undefined);
});

test("touchJobHeartbeat accepts only a dedicated lastProgressAt value", () => {
  const workspace = makeTempDir();
  transitionStoredJob(workspace, "task-allowlist", () => ({
    id: "task-allowlist",
    runStatus: "RUNNING",
    lastProgressAt: "2026-07-17T12:00:00.000Z"
  }));

  touchJobHeartbeat(workspace, "task-allowlist", {
    id: "task-overwritten",
    runStatus: "FAILED",
    heartbeatAt: "1900-01-01T00:00:00.000Z",
    lastProgressAt: "1900-01-01T00:00:00.000Z"
  });
  let stored = readJobFile(resolveJobFile(workspace, "task-allowlist"));
  assert.equal(stored.id, "task-allowlist");
  assert.equal(stored.runStatus, "RUNNING");
  assert.notEqual(stored.heartbeatAt, "1900-01-01T00:00:00.000Z");
  assert.equal(stored.lastProgressAt, "2026-07-17T12:00:00.000Z");

  touchJobHeartbeat(workspace, "task-allowlist", "2026-07-17T12:10:00.000Z");
  stored = readJobFile(resolveJobFile(workspace, "task-allowlist"));
  assert.equal(stored.lastProgressAt, "2026-07-17T12:10:00.000Z");
});

test("terminal job writes preserve the fresher on-disk lastProgressAt", async () => {
  const workspace = makeTempDir();
  const staleProgressAt = "2026-07-17T12:00:00.000Z";
  const freshProgressAt = "2026-07-17T12:10:00.000Z";
  transitionStoredJob(workspace, "task-terminal", () => ({
    id: "task-terminal",
    status: "queued",
    runStatus: "QUEUED",
    workspaceRoot: workspace,
    lastProgressAt: staleProgressAt
  }));

  await runTrackedJob({
    id: "task-terminal",
    workspaceRoot: workspace
  }, async () => {
    transitionStoredJob(workspace, "task-terminal", (current) => ({
      ...current,
      lastProgressAt: freshProgressAt
    }));
    return {
      exitStatus: 0,
      runStatus: "FINISHED",
      outcomeStatus: "COMPLETED_READ_ONLY",
      threadId: "thr_terminal",
      turnId: "turn_terminal",
      payload: {},
      rendered: "done\n",
      summary: "done"
    };
  });

  const stored = readJobFile(resolveJobFile(workspace, "task-terminal"));
  assert.equal(stored.runStatus, "FINISHED");
  assert.equal(stored.lastProgressAt, freshProgressAt);
});
