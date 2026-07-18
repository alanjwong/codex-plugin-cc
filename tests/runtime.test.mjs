import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import {
  loadState,
  readJobFile,
  resolveStateDir,
  transitionStoredJob
} from "../plugins/codex/scripts/lib/state.mjs";
import { processIsAlive } from "../plugins/codex/scripts/lib/job-reconciliation.mjs";
import { captureProcessIdentity } from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function spawnDetachedSleeper(cwd, source = "setInterval(() => {}, 1000)", launchToken = null) {
  const launcher = run(process.execPath, [
    "-e",
    `const { spawn } = require("node:child_process"); const args = ["-e", ${JSON.stringify(source)}]; const launchToken = ${JSON.stringify(launchToken)}; if (launchToken) args.push("--", "--launch-token", launchToken); const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" }); child.unref(); process.stdout.write(String(child.pid));`
  ], { cwd });
  assert.equal(launcher.status, 0, launcher.stderr);
  const pid = Number(launcher.stdout.trim());
  assert.equal(Number.isFinite(pid), true);
  return { pid };
}

function loadFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/codex:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/codex:transfer"]
  );
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-fails");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "--read-only", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--read-only", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Outcome: COMPLETED_READ_ONLY\n\nResumed the prior run.\nFollow-up prompt accepted.\n");
});

test("simultaneous idempotent task attempts return the same job id and start one thread", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  const env = buildEnv(binDir);
  const args = [
    SCRIPT,
    "task",
    "--read-only",
    "--background",
    "--json",
    "--workflow-id",
    "wf-shared",
    "--task-id",
    "task-shared",
    "inspect the retry path"
  ];

  const [left, right] = await Promise.all([
    spawnCommand("node", args, { cwd: repo, env }),
    spawnCommand("node", args, { cwd: repo, env })
  ]);

  assert.equal(left.status, 0, left.stderr);
  assert.equal(right.status, 0, right.stderr);
  const leftPayload = JSON.parse(left.stdout);
  const rightPayload = JSON.parse(right.stdout);
  assert.equal(leftPayload.jobId, rightPayload.jobId);
  const fakeState = await waitFor(() => {
    if (!fs.existsSync(path.join(binDir, "fake-codex-state.json"))) return null;
    const state = loadFakeState(binDir);
    return state.threads.length === 1 ? state : null;
  }, { timeoutMs: 15000 });
  assert.equal(fakeState.threads.length, 1);
});

test("simultaneous workflow reservation with changed input rejects one attempt", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  const env = buildEnv(binDir);
  const base = [
    SCRIPT,
    "task",
    "--read-only",
    "--background",
    "--json",
    "--workflow-id",
    "wf-conflict",
    "--task-id",
    "task-conflict"
  ];

  const results = await Promise.all([
    spawnCommand("node", [...base, "inspect the retry path"], { cwd: repo, env }),
    spawnCommand("node", [...base, "rewrite the retry path"], { cwd: repo, env })
  ]);
  const winner = results.find((result) => result.status === 0);
  const loser = results.find((result) => result.status !== 0);
  assert.ok(winner, results.map((result) => result.stderr).join("\n"));
  assert.ok(loser, results.map((result) => result.stdout).join("\n"));
  const winnerPayload = JSON.parse(winner.stdout);
  assert.match(loser.stderr, new RegExp(winnerPayload.jobId));
  assert.match(loser.stderr, /same workflow and task attempt.*different request/i);
  assert.equal(loadState(repo).jobs.length, 1);
  const fakeState = await waitFor(() => {
    if (!fs.existsSync(path.join(binDir, "fake-codex-state.json"))) return null;
    const state = loadFakeState(binDir);
    return state.threads.length === 1 ? state : null;
  }, { timeoutMs: 15000 });
  assert.equal(fakeState.threads.length, 1);
});

test("simultaneous workflow writers share one workspace reservation from root and nested cwd", async () => {
  const repo = makeTempDir();
  const nested = path.join(repo, "src", "nested");
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.mkdirSync(nested, { recursive: true });
  const env = buildEnv(binDir);
  const taskArgs = (workflowId, taskId, prompt) => [
    SCRIPT,
    "task",
    "--write",
    "--background",
    "--json",
    "--workflow-id",
    workflowId,
    "--task-id",
    taskId,
    prompt
  ];

  const results = await Promise.all([
    spawnCommand("node", taskArgs("wf-root", "task-root", "update the root task"), { cwd: repo, env }),
    spawnCommand("node", taskArgs("wf-nested", "task-nested", "update the nested task"), { cwd: nested, env })
  ]);
  const winner = results.find((result) => result.status === 0);
  const loser = results.find((result) => result.status !== 0);
  assert.ok(winner, results.map((result) => result.stderr).join("\n"));
  assert.ok(loser, results.map((result) => result.stdout).join("\n"));
  const winnerPayload = JSON.parse(winner.stdout);
  assert.match(loser.stderr, new RegExp(winnerPayload.jobId));
  assert.match(loser.stderr, /active write attempt/i);
  const fakeState = await waitFor(() => {
    if (!fs.existsSync(path.join(binDir, "fake-codex-state.json"))) return null;
    const state = loadFakeState(binDir);
    return state.turnStarts?.length === 1 ? state : null;
  }, { timeoutMs: 15000 });
  assert.equal(fakeState.turnStarts.length, 1);
});

test("an active workflow writer does not block an unrelated read-only task", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  const env = buildEnv(binDir);

  const writer = run("node", [
    SCRIPT,
    "task",
    "--write",
    "--background",
    "--json",
    "--workflow-id",
    "wf-writer",
    "--task-id",
    "task-writer",
    "update the app"
  ], { cwd: repo, env });
  assert.equal(writer.status, 0, writer.stderr);
  await waitFor(() => {
    if (!fs.existsSync(path.join(binDir, "fake-codex-state.json"))) return false;
    return loadFakeState(binDir).turnStarts?.length === 1;
  }, { timeoutMs: 15000 });

  const reader = run("node", [
    SCRIPT,
    "task",
    "--read-only",
    "--background",
    "--json",
    "--workflow-id",
    "wf-reader",
    "--task-id",
    "task-reader",
    "inspect the app"
  ], { cwd: repo, env });
  assert.equal(reader.status, 0, reader.stderr);
  const fakeState = await waitFor(() => {
    const state = loadFakeState(binDir);
    return state.turnStarts?.length === 2 ? state : null;
  }, { timeoutMs: 15000 });
  assert.equal(fakeState.turnStarts.length, 2);
});

test("workflow writers in linked worktrees use different state directories", async () => {
  const repo = makeTempDir();
  const linkedParent = makeTempDir();
  const linked = path.join(linkedParent, "linked");
  const pluginDataDir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "fixture"], { cwd: repo });
  const added = run("git", ["worktree", "add", "-b", "fixture-linked", linked], { cwd: repo });
  assert.equal(added.status, 0, added.stderr);
  const env = { ...buildEnv(binDir), CLAUDE_PLUGIN_DATA: pluginDataDir };
  const taskArgs = (workflowId, taskId, prompt) => [
    SCRIPT,
    "task",
    "--write",
    "--background",
    "--json",
    "--workflow-id",
    workflowId,
    "--task-id",
    taskId,
    prompt
  ];

  const [left, right] = await Promise.all([
    spawnCommand("node", taskArgs("wf-main", "task-main", "update the main worktree"), { cwd: repo, env }),
    spawnCommand("node", taskArgs("wf-linked", "task-linked", "update the linked worktree"), { cwd: linked, env })
  ]);
  assert.equal(left.status, 0, left.stderr);
  assert.equal(right.status, 0, right.stderr);
  assert.notEqual(JSON.parse(left.stdout).jobId, JSON.parse(right.stdout).jobId);
  const stateDirs = await waitFor(() => {
    const stateRoot = path.join(pluginDataDir, "state");
    if (!fs.existsSync(stateRoot)) return null;
    const directories = fs.readdirSync(stateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    if (directories.length !== 2) return null;
    const jobs = directories.flatMap((directory) => {
      const stateFile = path.join(stateRoot, directory, "state.json");
      if (!fs.existsSync(stateFile)) return [];
      return JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
    });
    return jobs.length === 2 && jobs.every((job) => job.runStatus === "RUNNING")
      ? directories
      : null;
  }, { timeoutMs: 15000 });
  const fakeState = await waitFor(() => {
    if (!fs.existsSync(path.join(binDir, "fake-codex-state.json"))) return null;
    const state = loadFakeState(binDir);
    return state.turnStarts?.length === 2 ? state : null;
  }, { timeoutMs: 15000 });
  assert.equal(fakeState.turnStarts.length, 2);
  assert.equal(stateDirs.length, 2);
  assert.notEqual(stateDirs[0], stateDirs[1]);
});

test("task --resume-job resumes the requested thread rather than the newest thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);

  assert.equal(run("node", [SCRIPT, "task", "--read-only", "first task"], { cwd: repo, env }).status, 0);
  const first = loadState(repo).jobs[0];
  assert.equal(run("node", [SCRIPT, "task", "--read-only", "second task"], { cwd: repo, env }).status, 0);

  const resumed = run(
    "node",
    [SCRIPT, "task", "--read-only", "--resume-job", first.id, "follow up first"],
    { cwd: repo, env }
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, first.threadId);
  const child = loadState(repo).jobs[0];
  assert.equal(child.parentJobId, first.id);
  assert.equal(child.taskId, first.taskId);
  assert.notEqual(child.attemptId, first.attemptId);
});

test("exact resume can cross Claude sessions but not workspaces", () => {
  const repo = makeTempDir();
  const otherRepo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  for (const workspace of [repo, otherRepo]) {
    initGitRepo(workspace);
    fs.writeFileSync(path.join(workspace, "README.md"), "fixture\n", "utf8");
    run("git", ["add", "README.md"], { cwd: workspace });
    run("git", ["commit", "-m", "fixture"], { cwd: workspace });
  }
  const baseEnv = buildEnv(binDir);
  const firstSession = { ...baseEnv, CODEX_COMPANION_SESSION_ID: "sess-one" };
  const secondSession = { ...baseEnv, CODEX_COMPANION_SESSION_ID: "sess-two" };

  const firstRun = run("node", [SCRIPT, "task", "--read-only", "inspect the first repo"], {
    cwd: repo,
    env: firstSession
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const parent = loadState(repo).jobs[0];
  assert.match(parent.completionSnapshotToken, /^[a-f0-9]{64}$/);

  const resumed = run(
    "node",
    [SCRIPT, "task", "--read-only", "--resume-job", parent.id, "continue the inspection"],
    { cwd: repo, env: secondSession }
  );
  assert.equal(resumed.status, 0, resumed.stderr);

  fs.writeFileSync(path.join(repo, "README.md"), "fixture changed after completion\n", "utf8");
  const driftedResume = run(
    "node",
    [SCRIPT, "task", "--read-only", "--resume-job", parent.id, "continue after drift"],
    { cwd: repo, env: secondSession }
  );
  assert.equal(driftedResume.status, 1);
  assert.match(driftedResume.stderr, /needs reconciliation/i);

  const observed = run("node", [SCRIPT, "reconcile", parent.id, "--json"], {
    cwd: repo,
    env: secondSession
  });
  assert.equal(observed.status, 0, observed.stderr);
  const observedPayload = JSON.parse(observed.stdout);
  assert.equal(observedPayload.workspaceDrift, true);
  assert.match(observedPayload.currentSnapshotToken, /^[a-f0-9]{64}$/);

  const accepted = run(
    "node",
    [SCRIPT, "reconcile", parent.id, "--accept-snapshot", observedPayload.currentSnapshotToken, "--json"],
    { cwd: repo, env: secondSession }
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).nextAction, "resume_exact_job");
  const resumedAfterAcceptance = run(
    "node",
    [SCRIPT, "task", "--read-only", "--resume-job", parent.id, "continue after acceptance"],
    { cwd: repo, env: secondSession }
  );
  assert.equal(resumedAfterAcceptance.status, 0, resumedAfterAcceptance.stderr);

  const wrongWorkspace = run(
    "node",
    [SCRIPT, "task", "--read-only", "--resume-job", parent.id, "continue the inspection"],
    { cwd: otherRepo, env: secondSession }
  );
  assert.equal(wrongWorkspace.status, 1);
  assert.match(wrongWorkspace.stderr, /No job found|workspace mismatch/i);
});

test("exact snapshot reconciliation notices later tracked and untracked content changes", async (t) => {
  for (const variant of ["tracked", "untracked"]) {
    await t.test(variant, () => {
      const repo = makeTempDir();
      const binDir = makeTempDir();
      installFakeCodex(binDir);
      initGitRepo(repo);
      fs.writeFileSync(path.join(repo, "README.md"), "fixture\n", "utf8");
      run("git", ["add", "README.md"], { cwd: repo });
      run("git", ["commit", "-m", "fixture"], { cwd: repo });
      const changedPath = variant === "tracked"
        ? path.join(repo, "README.md")
        : path.join(repo, "notes.txt");
      fs.writeFileSync(changedPath, "dirty before task\n", "utf8");
      const env = buildEnv(binDir);

      const initial = run("node", [SCRIPT, "task", "--read-only", "inspect dirty state"], { cwd: repo, env });
      assert.equal(initial.status, 0, initial.stderr);
      const parent = loadState(repo).jobs[0];
      const reconciled = run("node", [SCRIPT, "reconcile", parent.id, "--json"], { cwd: repo, env });
      assert.equal(reconciled.status, 0, reconciled.stderr);
      assert.equal(JSON.parse(reconciled.stdout).workspaceDrift, false);

      fs.writeFileSync(changedPath, "dirty after reconciliation\n", "utf8");
      const resume = run(
        "node",
        [SCRIPT, "task", "--read-only", "--resume-job", parent.id, "continue inspection"],
        { cwd: repo, env }
      );
      assert.equal(resume.status, 1);
      assert.match(resume.stderr, /needs reconciliation/i);
    });
  }
});

test("reconcile records a clean baseline without starting Codex", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "fixture"], { cwd: repo });
  const env = buildEnv(binDir);

  const initial = run("node", [SCRIPT, "task", "--read-only", "inspect"], { cwd: repo, env });
  assert.equal(initial.status, 0, initial.stderr);
  const job = loadState(repo).jobs[0];
  const fakeStateBefore = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));

  const result = run("node", [SCRIPT, "reconcile", job.id, "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.workspaceDrift, false);
  assert.equal(payload.nextAction, "resume_exact_job");
  assert.match(payload.reconciledAt, /^\d{4}-\d{2}-\d{2}T/);

  const fakeStateAfter = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeStateAfter.nextTurnId, fakeStateBefore.nextTurnId);
  assert.equal(fakeStateAfter.threads.length, fakeStateBefore.threads.length);
});

test("an interrupted non-Git write cannot accept an arbitrary snapshot token", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  transitionStoredJob(repo, "task-nongit", () => ({
    id: "task-nongit",
    status: "failed",
    runStatus: "INTERRUPTED",
    outcomeStatus: "NEEDS_RECONCILIATION",
    jobClass: "task",
    intent: "write",
    write: true,
    workspaceRealpath: fs.realpathSync(repo),
    threadId: "thr_nongit",
    preflight: {
      workspaceRealpath: fs.realpathSync(repo),
      git: null
    }
  }));

  const result = run(
    "node",
    [SCRIPT, "reconcile", "task-nongit", "--accept-snapshot", "a".repeat(64), "--json"],
    { cwd: repo, env }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no exact Git snapshot/i);
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), false);
});

test("status preserves a queued start lease and interrupts it only after expiry", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);
  transitionStoredJob(repo, "task-reserved", () => ({
    id: "task-reserved",
    status: "queued",
    runStatus: "QUEUED",
    outcomeStatus: null,
    jobClass: "task",
    intent: "write",
    write: true,
    pid: null,
    reservedAt: new Date().toISOString(),
    startDeadlineAt: new Date(Date.now() + 15000).toISOString()
  }));

  const healthy = run("node", [SCRIPT, "status", "task-reserved", "--json"], { cwd: repo, env });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).job.runStatus, "QUEUED");
  assert.equal(loadState(repo).jobs[0].runStatus, "QUEUED");

  transitionStoredJob(repo, "task-reserved", (current) => ({
    ...current,
    startDeadlineAt: new Date(Date.now() - 1000).toISOString()
  }));
  const expired = run("node", [SCRIPT, "status", "task-reserved", "--json"], { cwd: repo, env });
  assert.equal(expired.status, 0, expired.stderr);
  assert.equal(JSON.parse(expired.stdout).job.runStatus, "INTERRUPTED");
  assert.equal(loadState(repo).jobs[0].outcomeStatus, "NEEDS_RECONCILIATION");

  const jobId = loadState(repo).jobs[0].id;
  const events = fs
    .readFileSync(path.join(resolveStateDir(repo), "jobs", `${jobId}.events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const reconciledEvent = events.find((event) => event.type === "reconciled");
  assert.ok(reconciledEvent, "reconciliation must append an event");
  assert.equal(reconciledEvent.acceptedRunStatus, "INTERRUPTED");
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "--read-only", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--read-only", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--read-only", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Outcome: READY_FOR_INTEGRATION\n\nHandled the requested task.\nTask prompt accepted.\n");
});

test("blocked task output is finished, persisted separately, and rendered honestly", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-blocked");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const task = run("node", [SCRIPT, "task", "--read-only", "--json", "inspect the runtime"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(task.status, 0, task.stderr);
  const taskPayload = JSON.parse(task.stdout);
  assert.equal(taskPayload.runStatus, "FINISHED");
  assert.equal(taskPayload.outcomeStatus, "BLOCKED");
  assert.equal(taskPayload.outcome.success, false);

  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const jobId = state.jobs[0].id;
  const status = run("node", [SCRIPT, "status", jobId, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.job.status, "completed");
  assert.equal(statusPayload.job.runStatus, "FINISHED");
  assert.equal(statusPayload.job.outcomeStatus, "BLOCKED");

  const result = run("node", [SCRIPT, "result", jobId, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal(resultPayload.job.runStatus, "FINISHED");
  assert.equal(resultPayload.job.outcomeStatus, "BLOCKED");
  assert.equal(resultPayload.storedJob.runStatus, "FINISHED");
  assert.equal(resultPayload.storedJob.outcomeStatus, "BLOCKED");

  const human = run("node", [SCRIPT, "result", jobId], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^Outcome: BLOCKED/);
});

test("partial task output is a valid finished semantic outcome", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-partial");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--read-only", "--json", "inspect what is available"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runStatus, "FINISHED");
  assert.equal(payload.outcomeStatus, "PARTIAL");
  assert.equal(payload.outcome.success, false);
});

test("invalid task output is a finished transport with an unclassified protocol result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-invalid-json");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--read-only", "--json", "inspect the target"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runStatus, "FINISHED");
  assert.equal(payload.outcomeStatus, "UNCLASSIFIED");
  assert.equal(payload.transport.status, 0);
  assert.ok(["broker", "direct"].includes(payload.transport.kind), `transport kind recorded (${payload.transport.kind})`);
  assert.equal(payload.rawOutput, "not valid json");
  assert.match(payload.outcome.protocolError, /valid JSON/);
});

test("failed task turn ignores valid-looking output and becomes infrastructure failure", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-turn-failed");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--read-only", "--json", "inspect the target"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runStatus, "FAILED");
  assert.equal(payload.outcomeStatus, "INFRA_FAILED");
  assert.match(payload.rawOutput, /COMPLETED_READ_ONLY/);
  assert.equal(payload.transport.turnStatus, "failed");
  assert.equal(payload.transport.error, "fixture turn failure");
});

test("failed task turn without a final message preserves infrastructure error evidence", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-turn-failed-no-message");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--read-only", "--json", "inspect the target"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outcomeStatus, "INFRA_FAILED");
  assert.equal(payload.rawOutput, "");
  assert.equal(payload.transport.error, "fixture turn failure");
  assert.match(payload.outcome.report, /fixture turn failure/);
});

test("task infrastructure throw is persisted as a durable infrastructure outcome", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-infrastructure-throw");
  initGitRepo(repo);

  const task = run("node", [SCRIPT, "task", "--read-only", "--json", "inspect the target"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(task.status, 1);
  const taskPayload = JSON.parse(task.stdout);
  assert.equal(taskPayload.runStatus, "FAILED");
  assert.equal(taskPayload.outcomeStatus, "INFRA_FAILED");
  assert.match(taskPayload.outcome.report, /failed to spawn code-mode host/);

  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const jobId = state.jobs[0].id;
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].runStatus, "FAILED");
  assert.equal(state.jobs[0].outcomeStatus, "INFRA_FAILED");

  const result = run("node", [SCRIPT, "result", jobId, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal(resultPayload.storedJob.outcomeStatus, "INFRA_FAILED");
});

test("task output write without events in a non-Git workspace keeps a corroboration warning", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-write-no-events");

  const result = run("node", [SCRIPT, "task", "--write", "--json", "write the output"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runStatus, "FINISHED");
  assert.equal(payload.outcomeStatus, "READY_FOR_INTEGRATION");
  assert.deepEqual(payload.eventTouchedFiles, []);
  assert.deepEqual(payload.snapshotChangedFiles, []);
  assert.deepEqual(payload.reportedChangedFiles, ["output.txt"]);
  assert.match(payload.outcome.consistencyWarnings.join("\n"), /could not be corroborated/);
  assert.equal(fs.readFileSync(path.join(repo, "output.txt"), "utf8"), "fixture task output\n");
});

test("task output write with drift finishes needing reconciliation and names the blocker file", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-write-with-drift");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--write", "--json", "update the app"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runStatus, "FINISHED");
  assert.equal(payload.outcomeStatus, "NEEDS_RECONCILIATION");
  assert.deepEqual(payload.eventTouchedFiles, ["app.txt"]);
  assert.deepEqual(payload.snapshotChangedFiles, ["app.txt", "scratch-drift.txt"]);
  assert.deepEqual(payload.reportedChangedFiles, ["app.txt"]);
  assert.deepEqual(payload.unattributedDriftFiles, ["scratch-drift.txt"]);
  assert.equal(payload.outcome.blocker.kind, "workspace_drift");
  assert.match(payload.outcome.blocker.message, /scratch-drift\.txt/);
});

test("canonical event paths normalize inside a symlinked workspace root", () => {
  const realWorkspace = makeTempDir();
  const linkParent = makeTempDir();
  const linkedWorkspace = path.join(linkParent, "linked-workspace");
  fs.symlinkSync(realWorkspace, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-write-canonical-event");

  const result = run("node", [SCRIPT, "task", "--write", "--cwd", linkedWorkspace, "--json", "update the app"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outcomeStatus, "READY_FOR_INTEGRATION");
  assert.deepEqual(payload.eventTouchedFiles, ["app.txt"]);
  assert.equal(fs.readFileSync(path.join(realWorkspace, "app.txt"), "utf8"), "fixture app change\n");
});

test("read-only task output keeps its semantic outcome when snapshot drift appears", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-read-only-with-drift");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--read-only", "--json", "inspect the app"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runStatus, "FINISHED");
  assert.equal(payload.outcomeStatus, "COMPLETED_READ_ONLY");
  assert.deepEqual(payload.unattributedDriftFiles, ["scratch-drift.txt"]);
  assert.match(payload.outcome.consistencyWarnings.join("\n"), /drift/i);
});

test("inexact deinitialized gitlink evidence degrades uncorroborated task output to a warning", () => {
  const origin = makeTempDir();
  initGitRepo(origin);
  fs.writeFileSync(path.join(origin, "README.md"), "submodule\n", "utf8");
  run("git", ["add", "README.md"], { cwd: origin });
  run("git", ["commit", "-m", "init submodule"], { cwd: origin });

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-write-no-events");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "parent\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init parent"], { cwd: repo });
  run("git", ["-c", "protocol.file.allow=always", "submodule", "add", origin, "vendor/sub"], { cwd: repo });
  run("git", ["commit", "-am", "add submodule"], { cwd: repo });
  run("git", ["submodule", "deinit", "-f", "vendor/sub"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "output.txt"), "fixture task output\n", "utf8");

  const result = run("node", [SCRIPT, "task", "--write", "--json", "write the output"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.finalSnapshot.git.exact, false);
  assert.equal(payload.outcomeStatus, "READY_FOR_INTEGRATION");
  assert.deepEqual(payload.snapshotChangedFiles, []);
  assert.match(payload.outcome.consistencyWarnings.join("\n"), /could not be corroborated/);
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "--read-only", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--read-only", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Outcome: COMPLETED_READ_ONLY\n\nHandled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Outcome: COMPLETED_READ_ONLY\n\nHandled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Outcome: COMPLETED_READ_ONLY\n\nHandled the requested task.\nTask prompt accepted.\n");
});

test("task using the shared broker still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "task", "--read-only", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Outcome: COMPLETED_READ_ONLY\n\nHandled the requested task.\nTask prompt accepted.\n");
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--read-only", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("a silently stalled task reports turn quietness and remains user-cancellable", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-stalls-silently");
  initGitRepo(repo);
  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_TURN_QUIET_WARN_MS: "25"
  };

  const launched = run(
    "node",
    [SCRIPT, "task", "--read-only", "--background", "--json", "observe the silent turn"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  t.after(() => {
    const job = loadState(repo).jobs.find((entry) => entry.id === jobId);
    for (const pid of [job?.pid, loadBrokerSession(repo)?.pid]) {
      if (!Number.isFinite(pid)) continue;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The successful cancel path already stopped it.
        }
      }
    }
  });

  const claimed = await waitFor(() => {
    const job = loadState(repo).jobs.find((entry) => entry.id === jobId);
    return job?.runStatus === "RUNNING" && job.turnId && job.lastProgressAt ? job : null;
  }, { timeoutMs: 15_000 });
  const claimProgressAt = claimed.lastProgressAt;

  const persistedActivity = await waitFor(() => {
    const job = loadState(repo).jobs.find((entry) => entry.id === jobId);
    return job?.lastProgressAt && job.lastProgressAt !== claimProgressAt ? job : null;
  }, { timeoutMs: 8_000 });
  assert.equal(persistedActivity.runStatus, "RUNNING");

  const quietStatus = await waitFor(() => {
    const status = run("node", [SCRIPT, "status", jobId, "--json"], { cwd: repo, env });
    if (status.status !== 0) return null;
    const payload = JSON.parse(status.stdout);
    return payload.job.turnQuietWarning ? payload : null;
  }, { timeoutMs: 3_000 });
  assert.equal(quietStatus.job.lastProgressAt, persistedActivity.lastProgressAt);
  assert.equal(quietStatus.job.turnQuietWarning, true);
  assert.ok(quietStatus.job.turnQuietMs > 25);

  const cancelled = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).runStatus, "CANCELLED");
  assert.equal(loadState(repo).jobs.find((entry) => entry.id === jobId).runStatus, "CANCELLED");
});

test("an app-server transport death fails promptly with exact resume identifiers", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-transport-dies");
  initGitRepo(repo);
  const env = buildEnv(binDir);

  const launched = run(
    "node",
    [SCRIPT, "task", "--read-only", "--background", "--json", "observe transport failure"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  t.after(() => {
    const job = loadState(repo).jobs.find((entry) => entry.id === jobId);
    for (const pid of [job?.pid, loadBrokerSession(repo)?.pid]) {
      if (!Number.isFinite(pid)) continue;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Expected once transport propagation has completed.
        }
      }
    }
  });

  const failed = await waitFor(() => {
    const job = loadState(repo).jobs.find((entry) => entry.id === jobId);
    return job?.runStatus === "FAILED" ? job : null;
  }, { timeoutMs: 8_000 });

  assert.equal(failed.outcomeStatus, "INFRA_FAILED");
  assert.equal(failed.outcome.blocker.kind, "transport_failure");
  assert.equal(failed.outcome.retryable, true);
  assert.match(failed.outcome.blocker.retryWhen, /Retry, or reconcile and resume the stored thread/);
  assert.match(failed.threadId, /^thr_/);
  assert.match(failed.turnId, /^turn_/);
  assert.equal(failed.result.threadId, failed.threadId);
  assert.equal(failed.result.turnId, failed.turnId);
  assert.equal(failed.result.outcome.blocker.kind, "transport_failure");
  assert.equal(failed.pid, null);
  assert.match(failed.pluginVersion ?? "", /^\d+\.\d+\.\d+/, "job records carry the plugin version");
  assert.ok(
    ["broker", "direct"].includes(failed.result.transport.kind),
    `transport kind recorded on failure (${failed.result.transport.kind})`
  );
  if (failed.result.transport.kind === "broker") {
    const logFile = loadBrokerSession(repo)?.logFile;
    assert.ok(logFile, "broker session must expose its log file");
    await waitFor(() => {
      const contents = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      return contents.includes("codex app-server exited mid-session") ? contents : null;
    }, { timeoutMs: 4_000 });
  }
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/codex:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.codex.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Codex Status/);
  assert.match(status.stdout, /Codex Review/);
  assert.match(status.stdout, /completed/);
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/codex:status review-live`<br>`\/codex:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Codex session ID: thr_1/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            status: "running",
            title: "Codex Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "Codex Adversarial Review",
            jobClass: "review",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        runStatus: "RUNNING",
        title: "Codex Task",
        jobClass: "task",
        summary: "Investigate flaky test",
        pid: process.pid,
        logFile,
        createdAt: "2026-03-18T15:30:00.000Z",
        startedAt: "2026-03-18T15:30:01.000Z",
        updatedAt: "2026-03-18T15:30:02.000Z"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            runStatus: "RUNNING",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: process.pid,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          codex: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_current",
        result: {
          codex: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_other",
        result: {
          codex: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n"
  );
});

test("result for a finished write-capable task returns the typed Codex outcome", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Outcome: READY_FOR_INTEGRATION\n\nHandled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const launchToken = "cancel-live-token-0123456789abcdef";
  const sleeper = spawnDetachedSleeper(workspace, undefined, launchToken);
  const workerIdentity = { ...captureProcessIdentity(sleeper.pid), token: launchToken };

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        runStatus: "RUNNING",
        title: "Codex Task",
        jobClass: "task",
        summary: "Investigate flaky test",
        pid: sleeper.pid,
        workerIdentity,
        logFile,
        createdAt: "2026-03-18T15:30:00.000Z",
        startedAt: "2026-03-18T15:30:01.000Z",
        updatedAt: "2026-03-18T15:30:02.000Z"
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            workerIdentity,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel never signals a legacy record that has no worker identity", async (t) => {
  const workspace = makeTempDir();
  const sleeper = spawnDetachedSleeper(workspace);
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });
  transitionStoredJob(workspace, "task-legacy", () => ({
    id: "task-legacy",
    status: "running",
    runStatus: "RUNNING",
    outcomeStatus: null,
    title: "Codex Task",
    jobClass: "task",
    intent: "read-only",
    // Legacy shape: a pid but no workerIdentity. The pid may have been
    // recycled by an unrelated process, so it must never be signaled.
    pid: sleeper.pid
  }));

  const result = run("node", [SCRIPT, "cancel", "task-legacy", "--json"], { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runStatus, "CANCEL_REQUESTED");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(processIsAlive(sleeper.pid), true, "legacy pids must never be signaled");
});

test("cancel reconciles a stale-heartbeat job without signaling its reused live pid", (t) => {
  const workspace = makeTempDir();
  const sleeper = spawnDetachedSleeper(workspace);
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      // Ignore a worker that already exited.
    }
  });
  transitionStoredJob(workspace, "task-stale-heartbeat", () => ({
    id: "task-stale-heartbeat",
    status: "running",
    runStatus: "RUNNING",
    outcomeStatus: null,
    jobClass: "task",
    intent: "write",
    pid: sleeper.pid,
    heartbeatAt: "2026-01-01T00:00:00.000Z"
  }));

  const result = run("node", [SCRIPT, "cancel", "task-stale-heartbeat", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runStatus, "INTERRUPTED");
  assert.equal(payload.outcomeStatus, "NEEDS_RECONCILIATION");
  assert.equal(payload.turnInterruptAttempted, false);
  assert.equal(processIsAlive(sleeper.pid), true);
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].runStatus, "INTERRUPTED");
  assert.equal(state.jobs[0].outcomeStatus, "NEEDS_RECONCILIATION");
});

test("cancel sends turn interrupt to the shared app-server before killing a brokered task", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--read-only", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("cancel treats worker exit with an unconfirmed turn interrupt as interrupted", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interrupt-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildEnv(binDir);

  const launched = run(
    "node",
    [SCRIPT, "task", "--read-only", "--background", "--json", "wait for failed interrupt"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.runStatus === "RUNNING" && job.threadId && job.turnId ? job : null;
  }, { timeoutMs: 15000 });

  const cancelled = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.runStatus, "INTERRUPTED");
  assert.equal(payload.outcomeStatus, "NEEDS_RECONCILIATION");
  const stored = loadState(repo).jobs.find((job) => job.id === jobId);
  assert.equal(stored.runStatus, "INTERRUPTED");
  assert.equal(stored.blocker.kind, "turn_interrupt_unconfirmed");
  assert.equal(stored.pid, null);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("a delayed worker stays cancel requested until a repeated cancel confirms exit", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);
  const launchToken = "delayed-worker-token-0123456789abcdef";
  const worker = spawnDetachedSleeper(
    repo,
    "let signals = 0; process.on('SIGTERM', () => { signals += 1; if (signals > 1) process.exit(0); }); setInterval(() => {}, 1000);",
    launchToken
  );
  t.after(() => {
    try {
      process.kill(-worker.pid, "SIGKILL");
    } catch {
      // Ignore a worker that already exited.
    }
  });
  transitionStoredJob(repo, "task-delay", () => ({
    id: "task-delay",
    status: "running",
    runStatus: "RUNNING",
    outcomeStatus: null,
    title: "Codex Task",
    jobClass: "task",
    intent: "read-only",
    write: false,
    workspaceRealpath: fs.realpathSync(repo),
    workflowId: "wf-delay",
    taskId: "task-delay",
    attemptId: "initial",
    logicalTaskKey: "wf-delay:task-delay",
    idempotencyKey: "wf-delay:task-delay:initial",
    requestFingerprint: "seeded-delay",
    threadId: "thr_delay",
    pid: worker.pid,
    workerIdentity: { ...captureProcessIdentity(worker.pid), token: launchToken }
  }));

  const first = run("node", [SCRIPT, "cancel", "task-delay", "--json"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.runStatus, "CANCEL_REQUESTED");
  assert.equal(firstPayload.outcomeStatus, "NEEDS_RECONCILIATION");
  const retained = loadState(repo).jobs[0];
  assert.equal(retained.pid, worker.pid);
  assert.equal(processIsAlive(worker.pid), true);

  const status = run("node", [SCRIPT, "status", "task-delay", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.runStatus, "CANCEL_REQUESTED");
  const resume = run(
    "node",
    [SCRIPT, "task", "--read-only", "--resume-job", "task-delay", "resume too early"],
    { cwd: repo, env }
  );
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /still active/i);
  const nextAttempt = run(
    "node",
    [SCRIPT, "task", "--read-only", "--workflow-id", "wf-delay", "--task-id", "task-delay", "--attempt-id", "second", "new attempt"],
    { cwd: repo, env }
  );
  assert.equal(nextAttempt.status, 1);
  assert.match(nextAttempt.stderr, /already has active attempt/i);

  const second = run("node", [SCRIPT, "cancel", "task-delay", "--json"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.runStatus, "CANCELLED");
  assert.equal(secondPayload.outcomeStatus, "CANCELLED");
  const finished = loadState(repo).jobs[0];
  assert.equal(finished.runStatus, "CANCELLED");
  assert.equal(finished.pid, null);
});

test("late completion cannot override a pending foreground cancellation", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildEnv(binDir);

  const taskResultPromise = spawnCommand(
    "node",
    [SCRIPT, "task", "--write", "--json", "allow a late completion"],
    { cwd: repo, env }
  );
  const running = await waitFor(() => {
    const job = loadState(repo).jobs[0];
    return job?.runStatus === "RUNNING" && job.turnId ? job : null;
  }, { timeoutMs: 15000 });
  transitionStoredJob(repo, running.id, (current) => ({
    ...current,
    status: "running",
    runStatus: "CANCEL_REQUESTED",
    outcomeStatus: "NEEDS_RECONCILIATION",
    cancelRequestedAt: new Date().toISOString(),
    blocker: {
      kind: "live_worker_cancellation_unconfirmed",
      message: "Cancellation remains unconfirmed.",
      retryWhen: "Reconcile the worker and workspace"
    }
  }));

  const taskResult = await taskResultPromise;
  assert.notEqual(taskResult.status, 0);
  const payload = JSON.parse(taskResult.stdout);
  assert.equal(payload.runStatus, "CANCEL_REQUESTED");
  assert.equal(payload.outcomeStatus, "NEEDS_RECONCILIATION");
  const stored = loadState(repo).jobs.find((job) => job.id === running.id);
  assert.equal(stored.runStatus, "CANCEL_REQUESTED");
  assert.equal(stored.outcomeStatus, "NEEDS_RECONCILIATION");
  assert.equal("terminalWriteId" in stored, false);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("session end preserves history and marks active attempts interrupted", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  const launchToken = "session-end-token-0123456789abcdef";
  const sleeper = spawnDetachedSleeper(repo, undefined, launchToken);

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const jobs = [
    {
      id: "review-completed",
      status: "completed",
      runStatus: "FINISHED",
      title: "Codex Review",
      sessionId: "sess-current",
      logFile: completedLog,
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:31:00.000Z"
    },
    {
      id: "review-running",
      status: "running",
      runStatus: "RUNNING",
      title: "Codex Review",
      sessionId: "sess-current",
      pid: sleeper.pid,
      workerIdentity: { ...captureProcessIdentity(sleeper.pid), token: launchToken },
      logFile: runningLog,
      createdAt: "2026-03-18T15:32:00.000Z",
      updatedAt: "2026-03-18T15:33:00.000Z"
    },
    {
      id: "review-other",
      status: "completed",
      runStatus: "FINISHED",
      title: "Codex Review",
      sessionId: "sess-other",
      logFile: otherSessionLog,
      createdAt: "2026-03-18T15:34:00.000Z",
      updatedAt: "2026-03-18T15:35:00.000Z"
    }
  ];
  fs.writeFileSync(completedJobFile, JSON.stringify(jobs[0], null, 2), "utf8");
  fs.writeFileSync(runningJobFile, JSON.stringify(jobs[1], null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify(jobs[2], null, 2), "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 2,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = loadState(repo);
  assert.deepEqual(
    new Set(state.jobs.map((job) => job.id)),
    new Set(["review-completed", "review-running", "review-other"])
  );
  assert.equal(fs.existsSync(completedLog), true);
  assert.equal(fs.existsSync(completedJobFile), true);
  assert.equal(fs.existsSync(runningLog), true);
  assert.equal(fs.existsSync(runningJobFile), true);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);

  const interrupted = readJobFile(runningJobFile);
  assert.equal(interrupted.runStatus, "INTERRUPTED");
  assert.equal(interrupted.outcomeStatus, "NEEDS_RECONCILIATION");
  assert.equal(interrupted.pid, null);
});

test("session end retains a live worker until a later session observes its exit", async (t) => {
  const repo = makeTempDir();
  const launchToken = "session-retained-token-0123456789abcdef";
  const worker = spawnDetachedSleeper(
    repo,
    "let signals = 0; process.on('SIGTERM', () => { signals += 1; if (signals > 1) process.exit(0); }); setInterval(() => {}, 1000);",
    launchToken
  );
  t.after(() => {
    try {
      process.kill(-worker.pid, "SIGKILL");
    } catch {
      // Ignore a worker that already exited.
    }
  });
  transitionStoredJob(repo, "task-session-live", () => ({
    id: "task-session-live",
    status: "running",
    runStatus: "RUNNING",
    outcomeStatus: null,
    title: "Codex Task",
    jobClass: "task",
    sessionId: "sess-old",
    threadId: "thr_session_live",
    pid: worker.pid,
    workerIdentity: { ...captureProcessIdentity(worker.pid), token: launchToken }
  }));

  const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-old" },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-old", cwd: repo })
  });
  assert.equal(ended.status, 0, ended.stderr);
  const retained = loadState(repo).jobs[0];
  assert.equal(retained.runStatus, "CANCEL_REQUESTED");
  assert.equal(retained.outcomeStatus, "NEEDS_RECONCILIATION");
  assert.equal(retained.orphaned, true);
  assert.equal(retained.pid, worker.pid);
  assert.equal(processIsAlive(worker.pid), true);

  process.kill(-worker.pid, "SIGTERM");
  await waitFor(() => !processIsAlive(worker.pid));
  const observed = run("node", [SCRIPT, "status", "task-session-live", "--json"], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-new" }
  });
  assert.equal(observed.status, 0, observed.stderr);
  assert.equal(JSON.parse(observed.stdout).job.runStatus, "INTERRUPTED");
  assert.equal(loadState(repo).jobs[0].outcomeStatus, "NEEDS_RECONCILIATION");
});

test("session end and terminal completion preserve one canonical race winner", async () => {
  const repo = makeTempDir();
  transitionStoredJob(repo, "task-session-race", () => ({
    id: "task-session-race",
    status: "running",
    runStatus: "RUNNING",
    outcomeStatus: null,
    title: "Codex Task",
    jobClass: "task",
    sessionId: "sess-race",
    pid: null
  }));
  const stateModule = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs")).href;
  const reconciliationModule = pathToFileURL(
    path.join(PLUGIN_ROOT, "scripts", "lib", "job-reconciliation.mjs")
  ).href;
  const terminalScript = `
    const { transitionStoredJob } = await import(${JSON.stringify(stateModule)});
    const { transitionJob } = await import(${JSON.stringify(reconciliationModule)});
    transitionStoredJob(${JSON.stringify(repo)}, "task-session-race", (current) => transitionJob(current, {
      status: "completed",
      runStatus: "FINISHED",
      outcomeStatus: "COMPLETED_READ_ONLY",
      pid: null,
      terminalWriteId: "completion-race"
    }));
  `;

  const [ended, completed] = await Promise.all([
    spawnCommand("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-race" }
    }),
    spawnCommand(process.execPath, ["--input-type=module", "-e", terminalScript], { cwd: repo })
  ]);
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(completed.status, 0, completed.stderr);
  const indexed = loadState(repo).jobs.find((job) => job.id === "task-session-race");
  const durable = readJobFile(path.join(resolveStateDir(repo), "jobs", "task-session-race.json"));
  assert.deepEqual(indexed, durable);
  assert.ok(["FINISHED", "INTERRUPTED"].includes(durable.runStatus));
  if (durable.runStatus === "FINISHED") {
    assert.equal(durable.terminalWriteId, "completion-race");
  } else {
    assert.equal("terminalWriteId" in durable, false);
  }
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);

  const typedStatus = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(typedStatus.status, 0, typedStatus.stderr);
  const typedPayload = JSON.parse(typedStatus.stdout);
  assert.equal(typedPayload.latestFinished.runStatus, "FINISHED");
  assert.equal(typedPayload.latestFinished.outcomeStatus, "COMPLETED_READ_ONLY");
  assert.equal(typedPayload.latestFinished.outcome.inspected, true);
  assert.deepEqual(typedPayload.latestFinished.outcome.evidence, ["Previous Claude response"]);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/codex:status/i);
  assert.match(blocked.stderr, /\/codex:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/codex:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  });

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");
});

test("a correlated duplicate reconciles a partial write and resumes one exact attempt", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-partial-write");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "fixture"], { cwd: repo });
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-acceptance" };
  const args = [
    SCRIPT,
    "task",
    "--background",
    "--json",
    "--write",
    "--workflow-id",
    "wf-acceptance",
    "--task-id",
    "task-1",
    "fix the retry bug"
  ];

  const firstLaunch = run("node", args, { cwd: repo, env });
  assert.equal(firstLaunch.status, 0, firstLaunch.stderr);
  const firstJobId = JSON.parse(firstLaunch.stdout).jobId;

  const duplicateLaunch = run("node", args, { cwd: repo, env });
  assert.equal(duplicateLaunch.status, 0, duplicateLaunch.stderr);
  assert.equal(JSON.parse(duplicateLaunch.stdout).jobId, firstJobId);

  const runningJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((entry) => entry.id === firstJobId);
    return job?.threadId && job?.runStatus === "RUNNING" ? job : null;
  }, { timeoutMs: 15000 });
  await waitFor(() => fs.existsSync(path.join(repo, "partial-edit.txt")), { timeoutMs: 15000 });
  const fakeBefore = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeBefore.threads.length, 1);

  const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-acceptance",
      cwd: repo
    })
  });
  assert.equal(ended.status, 0, ended.stderr);
  const interrupted = readJobFile(path.join(resolveStateDir(repo), "jobs", `${firstJobId}.json`));
  assert.equal(interrupted.runStatus, "INTERRUPTED");
  assert.equal(interrupted.outcomeStatus, "NEEDS_RECONCILIATION");

  const reconciled = run("node", [SCRIPT, "reconcile", firstJobId, "--json"], { cwd: repo, env });
  assert.equal(reconciled.status, 0, reconciled.stderr);
  const reconciliation = JSON.parse(reconciled.stdout);
  assert.equal(reconciliation.workspaceDrift, true);
  assert.equal(reconciliation.nextAction, "inspect_workspace_diff");
  assert.match(reconciliation.currentSnapshotToken, /^[a-f0-9]{64}$/);

  const rejectedResume = run(
    "node",
    [SCRIPT, "task", "--json", "--write", "--resume-job", firstJobId, "continue after interruption"],
    { cwd: repo, env }
  );
  assert.equal(rejectedResume.status, 1);
  assert.match(rejectedResume.stderr, /accept.*snapshot|reconciliation/i);

  const accepted = run(
    "node",
    [
      SCRIPT,
      "reconcile",
      firstJobId,
      "--accept-snapshot",
      reconciliation.currentSnapshotToken,
      "--json"
    ],
    { cwd: repo, env }
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(
    JSON.parse(accepted.stdout).reconciledSnapshotToken,
    reconciliation.currentSnapshotToken
  );

  const resumed = run(
    "node",
    [SCRIPT, "task", "--json", "--write", "--resume-job", firstJobId, "continue after interruption"],
    { cwd: repo, env }
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).outcomeStatus, "READY_FOR_INTEGRATION");

  const child = loadState(repo).jobs.find((entry) => entry.parentJobId === firstJobId);
  assert.equal(child.threadId, runningJob.threadId);
  assert.equal(child.workflowId, "wf-acceptance");
  assert.equal(child.taskId, "task-1");
  const fakeAfter = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeAfter.threads.length, 1);
});
