import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { captureProcessIdentity, terminateProcessTreeVerified, verifyProcessIdentity } from "./process.mjs";
import { ensurePrivateDir, ensureStateDir, privateAppendFileSync, privateWriteFileSync, resolveStateDir, stealStateLock } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_REGISTRY_FILE = "broker-sessions.json";
const OWNERSHIP_MARKER_FILE = "broker.owner";
const SESSION_DIR_PREFIX = "codex-companion-";

export function createBrokerSessionDir(prefix = SESSION_DIR_PREFIX) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // mkdtemp already creates 0700 minus umask; this repairs permissive umasks.
    }
  }
  return dir;
}

function resolveBrokerRegistryFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_REGISTRY_FILE);
}

function loadBrokerRegistry(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveBrokerRegistryFile(cwd), "utf8"));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry) => typeof entry?.dir === "string" && typeof entry?.token === "string");
  } catch {
    return [];
  }
}

function saveBrokerRegistry(cwd, entries) {
  const registryFile = resolveBrokerRegistryFile(cwd);
  ensureStateDir(cwd);
  privateWriteFileSync(registryFile, `${JSON.stringify(entries, null, 2)}\n`);
}

function registerBrokerSessionDir(cwd, sessionDir, token, identity = null) {
  const entries = loadBrokerRegistry(cwd).filter((entry) => entry.dir !== sessionDir);
  entries.push({
    dir: sessionDir,
    token,
    createdAt: new Date().toISOString(),
    ...(identity ? { pid: identity.pid, startedAt: identity.startedAt } : {})
  });
  saveBrokerRegistry(cwd, entries);
}

function unregisterBrokerSessionDir(cwd, sessionDir) {
  if (!sessionDir) {
    return;
  }
  const entries = loadBrokerRegistry(cwd);
  const remaining = entries.filter((entry) => entry.dir !== sessionDir);
  if (remaining.length !== entries.length) {
    saveBrokerRegistry(cwd, remaining);
  }
}

function writeOwnershipMarker(sessionDir, token) {
  privateWriteFileSync(
    path.join(sessionDir, OWNERSHIP_MARKER_FILE),
    `${JSON.stringify({ token, createdAt: new Date().toISOString() })}\n`
  );
}

function readOwnershipToken(sessionDir) {
  try {
    const token = JSON.parse(fs.readFileSync(path.join(sessionDir, OWNERSHIP_MARKER_FILE), "utf8"))?.token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, launchToken = null, env = process.env }) {
  const logFd = fs.openSync(logFile, "a", 0o600);
  const args = [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile];
  if (launchToken) {
    // Visible in the broker's argv (ps) so process identity can be verified
    // before any signal is ever sent to this pid.
    args.push("--launch-token", launchToken);
  }
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  ensureStateDir(cwd);
  privateWriteFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`);
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

// A short probe raced concurrent CLI invocations against a busy broker and lost,
// which tore down live sessions; keep the budget generous (the internal retry
// loop reconnects every 50 ms, so a ready broker still answers instantly).
const READINESS_PROBE_MS = 750;
const ENSURE_LOCK_TIMEOUT_MS = 8000;
const ENSURE_LOCK_STALE_MS = 15000;
const ORPHAN_SWEEP_MIN_AGE_MS = 10 * 60 * 1000;

async function isBrokerEndpointReady(endpoint, timeoutMs = READINESS_PROBE_MS) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, timeoutMs);
  } catch {
    return false;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function releaseOwnedEnsureLock(lockFile) {
  try {
    const ownerPid = JSON.parse(fs.readFileSync(lockFile, "utf8"))?.pid;
    if (ownerPid === process.pid) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    // A replaced or already-removed lock is not ours to release.
  }
}

function readLockOwnerPid(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"))?.pid ?? null;
  } catch {
    return null;
  }
}

// Acquires the lock or returns false. Never leaves an anonymous lock behind:
// if the owner record cannot be written, the just-created lock is removed so
// other callers are not stuck waiting out the stale age on an empty file.
function tryAcquireEnsureLock(lockFile) {
  let fd = null;
  try {
    fd = fs.openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // Best effort: the stale-age steal remains the backstop.
    }
    return false;
  }
  fs.closeSync(fd);
  return true;
}

// Serializes concurrent ensure/spawn attempts per cwd. Without it, racing CLI
// invocations (job workers plus every status/result call) each spawned their
// own broker and last-writer-won the state file, orphaning the rest.
async function withEnsureLock(cwd, callback) {
  const stateDir = resolveStateDir(cwd);
  ensureStateDir(cwd);
  const lockFile = path.join(stateDir, "broker.ensure.lock");
  const deadline = Date.now() + ENSURE_LOCK_TIMEOUT_MS;
  while (true) {
    if (tryAcquireEnsureLock(lockFile)) {
      try {
        return await callback();
      } finally {
        releaseOwnedEnsureLock(lockFile);
      }
    }
    try {
      // Steal only while the lock still belongs to the owner we judged dead or
      // stale; a blind steal here could rename away a lock another process just
      // legitimately acquired after its own steal.
      const ownerPid = readLockOwnerPid(lockFile);
      const ownerDead = Number.isFinite(ownerPid) && ownerPid !== process.pid && !isProcessAlive(ownerPid);
      const ownerUnknownAndStale = !Number.isFinite(ownerPid) && Date.now() - fs.statSync(lockFile).mtimeMs > ENSURE_LOCK_STALE_MS;
      if ((ownerDead || ownerUnknownAndStale) && readLockOwnerPid(lockFile) === ownerPid) {
        stealStateLock(lockFile);
        continue;
      }
    } catch {
      // Lock vanished or is unreadable; fall through to the retry cadence so
      // persistent errors still honor the deadline instead of spinning.
    }
    if (Date.now() >= deadline) {
      // Degrade to no broker for this invocation rather than failing the call.
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Deletes only session dirs this plugin positively created for this cwd: the
// dir must be listed in the per-cwd registry AND carry an ownership marker
// whose random token matches the registry entry. The temp root is never
// enumerated, so an unrelated directory can never be selected; missing or
// unreadable ownership evidence means preserve, not delete.
export function sweepOrphanedBrokerSessionDirs(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const aliveCheck = options.isProcessAlive ?? isProcessAlive;
  const minAgeMs = options.minAgeMs ?? ORPHAN_SWEEP_MIN_AGE_MS;
  let resolvedTmpRoot;
  try {
    resolvedTmpRoot = fs.realpathSync(tmpRoot);
  } catch {
    return 0;
  }
  const entries = loadBrokerRegistry(cwd);
  if (entries.length === 0) {
    return 0;
  }
  let removed = 0;
  const remaining = [];
  for (const entry of entries) {
    let keepEntry = false;
    try {
      let stat;
      try {
        stat = fs.lstatSync(entry.dir);
      } catch {
        // The dir is gone; drop the registry entry.
        continue;
      }
      if (!stat.isDirectory()) {
        // Symlink or file substituted at the registered path: never follow or
        // delete it, and stop tracking it.
        continue;
      }
      const containedInTmpRoot = (() => {
        try {
          return fs.realpathSync(entry.dir).startsWith(resolvedTmpRoot + path.sep);
        } catch {
          return false;
        }
      })();
      if (!containedInTmpRoot) {
        continue;
      }
      const token = readOwnershipToken(entry.dir);
      if (!token || token !== entry.token) {
        // Missing, malformed, or mismatched ownership evidence: preserve.
        continue;
      }
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        // Foreign-owned dir: never delete it, and stop tracking it.
        continue;
      }
      if (Date.now() - stat.mtimeMs < minAgeMs) {
        keepEntry = true;
        continue;
      }
      if (Number.isFinite(entry.pid) && Number.isFinite(entry.startedAt) && !options.isProcessAlive) {
        // Registered launch identity: the broker counts as alive only if the
        // pid still carries the recorded start time and token.
        if (verifyProcessIdentity({ pid: entry.pid, startedAt: entry.startedAt, token: entry.token }).verified) {
          keepEntry = true;
          continue;
        }
      } else {
        let pid = null;
        try {
          pid = Number.parseInt(fs.readFileSync(path.join(entry.dir, "broker.pid"), "utf8").trim(), 10);
        } catch {
          // Broker already removed its pid file on exit.
        }
        if (Number.isFinite(pid) && aliveCheck(pid)) {
          keepEntry = true;
          continue;
        }
      }
      let confirm;
      try {
        confirm = fs.lstatSync(entry.dir);
      } catch {
        keepEntry = true;
        continue;
      }
      if (confirm.dev !== stat.dev || confirm.ino !== stat.ino || !confirm.isDirectory()) {
        // The path was swapped since validation; do not delete, retry next sweep.
        keepEntry = true;
        continue;
      }
      fs.rmSync(entry.dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best-effort sweep; keep the entry for a later attempt.
      keepEntry = true;
    } finally {
      if (keepEntry) {
        remaining.push(entry);
      }
    }
  }
  try {
    saveBrokerRegistry(cwd, remaining);
  } catch {
    // Registry persistence is best-effort.
  }
  return removed;
}

export async function ensureBrokerSession(cwd, options = {}) {
  return withEnsureLock(cwd, async () => {
    const existing = loadBrokerSession(cwd);
    if (existing) {
      if (await isBrokerEndpointReady(existing.endpoint, options.probeTimeoutMs)) {
        return existing;
      }
      const aliveCheck = options.isProcessAlive ?? isProcessAlive;
      const existingLooksAlive =
        existing.identity && Number.isFinite(existing.identity.startedAt) && !options.isProcessAlive
          ? verifyProcessIdentity(existing.identity).verified
          : aliveCheck(existing.pid);
      if (existingLooksAlive) {
        // The broker process is alive but not answering (busy or still starting).
        // Never tear down a live session: leave it for the turn it is serving and
        // let this invocation fall back to a direct app-server.
        return null;
      }
      teardownBrokerSession({
        endpoint: existing.endpoint ?? null,
        pidFile: existing.pidFile ?? null,
        logFile: existing.logFile ?? null,
        sessionDir: existing.sessionDir ?? null,
        pid: existing.pid ?? null,
        killProcess: options.killProcess ?? null,
        archiveLogTo: path.join(resolveStateDir(cwd), "broker-deaths.log")
      });
      clearBrokerSession(cwd);
      unregisterBrokerSessionDir(cwd, existing.sessionDir ?? null);
    }

    const sessionDir = createBrokerSessionDir();
    const ownershipToken = crypto.randomBytes(24).toString("hex");
    writeOwnershipMarker(sessionDir, ownershipToken);
    registerBrokerSessionDir(cwd, sessionDir, ownershipToken);
    const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
    const endpoint = endpointFactory(sessionDir, options.platform);
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    const scriptPath =
      options.scriptPath ??
      fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

    const child = spawnBrokerProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      launchToken: ownershipToken,
      env: options.env ?? process.env
    });
    const capturedIdentity = captureProcessIdentity(child.pid);
    const identity = capturedIdentity ? { ...capturedIdentity, token: ownershipToken } : null;
    if (identity) {
      registerBrokerSessionDir(cwd, sessionDir, ownershipToken, identity);
    }

    const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
    if (!ready) {
      teardownBrokerSession({
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        // We own this child: it never became ready, so kill it (and any
        // app-server it already spawned) instead of orphaning it the way the
        // old default did. The kill is identity-verified so a recycled pid is
        // never signaled.
        killProcess: options.killProcess ?? (() => terminateProcessTreeVerified(identity)),
        archiveLogTo: path.join(resolveStateDir(cwd), "broker-deaths.log")
      });
      unregisterBrokerSessionDir(cwd, sessionDir);
      return null;
    }

    const session = {
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      identity
    };
    saveBrokerSession(cwd, session);
    if (options.sweep !== false) {
      try {
        sweepOrphanedBrokerSessionDirs({ cwd, isProcessAlive: options.isProcessAlive });
      } catch {
        // Sweep is best-effort housekeeping.
      }
    }
    return session;
  });
}

const ARCHIVED_LOG_TAIL_BYTES = 16384;

// An authentic broker session dir is a real (non-symlink) directory under the
// temp root, named with the session prefix, owned by this user, and carrying a
// valid ownership marker.
function authenticBrokerSessionStat(sessionDir) {
  if (!sessionDir) return null;
  let stat;
  try { stat = fs.lstatSync(sessionDir); } catch { return null; }
  if (!stat.isDirectory()) return null; // symlink-to-dir is isDirectory()===false under lstat
  if (!path.basename(sessionDir).startsWith(SESSION_DIR_PREFIX)) return null;
  let realDir, realTmp;
  try { realDir = fs.realpathSync(sessionDir); realTmp = fs.realpathSync(os.tmpdir()); } catch { return null; }
  if (realDir !== realTmp && !realDir.startsWith(realTmp + path.sep)) return null;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
  if (readOwnershipToken(sessionDir) === null) return null;
  return stat;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null, archiveLogTo = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try { killProcess(pid); } catch { /* ignore missing/exited broker */ }
  }
  const authStat = authenticBrokerSessionStat(sessionDir);
  if (!authStat) {
    return; // No authenticated session dir => preserve everything (process still signaled above).
  }
  const inSession = (p, base) => typeof p === "string" && path.dirname(p) === sessionDir && path.basename(p) === base;
  let confirmStat;
  try { confirmStat = fs.lstatSync(sessionDir); } catch { return; }
  if (confirmStat.dev !== authStat.dev || confirmStat.ino !== authStat.ino || !confirmStat.isDirectory()) return;
  if (inSession(pidFile, "broker.pid") && fs.existsSync(pidFile)) {
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
  }
  if (inSession(logFile, "broker.log") && fs.existsSync(logFile)) {
    let logStat = null;
    try { logStat = fs.lstatSync(logFile); } catch { logStat = null; }
    if (logStat && logStat.isFile()) { // never read/delete a symlinked log
      if (archiveLogTo) {
        try {
          const contents = fs.readFileSync(logFile, "utf8");
          const tail = contents.length > ARCHIVED_LOG_TAIL_BYTES ? contents.slice(-ARCHIVED_LOG_TAIL_BYTES) : contents;
          if (tail.trim()) {
            ensurePrivateDir(path.dirname(archiveLogTo));
            privateAppendFileSync(archiveLogTo, `\n===== broker.log archived ${new Date().toISOString()} from ${logFile} =====\n${tail.endsWith("\n") ? tail : `${tail}\n`}`);
          }
        } catch { /* archiving best-effort */ }
      }
      try { fs.unlinkSync(logFile); } catch { /* ignore */ }
    }
  }
  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && inSession(target.path, "broker.sock") && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch { /* ignore malformed/removed endpoint */ }
  }
  if (fs.existsSync(sessionDir)) {
    try { fs.rmdirSync(sessionDir); } catch { /* non-empty or missing */ }
  }
}
