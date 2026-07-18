import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeCodex(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const STATE_LOCK_PATH = STATE_PATH + ".lock";
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const interruptibleTurns = new Map();
	let sigtermCount = 0;

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], turnStarts: [], capabilities: null, lastInterrupt: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

	if (BEHAVIOR === "delay-sigterm") {
	  process.on("SIGTERM", () => {
	    sigtermCount += 1;
	    const state = loadState();
	    state.sigtermCount = sigtermCount;
	    saveState(state);
	    if (sigtermCount > 1 || state.allowSigtermExit) process.exit(143);
	  });
	}

function saveState(state) {
  const temporary = STATE_PATH + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, STATE_PATH);
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withStateLock(callback) {
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      const fd = fs.openSync(STATE_LOCK_PATH, "wx");
      try {
        return callback();
      } finally {
        fs.closeSync(fd);
        if (fs.existsSync(STATE_LOCK_PATH)) fs.unlinkSync(STATE_LOCK_PATH);
      }
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Timed out acquiring fake Codex state lock");
      pause(10);
    }
  }
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function reportedSandbox(requestedSandbox) {
  if (BEHAVIOR === "missing-sandbox") return undefined;
  if (BEHAVIOR === "wrong-sandbox") {
    return { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };
  }
  return requestedSandbox;
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function importLedgerPath() {
  return path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

function taskEnvelope(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    outcomeStatus: "COMPLETED_READ_ONLY",
    report: "Handled the requested task.\\nTask prompt accepted.",
    changedFiles: [],
    checks: [],
    blocker: null,
    inspected: true,
    evidence: ["Task prompt"],
    ...overrides
  });
}

function typedTaskPayload(prompt, resume, thread) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    return taskEnvelope({
      report: BEHAVIOR === "adversarial-clean"
        ? "ALLOW: No blocking issues found in the previous turn."
        : "BLOCK: Missing empty-state guard in src/app.js:4-6.",
      evidence: ["Previous Claude response"]
    });
  }

  if (BEHAVIOR === "task-invalid-json") {
    return "not valid json";
  }
  if (BEHAVIOR === "task-blocked") {
    return taskEnvelope({
      outcomeStatus: "BLOCKED",
      report: "The required host is unavailable.",
      blocker: {
        kind: "runtime",
        message: "Host unavailable",
        retryWhen: "Host is installed"
      }
    });
  }
  if (BEHAVIOR === "task-partial") {
    return taskEnvelope({
      outcomeStatus: "PARTIAL",
      report: "Completed the inspection, but one follow-up remains."
    });
  }
  if (BEHAVIOR === "task-write-no-events") {
    fs.writeFileSync(path.join(thread.cwd, "output.txt"), "fixture task output\\n", "utf8");
    return taskEnvelope({
      outcomeStatus: "READY_FOR_INTEGRATION",
      report: "Wrote output.txt.",
      changedFiles: ["output.txt"]
    });
  }
  if (BEHAVIOR === "task-write-with-drift") {
    fs.writeFileSync(path.join(thread.cwd, "app.txt"), "fixture app change\\n", "utf8");
    fs.writeFileSync(path.join(thread.cwd, "scratch-drift.txt"), "fixture drift\\n", "utf8");
    return taskEnvelope({
      outcomeStatus: "READY_FOR_INTEGRATION",
      report: "Updated app.txt.",
      changedFiles: ["app.txt"]
    });
  }
  if (BEHAVIOR === "task-write-canonical-event") {
    fs.writeFileSync(path.join(fs.realpathSync(thread.cwd), "app.txt"), "fixture app change\\n", "utf8");
    return taskEnvelope({
      outcomeStatus: "READY_FOR_INTEGRATION",
      report: "Updated app.txt.",
      changedFiles: ["app.txt"]
    });
  }
  if (BEHAVIOR === "task-read-only-with-drift") {
    fs.writeFileSync(path.join(thread.cwd, "scratch-drift.txt"), "fixture drift\\n", "utf8");
  }
  if (BEHAVIOR === "interruptible-partial-write") {
    const turnCount = loadState().turnStarts.filter((turn) => turn.threadId === thread.id).length;
    if (turnCount === 1) {
      fs.writeFileSync(path.join(thread.cwd, "partial-edit.txt"), "partial edit\\n", "utf8");
    } else {
      fs.appendFileSync(path.join(thread.cwd, "partial-edit.txt"), "resumed edit\\n", "utf8");
      return taskEnvelope({
        outcomeStatus: "READY_FOR_INTEGRATION",
        report: "Completed partial-edit.txt.",
        changedFiles: ["partial-edit.txt"]
      });
    }
  }

  const report = resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")
    ? "Resumed the prior run.\\nFollow-up prompt accepted."
    : "Handled the requested task.\\nTask prompt accepted.";
  if (thread.sandbox === "workspace-write") {
    return taskEnvelope({
      outcomeStatus: "READY_FOR_INTEGRATION",
      report
    });
  }
  return taskEnvelope({ report });
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
withStateLock(() => {
  const bootState = loadState();
  bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
  saveState(bootState);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  withStateLock(() => {
    const message = JSON.parse(line);
    const state = loadState();

    try {
      switch (message.method) {
      case "initialize":
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "initialized":
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        thread.sandbox = message.params.sandbox;
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: reportedSandbox(message.params.sandbox), reasoningEffort: null } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        thread.sandbox = message.params.sandbox;
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: reportedSandbox(message.params.sandbox), reasoningEffort: null } });
        break;
      }

      case "externalAgentConfig/import": {
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        if (BEHAVIOR === "external-import-fails") {
          send({ id: message.id, result: {} });
          send({ method: "externalAgentConfig/import/completed", params: {} });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        const sourcePath = fs.realpathSync(session.path);
        const contents = fs.readFileSync(sourcePath, "utf8");
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages };
          record = {
            source_path: sourcePath,
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveState(state);
          saveImportLedger(ledger);
        }
        send({ id: message.id, result: {} });
        send({ method: "externalAgentConfig/import/completed", params: {} });
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        if (BEHAVIOR === "task-infrastructure-throw") {
	          throw new Error("failed to spawn code-mode host");
	        }
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        const turnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          prompt
	        };
	        state.lastTurnStart = turnStart;
	        state.turnStarts = [...(state.turnStarts || []), turnStart];
	        saveState(state);
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        if (BEHAVIOR === "task-stalls-silently") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          break;
        }

        if (BEHAVIOR === "task-transport-dies") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: { type: "agentMessage", id: "msg_" + turnId, text: "partial", phase: "commentary" }
            }
          });
          setTimeout(() => process.exit(42), 10);
          break;
        }

        const resume = thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state");
        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.outcomeStatus
            ? typedTaskPayload(prompt, resume, thread)
            : taskPayload(prompt, resume);

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          ...(BEHAVIOR === "task-turn-failed-no-message" || (BEHAVIOR === "interruptible-partial-write" && state.turnStarts.filter((turn) => turn.threadId === thread.id).length === 1)
            ? []
            : [{
                completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }]),
          ...(BEHAVIOR === "task-write-with-drift" || BEHAVIOR === "task-write-canonical-event" || BEHAVIOR === "interruptible-partial-write"
            ? [{
                completed: {
                  type: "fileChange",
                  id: "file_" + turnId,
                  changes: BEHAVIOR === "interruptible-partial-write"
                    ? [{ path: "partial-edit.txt" }]
                    : [{
                        path: BEHAVIOR === "task-write-canonical-event"
                          ? path.join(fs.realpathSync(thread.cwd), "app.txt")
                          : path.join(thread.cwd, "app.txt"),
                        kind: "update"
                      }],
                  status: "completed"
                }
              }]
            : [])
        ];

	        if (BEHAVIOR === "task-turn-failed" || BEHAVIOR === "task-turn-failed-no-message") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          for (const entry of items) {
	            if (entry && entry.completed) {
	              send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	            }
	          }
	          const error = { message: "fixture turn failure" };
	          send({ method: "error", params: { threadId: thread.id, turnId, error } });
	          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "failed", error) } });
	        } else if (BEHAVIOR === "interruptible-slow-task" || BEHAVIOR === "interrupt-fails" || (BEHAVIOR === "interruptible-partial-write" && state.turnStarts.filter((turn) => turn.threadId === thread.id).length === 1)) {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          for (const entry of BEHAVIOR === "interruptible-partial-write" ? items : []) {
	            if (entry && entry.completed) {
	              send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	            }
	          }
	          const timer = BEHAVIOR === "interruptible-partial-write" ? null : setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) return;
	            interruptibleTurns.delete(turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	            }
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/interrupt": {
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        if (BEHAVIOR === "interrupt-fails") {
	          send({ id: message.id, error: { code: -32000, message: "fixture interrupt failure" } });
	          break;
	        }
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending) {
	          if (pending.timer) clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
	      }
	    } catch (error) {
	      send({ id: message.id, error: { code: -32000, message: error.message } });
	    }
	  });
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}
