import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 2;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// Per-user fallback root: on shared-tmp systems the uid suffix keeps users
// apart, and ensurePrivateDir below enforces 0700 + ownership on every use.
const FALLBACK_STATE_ROOT_DIR = path.join(
  os.tmpdir(),
  `codex-companion-${typeof process.getuid === "function" ? process.getuid() : "user"}`
);
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_LOCK_TIMEOUT_MS = 3000;
const STATE_LOCK_STALE_MS = 30000;
const STATE_DIR_CACHE = new Map();

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // The creation mode already applied; rename below preserves it.
    }
  }
  fs.renameSync(temporary, filePath);
}

function lockOwnerIsDead(lockFile) {
  let ownerPid = null;
  try {
    ownerPid = JSON.parse(fs.readFileSync(lockFile, "utf8"))?.pid;
  } catch {
    return false;
  }
  if (!Number.isFinite(ownerPid) || ownerPid === process.pid) return false;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function readStateLockOwnerPid(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"))?.pid ?? null;
  } catch {
    return null;
  }
}

export function stealStateLock(lockFile) {
  const staleFile = `${lockFile}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lockFile, staleFile);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  try {
    fs.unlinkSync(staleFile);
  } catch {
    // The stale lock is already detached from the live lock path.
  }
  return true;
}

function releaseOwnedStateLock(lockFile) {
  try {
    const ownerPid = JSON.parse(fs.readFileSync(lockFile, "utf8"))?.pid;
    if (ownerPid === process.pid) fs.unlinkSync(lockFile);
  } catch {
    // A replaced or already-removed lock is not ours to release.
  }
}

function withStateLock(cwd, callback) {
  ensureStateDir(cwd);
  const lockFile = `${resolveStateFile(cwd)}.lock`;
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
        return callback();
      } finally {
        fs.closeSync(fd);
        releaseOwnedStateLock(lockFile);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const ownerPid = readStateLockOwnerPid(lockFile);
        const ownerDead = Number.isFinite(ownerPid) && ownerPid !== process.pid && lockOwnerIsDead(lockFile);
        const ownerUnknownAndStale = !Number.isFinite(ownerPid) && Date.now() - fs.statSync(lockFile).mtimeMs > STATE_LOCK_STALE_MS;
        if ((ownerDead || ownerUnknownAndStale) && readStateLockOwnerPid(lockFile) === ownerPid) {
          stealStateLock(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring state lock: ${lockFile}`);
      pause(20);
    }
  }
}

function migrateJob(job) {
  if (job.runStatus) return job;
  const runStatus = {
    queued: "QUEUED",
    running: "RUNNING",
    completed: "FINISHED",
    failed: "FAILED",
    cancelled: "CANCELLED"
  }[job.status] ?? "FAILED";
  return {
    ...job,
    runStatus,
    outcomeStatus: job.status === "completed" ? "UNCLASSIFIED" : null
  };
}

export function resolveStateDir(cwd) {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const cacheKey = `${pluginDataDir ?? ""}\0${path.resolve(cwd)}`;
  const cached = STATE_DIR_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  const stateDir = path.join(stateRoot, `${slug}-${hash}`);
  STATE_DIR_CACHE.set(cacheKey, stateDir);
  return stateDir;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

function assertNotSymlinkedForeignPath(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return; // Absent is fine; it will be created privately.
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked state path: ${dir}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Refusing to use state path owned by another user (uid ${stat.uid}): ${dir}`);
  }
}

// Creates (or repairs) a directory as user-private regardless of umask, and
// rejects symlinked or foreign-owned paths instead of writing through them.
export function ensurePrivateDir(dir) {
  assertNotSymlinkedForeignPath(dir);
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, PRIVATE_DIR_MODE);
    } catch {
      // Repair is best-effort; the mkdir mode already applied on creation.
    }
  }
}

function dropSymlinkTarget(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { return; }
  if (stat.isSymbolicLink()) {
    // Fail closed: if a planted symlink cannot be removed, propagate the error so
    // the caller never falls through and writes/chmods through the link.
    fs.unlinkSync(filePath);
  }
}

export function privateWriteFileSync(filePath, contents) {
  dropSymlinkTarget(filePath);
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, PRIVATE_FILE_MODE);
    } catch {
      // Best-effort repair for pre-existing files.
    }
  }
}

export function privateAppendFileSync(filePath, contents) {
  dropSymlinkTarget(filePath);
  fs.appendFileSync(filePath, contents, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, PRIVATE_FILE_MODE);
    } catch {
      // Best-effort repair for pre-existing files.
    }
  }
}

export function ensureStateDir(cwd) {
  const configuredRoot = process.env[PLUGIN_DATA_ENV];
  if (configuredRoot) {
    assertNotSymlinkedForeignPath(configuredRoot);
  }
  const stateDir = resolveStateDir(cwd);
  ensurePrivateDir(path.dirname(stateDir));
  ensurePrivateDir(stateDir);
  ensurePrivateDir(resolveJobsDir(cwd));
}

function loadStateUnlocked(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      version: STATE_VERSION,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map(migrateJob) : []
    };
  } catch {
    return defaultState();
  }
}

export function loadState(cwd) {
  return loadStateUnlocked(cwd);
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function saveStateUnlocked(cwd, state) {
  ensureStateDir(cwd);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: pruneJobs((state.jobs ?? []).map(migrateJob))
  };
  atomicWriteJson(resolveStateFile(cwd), nextState);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const draft = loadStateUnlocked(cwd);
    const next = mutate(draft) ?? draft;
    return saveStateUnlocked(cwd, next);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function persistAcceptedJobUnlocked(cwd, state, next, { touch = true } = {}) {
  const timestamp = nowIso();
  const persisted = {
    ...next,
    createdAt: next.createdAt ?? timestamp,
    updatedAt: touch ? timestamp : next.updatedAt ?? timestamp
  };
  atomicWriteJson(resolveJobFile(cwd, persisted.id), persisted);
  const jobs = [persisted, ...state.jobs.filter((job) => job.id !== persisted.id)];
  saveStateUnlocked(cwd, { ...state, jobs });
  return persisted;
}

export function transitionStoredJob(cwd, jobId, mutate) {
  return withStateLock(cwd, () => {
    const state = loadStateUnlocked(cwd);
    const jobFile = resolveJobFile(cwd, jobId);
    const current = fs.existsSync(jobFile)
      ? migrateJob(readJobFile(jobFile))
      : state.jobs.find((job) => job.id === jobId) ?? { id: jobId };
    const proposed = mutate({ ...current }) ?? current;
    if (!proposed || proposed.id !== jobId) throw new Error(`Invalid transition for job ${jobId}.`);
    const changed = JSON.stringify(proposed) !== JSON.stringify(current);
    const next = changed
      ? { ...proposed, createdAt: current.createdAt ?? proposed.createdAt }
      : current;
    return persistAcceptedJobUnlocked(cwd, state, next, { touch: changed });
  });
}

export function reserveStoredJob(cwd, candidate, decideExisting) {
  return withStateLock(cwd, () => {
    const state = loadStateUnlocked(cwd);
    const durable = listDurableJobsUnlocked(cwd);
    const durableIds = new Set(durable.map((job) => job.id));
    const decision = decideExisting([
      ...durable,
      ...state.jobs.filter((job) => !durableIds.has(job.id))
    ], candidate);
    if (decision?.job) {
      if (decision.conflict) throw new Error(decision.conflict);
      return { created: false, job: decision.job };
    }
    return { created: true, job: persistAcceptedJobUnlocked(cwd, state, candidate) };
  });
}

export function upsertJob(cwd, jobPatch) {
  return transitionStoredJob(cwd, jobPatch.id, (current) => ({
    ...current,
    ...jobPatch
  }));
}

export function appendJobEvent(cwd, jobId, event) {
  ensureStateDir(cwd);
  const eventFile = path.join(resolveJobsDir(cwd), `${jobId}.events.jsonl`);
  privateAppendFileSync(eventFile, `${JSON.stringify({ at: nowIso(), ...event })}\n`);
}

export function touchJobHeartbeat(cwd, jobId, lastProgressAt = null) {
  const heartbeatAt = nowIso();
  transitionStoredJob(cwd, jobId, (current) =>
    current.runStatus === "RUNNING"
      ? {
          ...current,
          heartbeatAt,
          ...(typeof lastProgressAt === "string" && lastProgressAt
            ? { lastProgressAt }
            : {})
        }
      : current
  );
  return heartbeatAt;
}

function listDurableJobsUnlocked(cwd) {
  ensureStateDir(cwd);
  return fs.readdirSync(resolveJobsDir(cwd), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      try {
        return migrateJob(readJobFile(path.join(resolveJobsDir(cwd), entry.name)));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function listDurableJobs(cwd) {
  return listDurableJobsUnlocked(cwd);
}

export function repairStateProjection(cwd) {
  return withStateLock(cwd, () => {
    const state = loadStateUnlocked(cwd);
    const durable = listDurableJobsUnlocked(cwd);
    const indexedById = new Map(state.jobs.map((job) => [job.id, job]));
    const projectedDurable = durable.map((job) => ({
      ...(indexedById.get(job.id) ?? {}),
      ...job
    }));
    const durableIds = new Set(durable.map((job) => job.id));
    const repaired = {
      ...state,
      jobs: pruneJobs([
        ...projectedDurable,
        ...state.jobs.filter((job) => !durableIds.has(job.id))
      ])
    };
    if (JSON.stringify(repaired.jobs) !== JSON.stringify(state.jobs)) {
      saveStateUnlocked(cwd, repaired);
    }
    return repaired;
  });
}

export function listJobs(cwd) {
  return repairStateProjection(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteJson(jobFile, payload);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

const JOB_TTL_DAYS_ENV = "CODEX_COMPANION_JOB_TTL_DAYS";
const MAX_TERMINAL_JOBS_ENV = "CODEX_COMPANION_MAX_TERMINAL_JOBS";
const DEFAULT_JOB_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TERMINAL_JOBS = 200;
const TERMINAL_RUN_STATUS_SET = new Set(["FINISHED", "FAILED", "CANCELLED", "INTERRUPTED"]);

function envPositiveNumber(name) {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function jobRunStatus(job) {
  if (job.runStatus) return job.runStatus;
  return {
    queued: "QUEUED",
    running: "RUNNING",
    completed: "FINISHED",
    failed: "FAILED",
    cancelled: "CANCELLED"
  }[job.status] ?? "FAILED";
}

// A job is purgeable only when its run is over AND nothing is left to
// reconcile; NEEDS_RECONCILIATION records are evidence and are always kept.
function jobIsResolvedTerminal(job) {
  return TERMINAL_RUN_STATUS_SET.has(jobRunStatus(job)) && job.outcomeStatus !== "NEEDS_RECONCILIATION";
}

function jobTimestampMs(job) {
  const parsed = Date.parse(job.completedAt ?? job.updatedAt ?? job.createdAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

// Deletes only regular files that live directly inside the jobs dir; symlinks
// are never followed or removed, so retention cannot escape the state root.
function safeUnlinkJobArtifact(jobsDir, filePath) {
  if (path.dirname(filePath) !== jobsDir) {
    return false;
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) {
    return false;
  }
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function purgeExpiredJobArtifacts(cwd, options = {}) {
  try { ensureStateDir(cwd); } catch { return { purgedJobs: 0, deletedFiles: 0 }; }
  const jobsDir = resolveJobsDir(cwd);
  let jobsStat;
  try {
    jobsStat = fs.lstatSync(jobsDir);
  } catch {
    return { purgedJobs: 0, deletedFiles: 0 };
  }
  if (!jobsStat.isDirectory()) {
    return { purgedJobs: 0, deletedFiles: 0 };
  }
  try {
    const realJobsDir = fs.realpathSync(jobsDir);
    const realStateDir = fs.realpathSync(resolveStateDir(cwd));
    if (path.dirname(realJobsDir) !== realStateDir) {
      return { purgedJobs: 0, deletedFiles: 0 };
    }
  } catch {
    return { purgedJobs: 0, deletedFiles: 0 };
  }
  let names;
  try {
    names = fs.readdirSync(jobsDir);
  } catch {
    return { purgedJobs: 0, deletedFiles: 0 };
  }
  const now = options.now ?? Date.now();
  const envTtlDays = envPositiveNumber(JOB_TTL_DAYS_ENV);
  const ttlMs = options.ttlMs ?? (envTtlDays !== null ? envTtlDays * 24 * 60 * 60 * 1000 : DEFAULT_JOB_TTL_MS);
  const maxTerminal = options.maxTerminal ?? envPositiveNumber(MAX_TERMINAL_JOBS_ENV) ?? DEFAULT_MAX_TERMINAL_JOBS;

  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const jobFile = path.join(jobsDir, name);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    } catch {
      continue; // Unreadable records are preserved, never deleted.
    }
    if (!job?.id || `${job.id}.json` !== name) {
      continue;
    }
    records.push({ job, jobFile });
  }

  const terminal = records.filter((record) => jobIsResolvedTerminal(record.job));
  const expired = new Set(terminal.filter((record) => now - jobTimestampMs(record.job) > ttlMs));
  const surviving = terminal
    .filter((record) => !expired.has(record))
    .sort((left, right) => jobTimestampMs(right.job) - jobTimestampMs(left.job));
  const overflow = surviving.slice(maxTerminal);
  const purgeList = [...expired, ...overflow];

  let deletedFiles = 0;
  const purgedIds = [];
  for (const { job, jobFile } of purgeList) {
    for (const filePath of [
      jobFile,
      path.join(jobsDir, `${job.id}.events.jsonl`),
      path.join(jobsDir, `${job.id}.log`)
    ]) {
      if (safeUnlinkJobArtifact(jobsDir, filePath)) {
        deletedFiles += 1;
      }
    }
    purgedIds.push(job.id);
  }

  if (purgedIds.length > 0) {
    const purged = new Set(purgedIds);
    try {
      updateState(cwd, (state) => ({
        ...state,
        jobs: state.jobs.filter((job) => !purged.has(job.id))
      }));
    } catch {
      // The projection self-repairs; artifact deletion is the point.
    }
  }
  return { purgedJobs: purgedIds.length, deletedFiles };
}
