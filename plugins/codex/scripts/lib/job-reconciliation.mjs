import { createHash } from "node:crypto";
import { verifyProcessIdentity } from "./process.mjs";

const ACTIVE_RUN_STATUSES = new Set(["QUEUED", "RUNNING", "CANCEL_REQUESTED"]);
const TERMINAL_RUN_STATUSES = new Set(["FINISHED", "FAILED", "CANCELLED", "INTERRUPTED"]);
export const JOB_HEARTBEAT_STALE_MS = 30000;

export function effectiveRunStatus(job) {
  if (job.runStatus) return job.runStatus;
  return {
    queued: "QUEUED",
    running: "RUNNING",
    completed: "FINISHED",
    failed: "FAILED",
    cancelled: "CANCELLED"
  }[job.status] ?? "FAILED";
}

export function isActiveJob(job) {
  return ACTIVE_RUN_STATUSES.has(effectiveRunStatus(job));
}

export function isTerminalJob(job) {
  return TERMINAL_RUN_STATUSES.has(effectiveRunStatus(job));
}

export function processIsAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

// Identity-aware liveness: when a job carries a worker identity (pid + start
// time captured at spawn), a live pid only counts as "our worker" if the
// identity still verifies — a recycled pid reads as dead. Legacy records
// without identity fall back to the plain pid check (safe for observation;
// signaling legacy records is separately forbidden).
export function workerLooksAlive(job) {
  const identity = job?.workerIdentity;
  if (identity && Number.isFinite(identity.startedAt)) {
    return verifyProcessIdentity(identity).verified;
  }
  return processIsAlive(job?.pid);
}

export function jobHeartbeatIsFresh(job, now = new Date()) {
  if (!job.heartbeatAt) return true;
  const heartbeatAt = Date.parse(job.heartbeatAt);
  return Number.isFinite(heartbeatAt) && now.getTime() - heartbeatAt <= JOB_HEARTBEAT_STALE_MS;
}

export async function waitForProcessExit(pid, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  return true;
}

export function transitionJob(current, patch) {
  if (isTerminalJob(current)) return current;
  if (
    effectiveRunStatus(current) === "CANCEL_REQUESTED" &&
    !["CANCEL_REQUESTED", "CANCELLED", "INTERRUPTED"].includes(patch.runStatus)
  ) return current;
  return { ...current, ...patch, updatedAt: new Date().toISOString() };
}

export function reconcileJob(workspaceRoot, job, options = {}) {
  if (!isActiveJob(job)) return job;
  const now = (options.now ?? (() => new Date()))();
  const isAlive = (options.isProcessAlive ?? processIsAlive)(job.pid);
  const heartbeatExpired = effectiveRunStatus(job) !== "QUEUED" && !jobHeartbeatIsFresh(job, now);
  if (isAlive && !heartbeatExpired) return job;
  if (
    effectiveRunStatus(job) === "QUEUED" &&
    job.startDeadlineAt &&
    now.getTime() <= new Date(job.startDeadlineAt).getTime()
  ) return job;
  return transitionJob(job, {
    runStatus: "INTERRUPTED",
    outcomeStatus: "NEEDS_RECONCILIATION",
    pid: null,
    retryable: false,
    blocker: {
      kind: "interrupted_attempt",
      message: `Job ${job.id} stopped without a trustworthy terminal result.`,
      retryWhen: "The stored thread and workspace diff have been reconciled"
    },
    interruptedAt: now.toISOString()
  });
}

export function workspaceSnapshotToken(snapshot) {
  if (!snapshot?.git || snapshot.git.exact === false) return null;
  return createHash("sha256").update(JSON.stringify({
    workspaceRealpath: snapshot.workspaceRealpath,
    branch: snapshot.git.branch,
    head: snapshot.git.head,
    dirtyFingerprint: snapshot.git.dirtyFingerprint
  })).digest("hex");
}
