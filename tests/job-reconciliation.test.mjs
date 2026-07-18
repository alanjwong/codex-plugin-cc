import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveRunStatus,
  isActiveJob,
  JOB_HEARTBEAT_STALE_MS,
  reconcileJob,
  transitionJob,
  workspaceSnapshotToken
} from "../plugins/codex/scripts/lib/job-reconciliation.mjs";

test("runStatus wins when a legacy running status coexists with a terminal record", () => {
  const job = { status: "running", runStatus: "FINISHED" };
  assert.equal(effectiveRunStatus(job), "FINISHED");
  assert.equal(isActiveJob(job), false);
});

test("dead running jobs require reconciliation rather than becoming successful", () => {
  const result = reconcileJob("/repo", {
    id: "job-1",
    runStatus: "RUNNING",
    outcomeStatus: null,
    pid: 999,
    intent: "write",
    threadId: "thr-1"
  }, {
    isProcessAlive: () => false,
    currentWorkspace: () => ({ head: "abc", dirtyFingerprint: "dirty" })
  });
  assert.equal(result.runStatus, "INTERRUPTED");
  assert.equal(result.outcomeStatus, "NEEDS_RECONCILIATION");
});

test("a live process is not declared stale", () => {
  const job = { id: "job-1", runStatus: "RUNNING", pid: 10 };
  assert.equal(reconcileJob("/repo", job, { isProcessAlive: () => true }), job);
});

test("a stale heartbeat interrupts a running job even when its pid is live", () => {
  const now = new Date("2026-07-16T12:00:31.001Z");
  const result = reconcileJob("/repo", {
    id: "job-stale",
    runStatus: "RUNNING",
    pid: 10,
    heartbeatAt: new Date(now.getTime() - JOB_HEARTBEAT_STALE_MS - 1).toISOString()
  }, {
    isProcessAlive: () => true,
    now: () => now
  });

  assert.equal(result.runStatus, "INTERRUPTED");
  assert.equal(result.outcomeStatus, "NEEDS_RECONCILIATION");
  assert.equal(result.pid, null);
});

test("a fresh heartbeat leaves a running job untouched", () => {
  const now = new Date("2026-07-16T12:00:30.000Z");
  const job = {
    id: "job-fresh",
    runStatus: "RUNNING",
    pid: 10,
    heartbeatAt: new Date(now.getTime() - JOB_HEARTBEAT_STALE_MS).toISOString()
  };
  assert.equal(reconcileJob("/repo", job, {
    isProcessAlive: () => true,
    now: () => now
  }), job);
});

test("a queued reservation remains healthy until its start lease expires", () => {
  const job = {
    id: "job-1",
    runStatus: "QUEUED",
    pid: null,
    startDeadlineAt: "2026-07-16T12:00:10.000Z"
  };
  assert.equal(reconcileJob("/repo", job, {
    isProcessAlive: () => false,
    now: () => new Date("2026-07-16T12:00:05.000Z")
  }), job);
  assert.equal(reconcileJob("/repo", job, {
    isProcessAlive: () => false,
    now: () => new Date("2026-07-16T12:00:11.000Z")
  }).runStatus, "INTERRUPTED");
});

test("cancelled is monotonic against late completion", () => {
  const cancelled = { id: "job-1", runStatus: "CANCELLED", outcomeStatus: "CANCELLED" };
  assert.deepEqual(transitionJob(cancelled, {
    runStatus: "FINISHED",
    outcomeStatus: "READY_FOR_INTEGRATION"
  }), cancelled);
});

test("a pending cancellation owns later runner completion", () => {
  const requested = { id: "job-1", runStatus: "CANCEL_REQUESTED" };
  assert.deepEqual(transitionJob(requested, {
    runStatus: "FINISHED",
    outcomeStatus: "READY_FOR_INTEGRATION"
  }), requested);
});

test("an inexact Git snapshot cannot produce an acceptance token", () => {
  assert.equal(workspaceSnapshotToken({
    workspaceRealpath: "/repo",
    git: {
      exact: false,
      branch: "main",
      head: "abc",
      dirtyFingerprint: "def"
    }
  }), null);
});
