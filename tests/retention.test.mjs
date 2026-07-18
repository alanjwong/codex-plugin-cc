import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  loadState,
  listJobs,
  purgeExpiredJobArtifacts,
  resolveJobsDir,
  resolveStateDir,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

const onWindows = process.platform === "win32";

function withPluginDataDir(t, pluginDataDir) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-03-20T12:00:00.000Z");

function seedJob(cwd, id, { runStatus, outcomeStatus = null, ageDays }) {
  const updatedAt = new Date(NOW - ageDays * DAY_MS).toISOString();
  // Seed the durable job file directly so the synthetic timestamps survive
  // (transitionStoredJob re-stamps updatedAt on every accepted write).
  writeJobFile(cwd, id, {
    id,
    status: runStatus === "RUNNING" ? "running" : "completed",
    runStatus,
    outcomeStatus,
    title: "Codex Task",
    jobClass: "task",
    createdAt: updatedAt,
    updatedAt
  });
  const jobsDir = resolveJobsDir(cwd);
  fs.writeFileSync(path.join(jobsDir, `${id}.events.jsonl`), "{}\n", "utf8");
  fs.writeFileSync(path.join(jobsDir, `${id}.log`), "log\n", "utf8");
}

function artifactsPresent(cwd, id) {
  const jobsDir = resolveJobsDir(cwd);
  return ["json", "events.jsonl", "log"].map((ext) => fs.existsSync(path.join(jobsDir, `${id}.${ext}`)));
}

test("expired resolved terminal jobs are purged with all artifacts", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  seedJob(cwd, "task-old-done", { runStatus: "FINISHED", outcomeStatus: "COMPLETED_READ_ONLY", ageDays: 30 });
  seedJob(cwd, "task-new-done", { runStatus: "FINISHED", outcomeStatus: "COMPLETED_READ_ONLY", ageDays: 1 });

  const result = purgeExpiredJobArtifacts(cwd, { now: NOW, ttlMs: 14 * DAY_MS, maxTerminal: 100 });
  assert.equal(result.purgedJobs, 1);
  assert.deepEqual(artifactsPresent(cwd, "task-old-done"), [false, false, false], "expired artifacts must be gone");
  assert.deepEqual(artifactsPresent(cwd, "task-new-done"), [true, true, true], "fresh artifacts must remain");
  assert.ok(!loadState(cwd).jobs.some((job) => job.id === "task-old-done"), "purged job must leave the projection");
});

test("purging an expired job removes sensitive payloads from the state projection", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const id = "task-expired-sensitive";
  const sentinel = "SENTINEL_SECRET_PROMPT_9f3a";
  const completedAt = "2000-01-01T00:00:00.000Z";
  const job = {
    id,
    status: "completed",
    runStatus: "FINISHED",
    outcomeStatus: "READY_FOR_INTEGRATION",
    title: "Sensitive Codex Task",
    jobClass: "task",
    createdAt: completedAt,
    updatedAt: completedAt,
    completedAt,
    result: { prompt: sentinel },
    rendered: `Rendered output containing ${sentinel}`
  };
  writeJobFile(cwd, id, job);
  saveState(cwd, { version: 2, config: {}, jobs: [job] });

  purgeExpiredJobArtifacts(cwd, { now: Date.now() });

  assert.ok(!fs.existsSync(path.join(resolveJobsDir(cwd), `${id}.json`)), "expired durable job must be deleted");
  assert.ok(!loadState(cwd).jobs.some((entry) => entry.id === id), "expired job must leave the state projection");
  assert.ok(!JSON.stringify(loadState(cwd)).includes(sentinel), "sensitive payload must leave state.json");
  assert.ok(!listJobs(cwd).some((entry) => entry.id === id), "projection repair must not restore the expired job");
});

test("active and unresolved jobs are preserved no matter how old", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  seedJob(cwd, "task-running", { runStatus: "RUNNING", ageDays: 365 });
  seedJob(cwd, "task-needs-reconcile", {
    runStatus: "INTERRUPTED",
    outcomeStatus: "NEEDS_RECONCILIATION",
    ageDays: 365
  });

  const result = purgeExpiredJobArtifacts(cwd, { now: NOW, ttlMs: 1 * DAY_MS, maxTerminal: 0 });
  assert.equal(result.purgedJobs, 0);
  assert.deepEqual(artifactsPresent(cwd, "task-running"), [true, true, true]);
  assert.deepEqual(artifactsPresent(cwd, "task-needs-reconcile"), [true, true, true]);
});

test("the terminal count cap deterministically purges the oldest resolved jobs", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  for (let index = 0; index < 5; index += 1) {
    seedJob(cwd, `task-cap-${index}`, {
      runStatus: "FINISHED",
      outcomeStatus: "COMPLETED_READ_ONLY",
      ageDays: index + 1
    });
  }

  const result = purgeExpiredJobArtifacts(cwd, { now: NOW, ttlMs: 365 * DAY_MS, maxTerminal: 2 });
  assert.equal(result.purgedJobs, 3);
  assert.deepEqual(artifactsPresent(cwd, "task-cap-0"), [true, true, true], "newest stays");
  assert.deepEqual(artifactsPresent(cwd, "task-cap-1"), [true, true, true], "second newest stays");
  for (const id of ["task-cap-2", "task-cap-3", "task-cap-4"]) {
    assert.deepEqual(artifactsPresent(cwd, id), [false, false, false], `${id} must be purged`);
  }
});

test("purge never follows symlinked artifacts out of the jobs dir", { skip: onWindows }, (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  seedJob(cwd, "task-linked", { runStatus: "FINISHED", outcomeStatus: "COMPLETED_READ_ONLY", ageDays: 30 });
  const jobsDir = resolveJobsDir(cwd);
  const outside = path.join(makeTempDir(), "precious.log");
  fs.writeFileSync(outside, "precious\n", "utf8");
  fs.unlinkSync(path.join(jobsDir, "task-linked.log"));
  fs.symlinkSync(outside, path.join(jobsDir, "task-linked.log"));

  purgeExpiredJobArtifacts(cwd, { now: NOW, ttlMs: 1 * DAY_MS, maxTerminal: 0 });
  assert.ok(fs.existsSync(outside), "symlink target outside the jobs dir must survive");
  assert.ok(!fs.existsSync(path.join(jobsDir, "task-linked.json")), "the regular json artifact is still purged");
});

test("purge never follows a symlinked jobs dir out of the state root", { skip: onWindows }, (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const stateDir = resolveStateDir(cwd);
  const outsideDir = makeTempDir();
  const completedAt = "2000-01-01T00:00:00.000Z";
  const outsideFiles = [
    path.join(outsideDir, "evil.json"),
    path.join(outsideDir, "evil.events.jsonl"),
    path.join(outsideDir, "evil.log")
  ];
  fs.writeFileSync(outsideFiles[0], JSON.stringify({
    id: "evil",
    runStatus: "FINISHED",
    outcomeStatus: "READY_FOR_INTEGRATION",
    completedAt
  }), "utf8");
  fs.writeFileSync(outsideFiles[1], "{}\n", "utf8");
  fs.writeFileSync(outsideFiles[2], "log\n", "utf8");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.symlinkSync(outsideDir, resolveJobsDir(cwd));

  const result = purgeExpiredJobArtifacts(cwd, { now: Date.now() });

  assert.deepEqual(result, { purgedJobs: 0, deletedFiles: 0 });
  assert.deepEqual(outsideFiles.map((filePath) => fs.existsSync(filePath)), [true, true, true]);
});

test("purge rejects a symlinked workspace state dir before enumerating jobs", { skip: onWindows }, (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const stateDir = resolveStateDir(cwd);
  const outsideDir = makeTempDir();
  const outsideJobsDir = path.join(outsideDir, "jobs");
  const completedAt = "2000-01-01T00:00:00.000Z";
  const outsideFiles = [
    path.join(outsideJobsDir, "evil.json"),
    path.join(outsideJobsDir, "evil.events.jsonl"),
    path.join(outsideJobsDir, "evil.log")
  ];
  fs.mkdirSync(outsideJobsDir);
  fs.writeFileSync(outsideFiles[0], JSON.stringify({
    id: "evil",
    runStatus: "FINISHED",
    outcomeStatus: "READY_FOR_INTEGRATION",
    completedAt
  }), "utf8");
  fs.writeFileSync(outsideFiles[1], "{}\n", "utf8");
  fs.writeFileSync(outsideFiles[2], "log\n", "utf8");
  fs.mkdirSync(path.dirname(stateDir), { recursive: true });
  fs.symlinkSync(outsideDir, stateDir);

  const result = purgeExpiredJobArtifacts(cwd, { now: Date.now() });

  assert.deepEqual(result, { purgedJobs: 0, deletedFiles: 0 });
  assert.deepEqual(outsideFiles.map((filePath) => fs.existsSync(filePath)), [true, true, true]);
});

test("writeJobFile keeps working after a purge", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  seedJob(cwd, "task-x", { runStatus: "FINISHED", outcomeStatus: "COMPLETED_READ_ONLY", ageDays: 30 });
  purgeExpiredJobArtifacts(cwd, { now: NOW, ttlMs: 1 * DAY_MS, maxTerminal: 0 });
  writeJobFile(cwd, "task-y", { id: "task-y" });
  assert.ok(fs.existsSync(path.join(resolveJobsDir(cwd), "task-y.json")));
});
