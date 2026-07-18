import { randomUUID } from "node:crypto";
import fs from "node:fs";
import process from "node:process";

import {
  effectiveRunStatus,
  transitionJob,
  workspaceSnapshotToken
} from "./job-reconciliation.mjs";
import {
  appendJobEvent,
  privateAppendFileSync,
  privateWriteFileSync,
  resolveJobLogFile,
  touchJobHeartbeat,
  transitionStoredJob
} from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  privateAppendFileSync(logFile, `[${nowIso()}] ${normalized}\n`);
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  privateAppendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`);
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  privateWriteFileSync(logFile, "");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    try {
      transitionStoredJob(workspaceRoot, jobId, (current) => ({
        ...current,
        ...patch
      }));
    } catch {
      // A progress patch lost to lock contention is harmless; the next
      // event or the terminal transition carries the same identifiers.
    }
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function buildTerminalRecord(runningRecord, execution) {
  const runStatus = execution.runStatus ?? (execution.exitStatus === 0 ? "FINISHED" : "FAILED");
  const legacyStatus = runStatus === "FINISHED" ? "completed" : "failed";
  // Never carry claim-time telemetry into the terminal write; the on-disk
  // values are fresher and are the durable liveness/activity evidence.
  const {
    heartbeatAt: _staleHeartbeat,
    lastProgressAt: _staleLastProgress,
    ...base
  } = runningRecord;
  return {
    ...base,
    status: legacyStatus,
    runStatus,
    outcomeStatus: execution.outcomeStatus ?? null,
    outcome: execution.outcome ?? null,
    threadId: execution.threadId ?? null,
    turnId: execution.turnId ?? null,
    pid: null,
    phase: legacyStatus === "completed" ? "done" : "failed",
    completedAt: nowIso(),
    summary: execution.summary,
    result: execution.payload,
    rendered: execution.rendered,
    completionSnapshotToken: workspaceSnapshotToken(execution.payload?.finalSnapshot)
  };
}

function executionFromAcceptedJob(job) {
  const runStatus = effectiveRunStatus(job);
  const outcomeStatus = job.outcomeStatus ?? "NEEDS_RECONCILIATION";
  const report = job.blocker?.message ?? `Job ${job.id} ended as ${runStatus}.`;
  return {
    exitStatus: runStatus === "FINISHED" && outcomeStatus !== "UNCLASSIFIED" ? 0 : 1,
    runStatus,
    outcomeStatus,
    outcome: job.outcome ?? null,
    threadId: job.threadId ?? null,
    turnId: job.turnId ?? null,
    payload: job.result ?? {
      jobId: job.id,
      runStatus,
      outcomeStatus,
      blocker: job.blocker ?? null
    },
    rendered: job.rendered ?? `Outcome: ${outcomeStatus}\n\n${report}\n`,
    summary: report
  };
}

export function touchJobHeartbeatSafely(
  workspaceRoot,
  jobId,
  lastProgressAt = null,
  touchHeartbeat = touchJobHeartbeat
) {
  try {
    touchHeartbeat(workspaceRoot, jobId, lastProgressAt);
  } catch {
    // A missed heartbeat is harmless; reconciliation tolerates several intervals.
  }
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = transitionStoredJob(job.workspaceRoot, job.id, (current) => {
    const claimable = current.runStatus || current.status
      ? current
      : { ...current, status: "queued", runStatus: "QUEUED" };
    const startedAt = current.startedAt ?? nowIso();
    return transitionJob(claimable, {
      ...job,
      status: "running",
      runStatus: "RUNNING",
      startedAt,
      lastProgressAt: current.lastProgressAt ?? options.getLastProgressAt?.() ?? startedAt,
      phase: "starting",
      pid: process.pid,
      logFile: options.logFile ?? job.logFile ?? null
    });
  });
  if (effectiveRunStatus(runningRecord) !== "RUNNING") {
    return executionFromAcceptedJob(runningRecord);
  }

  const heartbeat = setInterval(() => {
    touchJobHeartbeatSafely(
      job.workspaceRoot,
      job.id,
      options.getLastProgressAt?.() ?? null
    );
  }, 5000);
  heartbeat.unref();
  try {
    let execution;
    try {
      execution = await runner();
    } catch (error) {
      if (options.failureExecution) {
        execution = await options.failureExecution(error);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const terminalWriteId = randomUUID();
        const accepted = transitionStoredJob(job.workspaceRoot, job.id, (current) =>
          transitionJob(current, {
            status: "failed",
            runStatus: "FAILED",
            phase: "failed",
            errorMessage,
            pid: null,
            completedAt: nowIso(),
            terminalWriteId
          })
        );
        appendJobEvent(job.workspaceRoot, job.id, {
          type: "terminal_transition",
          acceptedRunStatus: accepted.runStatus
        });
        if (accepted.terminalWriteId !== terminalWriteId) {
          return executionFromAcceptedJob(accepted);
        }
        throw error;
      }
    }
    const terminalWriteId = randomUUID();
    const terminalPatch = {
      ...buildTerminalRecord(runningRecord, execution),
      terminalWriteId
    };
    const accepted = transitionStoredJob(job.workspaceRoot, job.id, (current) =>
      transitionJob(current, terminalPatch)
    );
    appendJobEvent(job.workspaceRoot, job.id, {
      type: "terminal_transition",
      acceptedRunStatus: accepted.runStatus
    });
    const acceptedExecution = accepted.terminalWriteId === terminalWriteId
      ? execution
      : executionFromAcceptedJob(accepted);
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", acceptedExecution.rendered);
    return acceptedExecution;
  } finally {
    clearInterval(heartbeat);
  }
}
