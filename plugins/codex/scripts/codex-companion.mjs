#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { PLUGIN_VERSION } from "./lib/app-server.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { buildTaskIdentity, decideTaskClaim, isWriteIntent } from "./lib/correlation.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, captureProcessIdentity, terminateProcessTreeVerified } from "./lib/process.mjs";
import {
  assertRuntimeAttestation,
  buildStaticPreflight,
  captureWorkspaceSnapshot,
  changedFilesBetween,
  normalizeTaskIntent
} from "./lib/preflight.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  effectiveRunStatus,
  isActiveJob,
  isTerminalJob,
  jobHeartbeatIsFresh,
  reconcileJob,
  workerLooksAlive,
  transitionJob,
  waitForProcessExit,
  workspaceSnapshotToken
} from "./lib/job-reconciliation.mjs";
import {
  buildInfrastructureOutcome,
  parseTaskOutcome,
  renderTaskOutcome
} from "./lib/task-outcome.mjs";
import {
  appendJobEvent,
  generateJobId,
  getConfig,
  listJobs,
  purgeExpiredJobArtifacts,
  reserveStoredJob,
  setConfig,
  transitionStoredJob
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  matchJobReference,
  readStoredJob,
  reconcileStoredJob,
  reconcileWorkspaceJobs,
  resolveCancelableJob,
  resolveExactResume,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const TASK_OUTPUT_SCHEMA = path.join(ROOT_DIR, "schemas", "task-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const TASK_IDENTITY_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task --read-only|--write [--background] [--resume-last|--resume|--resume-job <job-id>|--fresh] [--workflow-id <id>] [--task-id <id>] [--attempt-id <id>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs reconcile [job-id] [--accept-snapshot <sha256>] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function printTaskUsage() {
  console.log(
    "Usage: node scripts/codex-companion.mjs task --read-only|--write [--background] [--resume-last|--resume|--resume-job <job-id>|--fresh] [--workflow-id <id>] [--task-id <id>] [--attempt-id <id>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]"
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        isTerminalJob(job)
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJob(snapshot.job) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJob(snapshot.job),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(reconcileWorkspaceJobs(workspaceRoot))
    .filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJob(job));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress,
      onTurnActivity: request.onTurnActivity
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary,
        transport: result.transport ?? null,
        endpoint: result.brokerEndpoint ?? null
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress,
    onTurnActivity: request.onTurnActivity
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary,
      transport: result.transport ?? null,
      endpoint: result.brokerEndpoint ?? null
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const intent = request.intent ?? (request.write ? "write" : "read-only");
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = request.resumeThreadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    outputSchema: readOutputSchema(TASK_OUTPUT_SCHEMA),
    onProgress: request.onProgress,
    onTurnActivity: request.onTurnActivity,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT),
    assertRuntime: (effective) => assertRuntimeAttestation(request.preflight, effective)
  });

  const rawOutput = result.finalMessage ?? "";
  const transportFailed = result.status !== 0 || Boolean(result.error);
  const finalSnapshot = captureWorkspaceSnapshot(workspaceRoot);
  const eventTouchedFiles = [...new Set(
    (result.touchedFiles ?? []).map((file) => workspaceRelativeFile(request.preflight.workspaceRealpath, file))
  )].sort();
  const snapshotChangedFiles = [...new Set(
    changedFilesBetween(request.preflight, finalSnapshot)
      .map((file) => workspaceRelativeFile(request.preflight.workspaceRealpath, file))
  )].sort();
  const exactWorkspaceEvidence = Boolean(
    request.preflight.git?.exact !== false &&
    finalSnapshot.git?.exact !== false &&
    request.preflight.git &&
    finalSnapshot.git
  );
  let outcome = transportFailed
    ? buildInfrastructureOutcome(new Error(
        result.error?.message || result.stderr || `Codex turn ended with status ${result.turn?.status ?? result.status}`
      ))
    : parseTaskOutcome(rawOutput, {
        intent,
        eventTouchedFiles,
        snapshotChangedFiles,
        exactWorkspaceEvidence
      });
  const protocolFailed = outcome.outcomeStatus === "UNCLASSIFIED";
  if (
    !transportFailed &&
    !protocolFailed &&
    intent === "write" &&
    (outcome.unattributedDriftFiles?.length ?? 0) > 0
  ) {
    outcome = {
      ...outcome,
      outcomeStatus: "NEEDS_RECONCILIATION",
      success: false,
      retryable: false,
      blocker: {
        kind: "workspace_drift",
        message: `Unattributed workspace changes appeared during the task: ${outcome.unattributedDriftFiles.join(", ")}.`,
        retryWhen: "The workspace diff has been inspected and reconciled"
      }
    };
  }
  const runStatus = transportFailed ? "FAILED" : "FINISHED";
  const exitStatus = transportFailed || protocolFailed ? 1 : 0;
  const rendered = renderTaskOutcome(outcome);
  const payload = {
    runStatus,
    outcomeStatus: outcome.outcomeStatus,
    threadId: result.threadId,
    turnId: result.turnId,
    runtime: result.runtime,
    outcome,
    rawOutput,
    eventTouchedFiles,
    snapshotChangedFiles,
    reportedChangedFiles: outcome.changedFiles,
    unattributedDriftFiles: outcome.unattributedDriftFiles ?? [],
    finalSnapshot,
    reasoningSummary: result.reasoningSummary,
    transport: {
      kind: result.transport ?? null,
      endpoint: result.brokerEndpoint ?? null,
      status: result.status,
      turnStatus: result.turn?.status ?? null,
      error: result.error?.message ?? null,
      stderr: result.stderr ?? ""
    }
  };

  return {
    exitStatus,
    runStatus,
    outcomeStatus: outcome.outcomeStatus,
    outcome,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: shorten(outcome.report) || outcome.outcomeStatus,
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: intent === "write"
  };
}

function workspaceRelativeFile(workspaceRoot, file) {
  const unresolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(workspaceRoot, file);
  let absolute;
  try {
    absolute = fs.realpathSync.native(unresolved);
  } catch {
    absolute = unresolved;
  }
  const relative = path.relative(workspaceRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Observed file change escaped the task workspace: ${file}`);
  }
  return relative.split(path.sep).join("/");
}

function buildTaskFailureExecution(error) {
  const isTransportFailure = error?.code === "TRANSPORT_DIED" &&
    (error?.threadId || error?.turnId);
  const threadId = isTransportFailure ? error.threadId ?? null : null;
  const turnId = isTransportFailure ? error.turnId ?? null : null;
  const detail = isTransportFailure
    ? String(error.detail || error.message || "Codex app-server transport died during the turn.")
    : null;
  const infrastructureOutcome = buildInfrastructureOutcome(error);
  const outcome = isTransportFailure
    ? {
        ...infrastructureOutcome,
        report: detail,
        blocker: {
          kind: "transport_failure",
          message: detail,
          retryWhen: "Retry, or reconcile and resume the stored thread"
        }
      }
    : infrastructureOutcome;
  const rendered = renderTaskOutcome(outcome);
  return {
    exitStatus: 1,
    runStatus: "FAILED",
    outcomeStatus: "INFRA_FAILED",
    outcome,
    threadId,
    turnId,
    payload: {
      runStatus: "FAILED",
      outcomeStatus: "INFRA_FAILED",
      threadId,
      turnId,
      runtime: null,
      outcome,
      rawOutput: "",
      eventTouchedFiles: [],
      snapshotChangedFiles: [],
      reportedChangedFiles: [],
      unattributedDriftFiles: [],
      finalSnapshot: null,
      reasoningSummary: [],
      transport: {
        kind: error?.transport ?? null,
        endpoint: error?.brokerEndpoint ?? null,
        status: 1,
        turnStatus: null,
        error: outcome.report,
        stderr: ""
      }
    },
    rendered,
    summary: shorten(outcome.report) || "INFRA_FAILED",
    jobClass: "task"
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  summary,
  write = false,
  preflight = null,
  identity = null,
  parentJobId = null,
  model = null,
  effort = null
}) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    pluginVersion: PLUGIN_VERSION,
    ...(identity && preflight
      ? {
          workflowId: identity.workflowId,
          taskId: identity.taskId,
          attemptId: identity.attemptId,
          logicalTaskKey: identity.logicalTaskKey,
          parentJobId,
          idempotencyKey: identity.idempotencyKey,
          requestFingerprint: identity.requestFingerprint,
          intent: preflight.intent,
          workspaceRealpath: preflight.workspaceRealpath,
          branch: preflight.git?.branch ?? null,
          baselineHead: preflight.git?.head ?? null,
          baselineDirtyFingerprint: preflight.git?.dirtyFingerprint ?? null,
          requestedModel: model,
          requestedEffort: effort,
          requestedSandbox: preflight.requested.sandbox,
          reservedAt: nowIso(),
          startDeadlineAt: new Date(Date.now() + 15000).toISOString()
        }
      : {}),
    ...(preflight ? { preflight } : {})
  });
}

function createTrackedProgress(job, options = {}) {
  try {
    // Opportunistic retention pass at job-creation time so terminal artifacts
    // do not accumulate indefinitely; never blocks or fails the new job.
    purgeExpiredJobArtifacts(job.workspaceRoot);
  } catch {
    // Retention is best-effort.
  }
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, intent, preflight, identity, options = {}) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write: intent === "write",
    preflight,
    identity,
    parentJobId: options.parentJobId ?? null,
    model: options.model ?? null,
    effort: options.effort ?? null
  });
}

function buildTaskRequest({
  cwd,
  model,
  effort,
  prompt,
  intent,
  preflight,
  resumeLast,
  jobId,
  identity,
  parentJobId = null,
  resumeThreadId = null
}) {
  return {
    cwd,
    model,
    effort,
    prompt,
    intent,
    write: intent === "write",
    preflight,
    resumeLast,
    resumeThreadId,
    jobId,
    workflowId: identity.workflowId,
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    logicalTaskKey: identity.logicalTaskKey,
    parentJobId,
    idempotencyKey: identity.idempotencyKey,
    requestFingerprint: identity.requestFingerprint,
    workspaceRealpath: preflight.workspaceRealpath,
    branch: preflight.git?.branch ?? null,
    baselineHead: preflight.git?.head ?? null,
    baselineDirtyFingerprint: preflight.git?.dirtyFingerprint ?? null,
    requestedModel: model,
    requestedEffort: effort,
    requestedSandbox: preflight.requested.sandbox
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

function validateTaskIdentityOptions(options) {
  for (const name of ["workflow-id", "task-id", "attempt-id"]) {
    const value = options[name];
    if (value != null && !TASK_IDENTITY_SEGMENT_PATTERN.test(value)) {
      throw new Error(`Invalid --${name}: use 1-128 letters, numbers, dots, underscores, or hyphens.`);
    }
  }
}

function buildQueuedTaskCandidate(job, request) {
  const reservedAt = job.reservedAt ?? nowIso();
  return {
    ...job,
    status: "queued",
    runStatus: "QUEUED",
    outcomeStatus: null,
    phase: "queued",
    pid: null,
    reservedAt,
    startDeadlineAt: job.startDeadlineAt ?? new Date(Date.parse(reservedAt) + 15000).toISOString(),
    request
  };
}

function buildExistingTaskPayload(job) {
  return {
    jobId: job.id,
    status: effectiveRunStatus(job).toLowerCase(),
    runStatus: effectiveRunStatus(job),
    title: job.title,
    summary: job.summary,
    pid: job.pid ?? null,
    logFile: job.logFile ?? null
  };
}

function outputExistingTask(job, asJson) {
  const payload = buildExistingTaskPayload(job);
  const rendered = `${payload.title} already exists as ${payload.jobId} (${payload.status}). Inspect /codex:status ${payload.jobId}.\n`;
  outputCommandResult(payload, rendered, asJson);
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  let lastProgressAt = job.lastProgressAt ?? nowIso();
  const onTurnActivity = () => {
    lastProgressAt = nowIso();
  };
  const execution = await runTrackedJob(job, () => runner(progress, onTurnActivity), {
    logFile,
    failureExecution: options.failureExecution,
    getLastProgressAt: () => lastProgressAt
  });
  if (options.json || execution.exitStatus === 0) {
    outputResult(options.json ? execution.payload : execution.rendered, options.json);
  } else {
    process.stderr.write(execution.rendered);
  }
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const launchToken = crypto.randomBytes(16).toString("hex");
  const child = spawn(
    process.execPath,
    [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId, "--launch-token", launchToken],
    {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();
  const captured = captureProcessIdentity(child.pid);
  const identity = captured ? { ...captured, token: launchToken } : null;
  return { child, identity };
}

function enqueueBackgroundTask(cwd, job) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  transitionStoredJob(job.workspaceRoot, job.id, (current) => ({
    ...current,
    logFile
  }));
  appendJobEvent(job.workspaceRoot, job.id, { type: "queued" });
  let child;
  try {
    const spawned = spawnDetachedTaskWorker(cwd, job.id);
    child = spawned.child;
    if (spawned.identity) {
      transitionStoredJob(job.workspaceRoot, job.id, (current) => ({
        ...current,
        workerIdentity: spawned.identity
      }));
    }
  } catch (error) {
    transitionStoredJob(job.workspaceRoot, job.id, (current) => ({
      ...current,
      runStatus: "FAILED",
      outcomeStatus: "INFRA_FAILED",
      errorMessage: error.message,
      completedAt: nowIso()
    }));
    throw error;
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      pid: child.pid ?? null,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress, onTurnActivity) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress,
        onTurnActivity
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const passthroughIndex = argv.indexOf("--");
  const optionTokens = passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex);
  if (optionTokens.includes("--help") || optionTokens.includes("-h")) {
    printTaskUsage();
    return;
  }
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "model",
      "effort",
      "cwd",
      "prompt-file",
      "expected-branch",
      "expected-head",
      "workflow-id",
      "task-id",
      "attempt-id",
      "resume-job"
    ],
    multiValueOptions: ["require-command", "require-artifact"],
    booleanOptions: ["json", "write", "read-only", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    },
    rejectUnknownOptions: true
  });

  const intent = normalizeTaskIntent(options);
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  validateTaskIdentityOptions(options);
  ensureCodexAvailable(cwd);
  const preflight = buildStaticPreflight({
    cwd,
    intent,
    model,
    effort,
    expectedBranch: options["expected-branch"],
    expectedHead: options["expected-head"],
    requiredCommands: options["require-command"] ?? [],
    requiredArtifacts: options["require-artifact"] ?? [],
    env: process.env
  });
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const resumeJobReference = options["resume-job"] ?? null;
  const fresh = Boolean(options.fresh);
  if ([resumeLast, Boolean(resumeJobReference), fresh].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --resume/--resume-last, --resume-job, or --fresh.");
  }
  requireTaskRequest(prompt, resumeLast || Boolean(resumeJobReference));
  const exactResume = resumeJobReference
    ? resolveExactResume(cwd, resumeJobReference, preflight)
    : null;
  if (
    exactResume &&
    (
      (options["workflow-id"] && options["workflow-id"] !== exactResume.storedJob.workflowId) ||
      (options["task-id"] && options["task-id"] !== exactResume.storedJob.taskId)
    )
  ) {
    throw new Error("--resume-job must keep the parent job's workflow and task ids.");
  }
  const identity = buildTaskIdentity({
    workspaceRealpath: preflight.workspaceRealpath,
    intent,
    prompt,
    model,
    effort,
    sandbox: preflight.requested.sandbox,
    expectedBranch: options["expected-branch"] ?? null,
    expectedHead: options["expected-head"] ?? null,
    requiredArtifacts: preflight.requiredArtifacts,
    requiredCommands: preflight.requiredCommands,
    workflowId: exactResume?.storedJob.workflowId ?? options["workflow-id"],
    taskId: exactResume?.storedJob.taskId ?? options["task-id"],
    attemptId: exactResume
      ? options["attempt-id"] ?? generateJobId("attempt")
      : options["attempt-id"],
    sessionId: getCurrentClaudeSessionId()
  });
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast: resumeLast || Boolean(exactResume)
  });

  const job = buildTaskJob(workspaceRoot, taskMetadata, intent, preflight, identity, {
    parentJobId: exactResume?.parentJob.id ?? null,
    model,
    effort
  });
  const request = buildTaskRequest({
    cwd,
    model,
    effort,
    prompt,
    intent,
    preflight,
    resumeLast,
    jobId: job.id,
    identity,
    parentJobId: exactResume?.parentJob.id ?? null,
    resumeThreadId: exactResume?.threadId ?? null
  });
  reconcileWorkspaceJobs(workspaceRoot);
  const reservation = reserveStoredJob(
    workspaceRoot,
    buildQueuedTaskCandidate(job, request),
    decideTaskClaim
  );
  if (!reservation.created) {
    outputExistingTask(reservation.job, options.json);
    return;
  }
  const reservedJob = reservation.job;

  if (options.background) {
    const { payload } = enqueueBackgroundTask(cwd, reservedJob);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const foregroundClaimAt = nowIso();
  const claimed = transitionStoredJob(workspaceRoot, reservedJob.id, (current) =>
    effectiveRunStatus(current) === "QUEUED"
      ? transitionJob(current, {
          status: "running",
          runStatus: "RUNNING",
          pid: process.pid,
          heartbeatAt: foregroundClaimAt,
          lastProgressAt: foregroundClaimAt
        })
      : current
  );
  if (effectiveRunStatus(claimed) !== "RUNNING" || claimed.pid !== process.pid) {
    outputExistingTask(claimed, options.json);
    return;
  }
  await runForegroundCommand(
    claimed,
    (progress, onTurnActivity) =>
      executeTaskRun({
        ...request,
        onProgress: progress,
        onTurnActivity
      }),
    { json: options.json, failureExecution: buildTaskFailureExecution }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

function installTaskWorkerCrashHandlers(workspaceRoot, jobId, logFile) {
  const persistCrash = (label) => (cause) => {
    const message = `${label}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`;
    try {
      appendLogLine(logFile, message);
    } catch {
      // The durable record below is the authoritative crash evidence.
    }
    try {
      const execution = buildTaskFailureExecution(new Error(message));
      transitionStoredJob(workspaceRoot, jobId, (current) =>
        transitionJob(current, {
          status: "failed",
          phase: "failed",
          runStatus: "FAILED",
          outcomeStatus: "INFRA_FAILED",
          outcome: execution.outcome,
          result: execution.payload,
          rendered: execution.rendered,
          errorMessage: message,
          pid: null,
          completedAt: nowIso()
        })
      );
      appendJobEvent(workspaceRoot, jobId, { type: "worker_crash", label });
    } catch {
      // Persisting failed too; reconciliation will still surface the death.
    }
    process.exit(1);
  };
  process.on("uncaughtException", persistCrash("Task worker crashed (uncaught exception)"));
  process.on("unhandledRejection", persistCrash("Task worker crashed (unhandled rejection)"));
}

function handlePurge(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "ttl-days", "max-terminal"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveCommandWorkspace(options);
  const overrides = {};
  const ttlDays = Number.parseFloat(options["ttl-days"] ?? "");
  if (Number.isFinite(ttlDays) && ttlDays >= 0) {
    overrides.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }
  const maxTerminal = Number.parseInt(options["max-terminal"] ?? "", 10);
  if (Number.isFinite(maxTerminal) && maxTerminal >= 0) {
    overrides.maxTerminal = maxTerminal;
  }
  const result = purgeExpiredJobArtifacts(workspaceRoot, overrides);
  outputCommandResult(
    result,
    `Purged ${result.purgedJobs} resolved terminal job(s) (${result.deletedFiles} file(s) removed). Active and unresolved jobs are always preserved.\n`,
    options.json
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    // launch-token is consumed only via the worker's argv (visible to ps) for
    // process-identity verification; the worker itself ignores its value.
    valueOptions: ["cwd", "job-id", "launch-token"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const job = readStoredJob(workspaceRoot, options["job-id"]);
  if (!job) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const workerClaimAt = nowIso();
  const claimed = transitionStoredJob(job.workspaceRoot, job.id, (current) =>
    effectiveRunStatus(current) === "QUEUED"
      ? transitionJob(current, {
          status: "running",
          pid: process.pid,
          runStatus: "RUNNING",
          heartbeatAt: workerClaimAt,
          lastProgressAt: workerClaimAt
        })
      : current
  );
  if (effectiveRunStatus(claimed) !== "RUNNING" || claimed.pid !== process.pid) {
    process.exitCode = 1;
    return;
  }

  installTaskWorkerCrashHandlers(job.workspaceRoot, job.id, claimed.logFile ?? null);

  const request = claimed.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...claimed,
      workspaceRoot
    },
    {
      logFile: claimed.logFile ?? null
    }
  );
  let lastProgressAt = claimed.lastProgressAt;
  const onTurnActivity = () => {
    lastProgressAt = nowIso();
  };
  await runTrackedJob(
    {
      ...claimed,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress,
        onTurnActivity
      }),
    {
      logFile,
      failureExecution: buildTaskFailureExecution,
      getLastProgressAt: () => lastProgressAt
    }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(reconcileWorkspaceJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

function handleReconcile(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "accept-snapshot"],
    booleanOptions: ["json"],
    rejectUnknownOptions: true
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const reference = positionals[0] ?? "";
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error("No Codex jobs found for this repository yet.");
  }
  reconcileStoredJob(workspaceRoot, selected.id);
  const acceptedToken = options["accept-snapshot"] ?? null;
  if (acceptedToken && !/^[a-f0-9]{64}$/i.test(acceptedToken)) {
    throw new Error("--accept-snapshot must be a 64-character SHA-256 token.");
  }

  // Keep Git outside the state lock; acceptance is optimistically verified after persistence.
  const current = captureWorkspaceSnapshot(cwd);
  const currentSnapshotToken = workspaceSnapshotToken(current);
  let acceptedAt = null;
  let acceptanceRollback = null;
  const nextJob = transitionStoredJob(workspaceRoot, selected.id, (record) => {
    if (acceptedToken) {
      if (currentSnapshotToken === null) {
        throw new Error(`Job ${record.id} has no exact Git snapshot to accept.`);
      }
      if (currentSnapshotToken !== acceptedToken) {
        throw new Error("--accept-snapshot does not match the current workspace snapshot.");
      }
      const reconciledAt = nowIso();
      acceptedAt = reconciledAt;
      acceptanceRollback = {
        reconciledSnapshotToken: record.reconciledSnapshotToken ?? null,
        workspaceDriftAcknowledgedAt: record.workspaceDriftAcknowledgedAt ?? null
      };
      return {
        ...record,
        workspaceDrift: true,
        currentSnapshotToken,
        reconciledSnapshotToken: currentSnapshotToken,
        workspaceDriftAcknowledgedAt: reconciledAt,
        reconciledAt,
        retryable: Boolean(record.threadId),
        nextAction: record.threadId ? "resume_exact_job" : "retry_fresh"
      };
    }

    const acceptedSnapshotToken = record.reconciledSnapshotToken ?? record.completionSnapshotToken ?? null;
    const originalSnapshotToken = workspaceSnapshotToken(record.preflight);
    const comparisonToken = acceptedSnapshotToken ?? originalSnapshotToken;
    const workspaceDrift = comparisonToken === null
      ? isWriteIntent(record)
      : currentSnapshotToken !== comparisonToken;
    const exactSnapshotUnavailable = isWriteIntent(record) && currentSnapshotToken === null;
    const reconciledAt = workspaceDrift ? null : nowIso();
    return {
      ...record,
      workspaceDrift,
      currentSnapshotToken,
      reconciledAt,
      reconciledSnapshotToken: workspaceDrift
        ? null
        : record.reconciledSnapshotToken ?? currentSnapshotToken,
      retryable: !workspaceDrift && Boolean(record.threadId),
      nextAction: exactSnapshotUnavailable
        ? "manual_inspection_then_retry_fresh"
        : workspaceDrift
          ? "inspect_workspace_diff"
          : record.threadId
            ? "resume_exact_job"
            : "retry_fresh"
    };
  });

  if (acceptedToken) {
    let verifiedSnapshotToken = null;
    let verificationFailed = false;
    try {
      verifiedSnapshotToken = workspaceSnapshotToken(captureWorkspaceSnapshot(cwd));
    } catch {
      verificationFailed = true;
    }
    if (verificationFailed || verifiedSnapshotToken !== currentSnapshotToken) {
      transitionStoredJob(workspaceRoot, selected.id, (record) => {
        if (
          record.workspaceDriftAcknowledgedAt !== acceptedAt ||
          record.reconciledSnapshotToken !== currentSnapshotToken
        ) return record;
        return {
          ...record,
          workspaceDrift: true,
          currentSnapshotToken: verifiedSnapshotToken,
          reconciledSnapshotToken: acceptanceRollback?.reconciledSnapshotToken ?? null,
          workspaceDriftAcknowledgedAt: acceptanceRollback?.workspaceDriftAcknowledgedAt ?? null,
          reconciledAt: null,
          retryable: false,
          nextAction: verifiedSnapshotToken === null
            ? "manual_inspection_then_retry_fresh"
            : "inspect_workspace_diff"
        };
      });
      throw new Error(
        `Workspace changed while accepting the snapshot for job ${selected.id}; the acceptance was reverted. Re-run reconcile against the current snapshot.`
      );
    }
  }

  const payload = {
    jobId: nextJob.id,
    runStatus: effectiveRunStatus(nextJob),
    outcomeStatus: nextJob.outcomeStatus ?? null,
    threadId: nextJob.threadId ?? null,
    workspaceDrift: Boolean(nextJob.workspaceDrift),
    currentSnapshotToken: nextJob.currentSnapshotToken ?? null,
    reconciledSnapshotToken: nextJob.reconciledSnapshotToken ?? null,
    reconciledAt: nextJob.reconciledAt ?? null,
    nextAction: nextJob.nextAction
  };
  const rendered = [
    `Reconciled ${payload.jobId}.`,
    `Run status: ${payload.runStatus}`,
    `Workspace drift: ${payload.workspaceDrift ? "yes" : "no"}`,
    `Next action: ${payload.nextAction}`
  ].join("\n") + "\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, {
    env: process.env,
    reconcile: false
  });
  const requestedAt = nowIso();
  let alreadyFinished = false;
  let routedToReconciliation = false;
  const requested = transitionStoredJob(workspaceRoot, job.id, (current) => {
    if (isTerminalJob(current)) {
      alreadyFinished = true;
      return current;
    }
    if (current.heartbeatAt) {
      const workerIsAlive = workerLooksAlive(current);
      if (!workerIsAlive || !jobHeartbeatIsFresh(current)) {
        routedToReconciliation = true;
        return reconcileJob(workspaceRoot, current, {
          isProcessAlive: () => workerIsAlive
        });
      }
    }
    return transitionJob(current, {
      status: "running",
      phase: "cancelling",
      runStatus: "CANCEL_REQUESTED",
      cancelRequestedAt: requestedAt
    });
  });
  if (effectiveRunStatus(requested) !== "CANCEL_REQUESTED") {
    outputCommandResult({
      jobId: requested.id,
      status: requested.status,
      runStatus: effectiveRunStatus(requested),
      outcomeStatus: requested.outcomeStatus ?? null,
      turnInterruptAttempted: false,
      turnInterrupted: false
    }, renderCancelReport(requested, { alreadyFinished: alreadyFinished && !routedToReconciliation }), options.json);
    return;
  }
  const threadId = requested.threadId ?? null;
  const turnId = requested.turnId ?? null;
  const workerWasAlive = workerLooksAlive(requested);

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      requested.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  const termination = workerWasAlive
    ? terminateProcessTreeVerified(requested.workerIdentity ?? null)
    : { attempted: false, delivered: false };
  const workerExited = workerWasAlive
    ? await waitForProcessExit(requested.pid, { timeoutMs: 2000, pollMs: 50 })
    : false;
  const turnWasActive = Boolean(threadId && turnId);
  const turnStopConfirmed = !turnWasActive || interrupt.interrupted;
  const cancellationConfirmed = workerExited && turnStopConfirmed;
  const nextJob = transitionStoredJob(workspaceRoot, job.id, (current) => {
    if (isTerminalJob(current)) return current;
    if (effectiveRunStatus(current) !== "CANCEL_REQUESTED") return current;
    return transitionJob(current, cancellationConfirmed
      ? {
          status: "cancelled",
          phase: "cancelled",
          runStatus: "CANCELLED",
          outcomeStatus: "CANCELLED",
          completedAt: nowIso(),
          cancelledAt: nowIso(),
          errorMessage: "Cancelled by user.",
          pid: null,
          interrupt,
          termination
        }
      : workerWasAlive && !workerExited
        ? {
            status: "running",
            phase: "cancelling",
            runStatus: "CANCEL_REQUESTED",
            outcomeStatus: "NEEDS_RECONCILIATION",
            pid: requested.pid,
            orphaned: true,
            interrupt,
            termination,
            blocker: {
              kind: "live_worker_cancellation_unconfirmed",
              message: `Worker ${requested.pid} is still alive after cancellation of ${job.id}.`,
              retryWhen: "Retry cancellation or wait for the worker to exit"
            }
          }
        : {
            status: "failed",
            phase: "failed",
            runStatus: "INTERRUPTED",
            outcomeStatus: "NEEDS_RECONCILIATION",
            pid: null,
            interrupt,
            termination,
            blocker: {
              kind: workerExited ? "turn_interrupt_unconfirmed" : "missing_worker_cancellation_unconfirmed",
              message: workerExited
                ? `Worker ${requested.pid} exited, but interruption of turn ${turnId} was not confirmed.`
                : `Cancellation of ${job.id} could not be attributed to a live worker.`,
              retryWhen: "The stored thread and workspace have been reconciled"
            }
          });
  });
  appendLogLine(requested.logFile, effectiveRunStatus(nextJob) === "CANCELLED"
    ? "Cancelled by user."
    : "Cancellation requires reconciliation.");

  const payload = {
    jobId: job.id,
    status: nextJob.status,
    runStatus: effectiveRunStatus(nextJob),
    outcomeStatus: nextJob.outcomeStatus ?? null,
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "reconcile":
      handleReconcile(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "purge":
      handlePurge(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
