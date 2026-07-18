import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  ensureStateDir,
  loadState,
  listJobs,
  listDurableJobs,
  readJobFile,
  resolveJobFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  stealStateLock,
  transitionStoredJob
} from "../plugins/codex/scripts/lib/state.mjs";

const WRITER = fileURLToPath(new URL("./state-writer-fixture.mjs", import.meta.url));

function runWriter(workspace, jobId, mode = "upsert") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, workspace, jobId, mode], { stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  });
}

async function waitForFile(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function spawnDetachedLongLivedChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return child;
}

async function waitForProcessDeath(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for process ${pid} to exit`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("state v1 migrates without claiming semantic success", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: "legacy", status: "completed", updatedAt: "2026-01-01T00:00:00.000Z" }]
  }));
  const state = loadState(workspace);
  assert.equal(state.version, 2);
  assert.equal(state.jobs[0].runStatus, "FINISHED");
  assert.equal(state.jobs[0].outcomeStatus, "UNCLASSIFIED");
});

test("display pruning preserves durable job records", () => {
  const workspace = makeTempDir();
  const jobs = Array.from({ length: 51 }, (_, index) => ({
    id: `job-${index}`,
    runStatus: "FINISHED",
    outcomeStatus: "COMPLETED_READ_ONLY",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
  }));
  for (const job of jobs) {
    fs.mkdirSync(path.dirname(resolveJobFile(workspace, job.id)), { recursive: true });
    fs.writeFileSync(resolveJobFile(workspace, job.id), JSON.stringify(job));
  }
  saveState(workspace, { version: 2, config: {}, jobs });
  assert.equal(loadState(workspace).jobs.length, 50);
  assert.equal(readJobFile(resolveJobFile(workspace, "job-0")).id, "job-0");
  assert.equal(listDurableJobs(workspace).length, 51);
});

test("concurrent job updates do not lose index records", async () => {
  const workspace = makeTempDir();
  await Promise.all(Array.from({ length: 12 }, (_, index) => runWriter(workspace, `parallel-${index}`)));
  const ids = new Set(loadState(workspace).jobs.map((job) => job.id));
  assert.equal(ids.size, 12);
});

test("atomic rename stealing claims a dead-owner lock exactly once", () => {
  const workspace = makeTempDir();
  const lockFile = `${resolveStateFile(workspace)}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999_999 }), "utf8");

  assert.equal(stealStateLock(lockFile), true);
  assert.equal(stealStateLock(lockFile), false);
  assert.equal(fs.existsSync(lockFile), false);
});

test("a live lock owner is never stolen even when the lock is stale", async (t) => {
  const workspace = makeTempDir();
  const child = await spawnDetachedLongLivedChild();
  const ownerPid = child.pid;
  ensureStateDir(workspace);
  const lockFile = `${resolveStateFile(workspace)}.lock`;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: ownerPid, at: new Date().toISOString() }), "utf8");
  const staleAt = new Date(Date.now() - 120_000);
  fs.utimesSync(lockFile, staleAt, staleAt);
  t.after(() => {
    try {
      process.kill(ownerPid);
    } catch {
      // Already exited.
    }
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // The lock was already removed.
    }
  });

  assert.throws(() => saveState(workspace, { jobs: [] }), /Timed out acquiring state lock/);
});

test("a dead lock owner is still stolen", async (t) => {
  const workspace = makeTempDir();
  const child = await spawnDetachedLongLivedChild();
  const ownerPid = child.pid;
  t.after(() => {
    try {
      process.kill(ownerPid);
    } catch {
      // Already exited.
    }
  });
  process.kill(ownerPid);
  await waitForProcessDeath(ownerPid);

  ensureStateDir(workspace);
  const stateFile = resolveStateFile(workspace);
  const lockFile = `${stateFile}.lock`;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: ownerPid, at: new Date().toISOString() }), "utf8");
  const staleAt = new Date(Date.now() - 120_000);
  fs.utimesSync(lockFile, staleAt, staleAt);

  saveState(workspace, { jobs: [] });

  assert.equal(fs.existsSync(stateFile), true);
});

test("a holder does not unlink a lock file replaced by another pid", async () => {
  const workspace = makeTempDir();
  const readyFile = path.join(workspace, "holder-ready");
  const releaseFile = path.join(workspace, "holder-release");
  const lockFile = `${resolveStateFile(workspace)}.lock`;
  const holder = runWriter(workspace, "holder", "hold-lock");
  await waitForFile(readyFile);

  const replacement = `${lockFile}.replacement`;
  fs.writeFileSync(replacement, JSON.stringify({ pid: process.pid }), "utf8");
  fs.renameSync(replacement, lockFile);
  fs.writeFileSync(releaseFile, "release\n", "utf8");
  await holder;

  assert.equal(fs.existsSync(lockFile), true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid, process.pid);
  fs.unlinkSync(lockFile);
});

test("a stale heartbeat cannot overwrite a terminal record", async () => {
  const workspace = makeTempDir();
  transitionStoredJob(workspace, "race", () => ({
    id: "race",
    runStatus: "RUNNING",
    heartbeatAt: "2026-01-01T00:00:00.000Z"
  }));
  await Promise.all([
    runWriter(workspace, "race", "heartbeat-loop"),
    runWriter(workspace, "race", "finish")
  ]);
  const durable = readJobFile(resolveJobFile(workspace, "race"));
  const indexed = loadState(workspace).jobs.find((job) => job.id === "race");
  assert.equal(durable.runStatus, "FINISHED");
  assert.deepEqual(indexed, durable);
});

test("listJobs repairs a stale index from the canonical job file", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 2,
    config: {},
    jobs: [{ id: "crash", runStatus: "RUNNING", updatedAt: "2026-01-01T00:00:00.000Z" }]
  });
  fs.writeFileSync(resolveJobFile(workspace, "crash"), JSON.stringify({
    id: "crash",
    runStatus: "FINISHED",
    outcomeStatus: "COMPLETED_READ_ONLY",
    updatedAt: "2026-01-01T00:00:01.000Z"
  }));
  const repaired = listJobs(workspace).find((job) => job.id === "crash");
  assert.equal(repaired.runStatus, "FINISHED");
  assert.equal(loadState(workspace).jobs.find((job) => job.id === "crash").runStatus, "FINISHED");
});

test("canonical transitions stamp new active jobs before display pruning", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 2,
    config: {},
    jobs: Array.from({ length: 50 }, (_, index) => ({
      id: `old-${index}`,
      runStatus: "FINISHED",
      updatedAt: `2000-01-01T00:00:${String(index).padStart(2, "0")}.000Z`
    }))
  });
  const active = transitionStoredJob(workspace, "active", () => ({
    id: "active",
    runStatus: "RUNNING"
  }));
  assert.match(active.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(listJobs(workspace).some((job) => job.id === "active"), true);
});
