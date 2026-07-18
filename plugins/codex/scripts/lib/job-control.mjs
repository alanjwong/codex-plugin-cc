import fs from "node:fs";
import process from "node:process";

import { isWriteIntent } from "./correlation.mjs";
import { getSessionRuntimeStatus } from "./codex.mjs";
import {
  effectiveRunStatus,
  isActiveJob,
  isTerminalJob,
  reconcileJob,
  workspaceSnapshotToken
} from "./job-reconciliation.mjs";
import { captureWorkspaceSnapshot } from "./preflight.mjs";
import {
  appendJobEvent,
  getConfig,
  listDurableJobs,
  listJobs,
  readJobFile,
  resolveJobFile,
  transitionStoredJob
} from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const TURN_QUIET_WARN_MS = 900_000;

function resolveTurnQuietWarnMs(env) {
  const raw = env?.CODEX_COMPANION_TURN_QUIET_WARN_MS;
  if (raw == null) {
    return TURN_QUIET_WARN_MS;
  }
  const normalized = String(raw).trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    return TURN_QUIET_WARN_MS;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : TURN_QUIET_WARN_MS;
}

function legacyStatusFor(job) {
  return {
    QUEUED: "queued",
    RUNNING: "running",
    CANCEL_REQUESTED: "running",
    FINISHED: "completed",
    FAILED: "failed",
    CANCELLED: "cancelled",
    INTERRUPTED: "failed"
  }[effectiveRunStatus(job)] ?? "failed";
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .map((job) => ({
      ...job,
      status: legacyStatusFor(job),
      runStatus: effectiveRunStatus(job)
    }));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (effectiveRunStatus(job)) {
    case "QUEUED":
      return "queued";
    case "CANCELLED":
      return "cancelled";
    case "FAILED":
    case "INTERRUPTED":
      return "failed";
    case "FINISHED":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const runStatus = effectiveRunStatus(job);
  let quietFields = {};
  if (isActiveJob(job)) {
    const activityAt = Date.parse(job.lastProgressAt ?? job.startedAt ?? job.createdAt ?? "");
    const nowValue = options.now ?? new Date();
    const now = nowValue instanceof Date ? nowValue.getTime() : new Date(nowValue).getTime();
    if (Number.isFinite(activityAt) && Number.isFinite(now)) {
      const turnQuietMs = Math.max(0, now - activityAt);
      quietFields = {
        turnQuietMs,
        turnQuietWarning: turnQuietMs > resolveTurnQuietWarnMs(options.env ?? process.env)
      };
    }
  }
  const enriched = {
    ...job,
    runStatus,
    ...quietFields,
    outcomeStatus: job.outcomeStatus ?? job.result?.outcomeStatus ?? null,
    outcome: job.outcome ?? job.result?.outcome ?? null,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      isActiveJob(job) || runStatus === "FAILED"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration: isTerminalJob(job)
      ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
      : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export function reconcileStoredJob(workspaceRoot, jobId, options = {}) {
  const stored = readStoredJob(workspaceRoot, jobId);
  if (!stored) return null;
  if (!isActiveJob(stored)) return stored;
  const accepted = transitionStoredJob(workspaceRoot, jobId, (current) => {
    const reconciled = reconcileJob(workspaceRoot, current, options);
    if (reconciled === current) return current;
    const readOnlyWithoutThread = !isWriteIntent(current) && !current.threadId;
    return {
      ...reconciled,
      status: "failed",
      phase: "failed",
      ...(readOnlyWithoutThread
        ? {
            outcomeStatus: "INFRA_FAILED",
            retryable: true,
            blocker: {
              kind: "interrupted_read_only_attempt",
              message: `Read-only job ${current.id} stopped before creating a resumable thread.`,
              retryWhen: "Retry the task"
            }
          }
        : {})
    };
  });
  if (effectiveRunStatus(accepted) !== effectiveRunStatus(stored)) {
    appendJobEvent(workspaceRoot, jobId, {
      type: "reconciled",
      fromRunStatus: effectiveRunStatus(stored),
      acceptedRunStatus: effectiveRunStatus(accepted),
      outcomeStatus: accepted.outcomeStatus ?? null
    });
  }
  return accepted;
}

export function reconcileWorkspaceJobs(workspaceRoot, options = {}) {
  const jobs = listJobs(workspaceRoot);
  for (const job of jobs) {
    if (isActiveJob(job)) reconcileStoredJob(workspaceRoot, job.id, options);
  }
  return listJobs(workspaceRoot);
}

export function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(reconcileWorkspaceJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter(isActiveJob)
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find(isTerminalJob) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => isTerminalJob(job) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  const reconciled = reconcileStoredJob(workspaceRoot, selected.id) ?? selected;
  return {
    workspaceRoot,
    job: enrichJob(reconciled, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileWorkspaceJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(
    reference
      ? listDurableJobs(workspaceRoot)
      : filterJobsForCurrentSession(listJobs(workspaceRoot))
  );
  const selected = matchJobReference(
    jobs,
    reference,
    isTerminalJob
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, isActiveJob);
  if (active) {
    throw new Error(`Job ${active.id} is still ${effectiveRunStatus(active)}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveExactResume(cwd, reference, currentPreflight) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileWorkspaceJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(listDurableJobs(workspaceRoot));
  const parentJob = matchJobReference(jobs, reference, (job) => job.jobClass === "task");
  const storedJob = readStoredJob(workspaceRoot, parentJob.id);
  if (!storedJob?.threadId) throw new Error(`Job ${parentJob.id} has no resumable Codex thread.`);
  if (isActiveJob(storedJob)) {
    throw new Error(`Job ${parentJob.id} is still active; inspect status instead of resuming it.`);
  }
  if (storedJob.workspaceRealpath !== currentPreflight.workspaceRealpath) {
    throw new Error(`Resume workspace mismatch for ${parentJob.id}.`);
  }
  if (storedJob.outcomeStatus === "NEEDS_RECONCILIATION" && !storedJob.reconciledAt) {
    throw new Error(
      `Job ${parentJob.id} needs reconciliation before it can resume: inspect the workspace diff, then accept it with \`reconcile ${parentJob.id} --accept-snapshot <token>\`.`
    );
  }
  const currentSnapshot = captureWorkspaceSnapshot(cwd);
  const currentSnapshotToken = workspaceSnapshotToken(currentSnapshot);
  const interruptedWrite = isWriteIntent(storedJob) && effectiveRunStatus(storedJob) === "INTERRUPTED";
  const acceptedSnapshotToken = interruptedWrite
    ? storedJob.reconciledSnapshotToken ?? null
    : storedJob.reconciledSnapshotToken ?? storedJob.completionSnapshotToken ?? null;
  if (isWriteIntent(storedJob) && !acceptedSnapshotToken) {
    throw new Error(
      `Job ${parentJob.id} has no exact accepted workspace snapshot and cannot resume; needs reconciliation (interrupted non-Git writes cannot accept a snapshot and require a fresh retry).`
    );
  }
  if (acceptedSnapshotToken && currentSnapshotToken !== acceptedSnapshotToken) {
    transitionStoredJob(workspaceRoot, parentJob.id, (record) => ({
      ...record,
      outcomeStatus: "NEEDS_RECONCILIATION",
      workspaceDrift: true,
      currentSnapshotToken,
      reconciledAt: null,
      retryable: false,
      nextAction: currentSnapshotToken === null
        ? "manual_inspection_then_retry_fresh"
        : "inspect_workspace_diff"
    }));
    throw new Error(
      `Job ${parentJob.id} needs reconciliation before it can resume: the workspace changed since its accepted snapshot; inspect the diff, then accept it with \`reconcile ${parentJob.id} --accept-snapshot <token>\`.`
    );
  }
  return { workspaceRoot, parentJob, storedJob, threadId: storedJob.threadId };
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(
    options.reconcile === false ? listJobs(workspaceRoot) : reconcileWorkspaceJobs(workspaceRoot)
  );
  const activeJobs = jobs.filter(isActiveJob);

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
