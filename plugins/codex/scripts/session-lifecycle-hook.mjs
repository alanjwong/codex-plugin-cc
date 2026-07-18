#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { interruptAppServerTurn } from "./lib/codex.mjs";
import { terminateProcessTreeVerified } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import {
  isActiveJob,
  transitionJob,
  waitForProcessExit,
  workerLooksAlive
} from "./lib/job-reconciliation.mjs";
import { appendJobEvent, listDurableJobs, transitionStoredJob } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

async function interruptSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const activeJobs = listDurableJobs(workspaceRoot).filter(
    (entry) => entry.sessionId === sessionId && isActiveJob(entry)
  );
  await Promise.all(activeJobs.map(async (job) => {
    const interrupt = await interruptAppServerTurn(cwd, {
      threadId: job.threadId ?? null,
      turnId: job.turnId ?? null
    });
    const workerWasAlive = workerLooksAlive(job);
    let termination = { attempted: false, delivered: false };
    try {
      // Legacy records without a stored worker identity are never signaled;
      // reconciliation below handles them conservatively.
      if (workerWasAlive) termination = terminateProcessTreeVerified(job.workerIdentity ?? null);
    } catch {
      // Reconciliation below remains conservative even when termination throws.
    }
    const workerExited = workerWasAlive
      ? await waitForProcessExit(job.pid, { timeoutMs: 2000, pollMs: 50 })
      : false;
    const patch = workerWasAlive && !workerExited
      ? {
          status: "running",
          phase: "cancelling",
          runStatus: "CANCEL_REQUESTED",
          outcomeStatus: "NEEDS_RECONCILIATION",
          pid: job.pid,
          orphaned: true,
          interrupt,
          termination,
          blocker: {
            kind: "live_worker_after_session_end",
            message: `Worker ${job.pid} is still alive after session shutdown.`,
            retryWhen: "A later session retries cancellation or observes worker exit"
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
          interruptedAt: new Date().toISOString()
        };
    const accepted = transitionStoredJob(
      workspaceRoot,
      job.id,
      (current) => transitionJob(current, patch)
    );
    appendJobEvent(workspaceRoot, job.id, {
      type: accepted.runStatus === "CANCEL_REQUESTED"
        ? "session_end_live_worker_retained"
        : accepted.runStatus === "INTERRUPTED"
          ? "session_end_interrupted"
          : "session_end_race_preserved",
      sessionId,
      acceptedRunStatus: accepted.runStatus
    });
  }));
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  await interruptSessionJobs(cwd, sessionId);
  if (brokerEndpoint) await sendBrokerShutdown(brokerEndpoint);
  const brokerIdentity = brokerSession?.identity ?? null;
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    // Signal only an identity-verified broker; a recycled pid (or a legacy
    // session record without identity) is never signaled.
    killProcess: () => terminateProcessTreeVerified(brokerIdentity)
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
