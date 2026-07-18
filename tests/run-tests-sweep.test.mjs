import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { buildChildEnv, collectRunOwnedIdentities, sweepRunOwnedProcesses } from "../scripts/run-tests.mjs";
import { captureProcessIdentity } from "../plugins/codex/scripts/lib/process.mjs";
import { waitForProcessExit } from "../plugins/codex/scripts/lib/job-reconciliation.mjs";
import { makeTempDir } from "./helpers.mjs";

const onWindows = process.platform === "win32";

test("the child environment is isolated under the run root", () => {
  const runRoot = makeTempDir();
  const env = buildChildEnv(
    {
      CLAUDE_PLUGIN_DATA: "real-plugin-data",
      CODEX_COMPANION_SESSION_ID: "real-companion-session",
      CLAUDE_SESSION_ID: "real-claude-session",
      CODEX_COMPANION_APP_SERVER_ENDPOINT: "real-app-server-endpoint"
    },
    runRoot
  );

  assert.equal(env.TMPDIR, runRoot);
  assert.equal(env.TEMP, runRoot);
  assert.equal(env.TMP, runRoot);
  assert.equal(env.CLAUDE_PLUGIN_DATA, path.join(runRoot, "plugin-data"));
  assert.notEqual(env.CLAUDE_PLUGIN_DATA, "real-plugin-data");
  assert.equal(env.CODEX_COMPANION_SESSION_ID, undefined);
  assert.equal(env.CLAUDE_SESSION_ID, undefined);
  assert.equal(env.CODEX_COMPANION_APP_SERVER_ENDPOINT, undefined);
});

function spawnSleeper(launchToken) {
  // Mirror production argv shape: the launch token is embedded as
  // `--launch-token <token>` so verifyProcessIdentity's exact-argument parse
  // (not a substring match) can recover it.
  const args = ["-e", "setInterval(() => {}, 1000);"];
  if (launchToken) {
    args.push("--", "--launch-token", launchToken);
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child;
}

function killQuietly(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

test("the run sweep terminates only identities recorded under the run root", { skip: onWindows }, async (t) => {
  const runRoot = makeTempDir();

  const owned = spawnSleeper("owned-run-token-1234567890");
  const bystander = spawnSleeper("concurrent-other-run-0987654321");
  t.after(() => {
    killQuietly(owned.pid);
    killQuietly(bystander.pid);
  });

  const ownedIdentity = { ...captureProcessIdentity(owned.pid), token: "owned-run-token-1234567890" };
  const stateDir = path.join(runRoot, "codex-companion-test", "state", "repo-abc");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "broker-sessions.json"),
    `${JSON.stringify([{ dir: path.join(runRoot, "codex-companion-x"), token: ownedIdentity.token, pid: ownedIdentity.pid, startedAt: ownedIdentity.startedAt }])}\n`,
    "utf8"
  );
  // A stale record whose pid was "reused": right pid file shape, wrong start time.
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, "task-stale.json"),
    `${JSON.stringify({ id: "task-stale", workerIdentity: { pid: bystander.pid, startedAt: (captureProcessIdentity(bystander.pid)?.startedAt ?? 0) - 120_000, token: "not-the-real-token" } })}\n`,
    "utf8"
  );

  const identities = collectRunOwnedIdentities(runRoot);
  assert.equal(identities.length, 2, "both recorded identities are collected");

  const results = sweepRunOwnedProcesses(runRoot);
  const ownedResult = results.find((entry) => entry.pid === owned.pid);
  const staleResult = results.find((entry) => entry.pid === bystander.pid);
  assert.equal(ownedResult?.verified, true, "run-owned process must verify");
  assert.equal(staleResult?.attempted, false, "mismatched identity must never be signaled");

  const ownedExited = await waitForProcessExit(owned.pid, { timeoutMs: 3000, pollMs: 50 });
  assert.equal(ownedExited, true, "run-owned process must be terminated");
  const bystanderExited = await waitForProcessExit(bystander.pid, { timeoutMs: 300, pollMs: 50 });
  assert.equal(bystanderExited, false, "the concurrent process must survive");
});

test("the sweep collects nothing from an empty or unrelated run root", () => {
  const runRoot = makeTempDir();
  fs.mkdirSync(path.join(runRoot, "unrelated"), { recursive: true });
  fs.writeFileSync(path.join(runRoot, "unrelated", "notes.json"), "{\"pid\": 1}\n", "utf8");
  assert.deepEqual(collectRunOwnedIdentities(runRoot), [], "records without launch identities are ignored");
});

test("the sweep ignores tokenless launch identities", () => {
  const runRoot = makeTempDir();
  fs.writeFileSync(
    path.join(runRoot, "broker.json"),
    `${JSON.stringify({ identity: { pid: 4242, startedAt: 1700000000000 } })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(runRoot, "worker.json"),
    `${JSON.stringify({ workerIdentity: { pid: 4243, startedAt: 1700000000000, token: "tok" } })}\n`,
    "utf8"
  );

  const identities = collectRunOwnedIdentities(runRoot);
  assert.deepEqual(identities.map((identity) => identity.pid), [4243]);
  assert.equal(identities.some((identity) => identity.pid === 4242), false);
});
