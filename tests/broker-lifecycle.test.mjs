import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  ensureBrokerSession,
  isProcessAlive,
  loadBrokerSession,
  saveBrokerSession,
  sweepOrphanedBrokerSessionDirs,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { makeTempDir, writeExecutable } from "./helpers.mjs";

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

function withUmask(t, mask) {
  const previous = process.umask(mask);
  t.after(() => {
    process.umask(previous);
  });
}

function installStubBroker(binDir, { listen = true } = {}) {
  const scriptPath = path.join(binDir, "stub-broker.mjs");
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import process from "node:process";

const argv = process.argv.slice(2);
function opt(name) {
  const index = argv.indexOf("--" + name);
  return index === -1 ? null : argv[index + 1];
}

const endpoint = opt("endpoint");
const pidFile = opt("pid-file");
if (process.env.STUB_SPAWN_LOG) {
  fs.appendFileSync(process.env.STUB_SPAWN_LOG, process.pid + "\\n");
}
if (pidFile) {
  fs.writeFileSync(pidFile, process.pid + "\\n");
}
process.on("SIGTERM", () => process.exit(0));
${listen
      ? `const server = net.createServer((socket) => { socket.end(); });
server.listen(endpoint.slice("unix:".length));`
      : `setInterval(() => {}, 1000);`}
`
  );
  return scriptPath;
}

test("ensureBrokerSession spawns once and reuses the ready session", { skip: onWindows }, async (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const spawnLog = path.join(binDir, "spawns.log");
  const scriptPath = installStubBroker(binDir);
  const options = {
    scriptPath,
    sweep: false,
    env: { ...process.env, STUB_SPAWN_LOG: spawnLog }
  };

  const first = await ensureBrokerSession(cwd, options);
  assert.ok(first, "expected a broker session");
  t.after(() => {
    try {
      process.kill(first.pid);
    } catch {
      // Already exited.
    }
  });

  const second = await ensureBrokerSession(cwd, options);
  assert.equal(second?.endpoint, first.endpoint);
  assert.equal(fs.readFileSync(spawnLog, "utf8").trim().split("\n").length, 1);
});

test("concurrent ensure calls are serialized onto one broker", { skip: onWindows }, async (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const spawnLog = path.join(binDir, "spawns.log");
  const scriptPath = installStubBroker(binDir);
  const options = {
    scriptPath,
    sweep: false,
    env: { ...process.env, STUB_SPAWN_LOG: spawnLog }
  };

  const [first, second] = await Promise.all([ensureBrokerSession(cwd, options), ensureBrokerSession(cwd, options)]);
  assert.ok(first && second, "expected both callers to get a session");
  assert.equal(first.endpoint, second.endpoint);
  assert.equal(fs.readFileSync(spawnLog, "utf8").trim().split("\n").length, 1);
  t.after(() => {
    try {
      process.kill(first.pid);
    } catch {
      // Already exited.
    }
  });
});

test("a live but unresponsive broker session is left alone", { skip: onWindows }, async (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const session = {
    endpoint: `unix:${path.join(sessionDir, "broker.sock")}`,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    // This test process stands in for a busy broker that is alive but not
    // currently accepting connections.
    pid: process.pid
  };
  fs.writeFileSync(session.pidFile, `${process.pid}\n`, "utf8");
  fs.writeFileSync(session.logFile, "", "utf8");
  saveBrokerSession(cwd, session);

  const result = await ensureBrokerSession(cwd, { sweep: false, probeTimeoutMs: 100 });
  assert.equal(result, null, "expected fallback to no broker for this invocation");
  assert.deepEqual(loadBrokerSession(cwd), session, "session state must survive");
  assert.ok(fs.existsSync(session.pidFile), "session files must survive");
});

test("broker state rewrites repair existing files to mode 0600", { skip: onWindows }, (t) => {
  withPluginDataDir(t, makeTempDir());
  withUmask(t, 0o000);
  const cwd = makeTempDir();
  const stateDir = resolveStateDir(cwd);
  const stateFile = path.join(stateDir, "broker.json");
  const registryFile = path.join(stateDir, "broker-sessions.json");
  const missingSessionDir = path.join(makeTempDir(), "missing-session");
  const session = { endpoint: "unix:test", pid: 1234 };

  saveBrokerSession(cwd, session);
  fs.chmodSync(stateFile, 0o644);
  fs.writeFileSync(
    registryFile,
    `${JSON.stringify([{ dir: missingSessionDir, token: "tok" }], null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 }
  );
  fs.chmodSync(registryFile, 0o644);

  saveBrokerSession(cwd, session);
  sweepOrphanedBrokerSessionDirs({ cwd, minAgeMs: 0 });

  assert.deepEqual(
    {
      state: (fs.lstatSync(stateFile).mode & 0o777).toString(8),
      registry: (fs.lstatSync(registryFile).mode & 0o777).toString(8)
    },
    { state: "600", registry: "600" }
  );
});

test("saveBrokerSession rejects a symlinked configured plugin data root", { skip: onWindows }, (t) => {
  const parent = makeTempDir();
  const realPluginDataDir = path.join(parent, "real-plugin-data");
  const linkedPluginDataDir = path.join(parent, "linked-plugin-data");
  fs.mkdirSync(realPluginDataDir);
  fs.symlinkSync(realPluginDataDir, linkedPluginDataDir);
  withPluginDataDir(t, linkedPluginDataDir);
  const cwd = makeTempDir();

  assert.throws(
    () => saveBrokerSession(cwd, { endpoint: "unix:/x", pid: 1 }),
    /symlink/i,
    "symlinked configured root must be rejected"
  );
  assert.deepEqual(fs.readdirSync(realPluginDataDir), [], "nothing may be created through the configured symlink");
});

test("a dead broker session is torn down and replaced", { skip: onWindows }, async (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const tmpRoot = makeTempDir();
  const staleDir = makeOwnedDir(tmpRoot, "codex-companion-stale-session", "tok-stale");
  const stale = {
    endpoint: `unix:${path.join(staleDir, "broker.sock")}`,
    pidFile: path.join(staleDir, "broker.pid"),
    logFile: path.join(staleDir, "broker.log"),
    sessionDir: staleDir,
    pid: 2147483646
  };
  fs.writeFileSync(stale.pidFile, `${stale.pid}\n`, "utf8");
  fs.writeFileSync(stale.logFile, "codex app-server exited mid-session: fixture fatal stderr\n", "utf8");
  saveBrokerSession(cwd, stale);

  const binDir = makeTempDir();
  const scriptPath = installStubBroker(binDir);
  const replacement = await ensureBrokerSession(cwd, { scriptPath, sweep: false, probeTimeoutMs: 100 });
  assert.ok(replacement, "expected a replacement session");
  assert.notEqual(replacement.endpoint, stale.endpoint);
  assert.equal(loadBrokerSession(cwd)?.endpoint, replacement.endpoint);
  assert.ok(!fs.existsSync(stale.pidFile), "stale pid artifact must be removed");
  assert.ok(!fs.existsSync(stale.logFile), "stale log artifact must be removed");
  const deathLog = path.join(resolveStateDir(cwd), "broker-deaths.log");
  assert.ok(fs.existsSync(deathLog), "dead broker log must be archived before deletion");
  assert.match(fs.readFileSync(deathLog, "utf8"), /fixture fatal stderr/);
  t.after(() => {
    try {
      process.kill(replacement.pid);
    } catch {
      // Already exited.
    }
  });
});

test("teardown creates a private archive dir and death log under a permissive umask", { skip: onWindows }, (t) => {
  withUmask(t, 0o000);
  const tmpRoot = makeTempDir();
  const sessionDir = makeOwnedDir(tmpRoot, "codex-companion-teardown", "tok");
  const logFile = path.join(sessionDir, "broker.log");
  const archiveParent = makeTempDir();
  const archiveDir = path.join(archiveParent, "archive");
  const archiveLogTo = path.join(archiveDir, "broker-deaths.log");
  fs.writeFileSync(logFile, "fatal broker output\n", "utf8");

  teardownBrokerSession({
    logFile,
    pidFile: null,
    sessionDir,
    pid: null,
    archiveLogTo
  });

  assert.equal((fs.lstatSync(archiveDir).mode & 0o777).toString(8), "700");
  assert.equal((fs.lstatSync(archiveLogTo).mode & 0o777).toString(8), "600");
  assert.match(fs.readFileSync(archiveLogTo, "utf8"), /fatal broker output/);
});

test("teardown preserves unauthenticated targets and does not archive their log", () => {
  const tmpRoot = makeTempDir();
  const sessionDir = path.join(tmpRoot, "unauthenticated-session");
  const pidFile = path.join(tmpRoot, "victim.pid");
  const logFile = path.join(tmpRoot, "victim.log");
  const archiveLogTo = path.join(tmpRoot, "archive", "broker-deaths.log");
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(pidFile, "2147483646\n", "utf8");
  fs.writeFileSync(logFile, "victim log contents\n", "utf8");

  teardownBrokerSession({
    pidFile,
    logFile,
    sessionDir,
    archiveLogTo
  });

  assert.ok(fs.existsSync(pidFile), "unauthenticated pid target must survive");
  assert.ok(fs.existsSync(logFile), "unauthenticated log target must survive");
  assert.ok(fs.existsSync(sessionDir), "unauthenticated session dir must survive");
  assert.ok(!fs.existsSync(archiveLogTo), "unauthenticated log must not be archived");
});

test("teardown preserves a broker session dir reported as foreign-owned", { skip: typeof process.getuid !== "function" }, () => {
  const tmpRoot = makeTempDir();
  const sessionDir = makeOwnedDir(tmpRoot, "codex-companion-foreign-owner-teardown", "tok-foreign");
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "2147483646\n", "utf8");
  fs.writeFileSync(logFile, "victim log\n", "utf8");
  const originalLstatSync = fs.lstatSync;

  fs.lstatSync = (target, ...args) => {
    const result = originalLstatSync(target, ...args);
    return target === sessionDir
      ? { ...result, uid: process.getuid() + 1, isDirectory: () => result.isDirectory() }
      : result;
  };
  try {
    teardownBrokerSession({ pidFile, logFile, sessionDir });
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.ok(fs.existsSync(pidFile), "foreign-owned pid file must survive");
  assert.ok(fs.existsSync(logFile), "foreign-owned log file must survive");
  assert.ok(fs.existsSync(sessionDir), "foreign-owned session dir must survive");
});

test("teardown re-verifies the session inode before deleting artifacts", () => {
  const tmpRoot = makeTempDir();
  const sessionDir = makeOwnedDir(tmpRoot, "codex-companion-swapped-teardown", "tok-swap");
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "2147483646\n", "utf8");
  fs.writeFileSync(logFile, "victim log\n", "utf8");
  const originalLstatSync = fs.lstatSync;
  let sessionDirLstatCalls = 0;

  fs.lstatSync = (target, ...args) => {
    const result = originalLstatSync(target, ...args);
    if (target === sessionDir && ++sessionDirLstatCalls === 2) {
      return { ...result, ino: result.ino + 1, isDirectory: () => result.isDirectory() };
    }
    return result;
  };
  try {
    teardownBrokerSession({ pidFile, logFile, sessionDir });
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.equal(sessionDirLstatCalls, 2, "the session path must be checked again before teardown");
  assert.ok(fs.existsSync(pidFile), "pid file at a swapped path must survive");
  assert.ok(fs.existsSync(logFile), "log file at a swapped path must survive");
  assert.ok(fs.existsSync(sessionDir), "a swapped session path must survive");
});

test("teardown never reads or deletes a symlinked broker log", { skip: onWindows }, () => {
  const tmpRoot = makeTempDir();
  const sessionDir = makeOwnedDir(tmpRoot, "codex-companion-symlink-log", "tok");
  const secretFile = path.join(tmpRoot, "secret.txt");
  const logFile = path.join(sessionDir, "broker.log");
  const archiveLogTo = path.join(tmpRoot, "archive", "broker-deaths.log");
  const secret = "teardown must not archive this secret";
  fs.writeFileSync(secretFile, `${secret}\n`, "utf8");
  fs.symlinkSync(secretFile, logFile);

  teardownBrokerSession({
    pidFile: null,
    logFile,
    sessionDir,
    archiveLogTo
  });

  assert.ok(fs.lstatSync(logFile).isSymbolicLink(), "symlinked log must survive");
  assert.ok(fs.existsSync(secretFile), "symlink target must survive");
  const archived = fs.existsSync(archiveLogTo) ? fs.readFileSync(archiveLogTo, "utf8") : "";
  assert.doesNotMatch(archived, new RegExp(secret));
});

test("a spawned broker that never becomes ready is killed, not orphaned", { skip: onWindows }, async (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const scriptPath = installStubBroker(binDir, { listen: false });
  const killed = [];

  const result = await ensureBrokerSession(cwd, {
    scriptPath,
    sweep: false,
    timeoutMs: 300,
    killProcess: (pid) => {
      killed.push(pid);
      process.kill(pid);
    }
  });
  assert.equal(result, null);
  assert.equal(killed.length, 1, "the unready child must be killed");
  assert.equal(loadBrokerSession(cwd), null, "no session may be recorded");
});

function writeRegistry(cwd, entries) {
  const registryFile = path.join(resolveStateDir(cwd), "broker-sessions.json");
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  return registryFile;
}

function makeOwnedDir(tmpRoot, name, token, { marker = true, ageMs = 60_000 } = {}) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  if (marker === true) {
    fs.writeFileSync(path.join(dir, "broker.owner"), `${JSON.stringify({ token })}\n`, "utf8");
  } else if (marker === "malformed") {
    fs.writeFileSync(path.join(dir, "broker.owner"), "not json\n", "utf8");
  }
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, old, old);
  return dir;
}

test("sweep ignores unregistered directories entirely, even with matching names", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const tmpRoot = makeTempDir();
  const foreign = makeOwnedDir(tmpRoot, "codex-companion-foreign", "sometoken");
  const unrelated = makeOwnedDir(tmpRoot, "cxc-unrelated", "x", { marker: false });

  const removed = sweepOrphanedBrokerSessionDirs({ cwd, tmpRoot, minAgeMs: 1000 });
  assert.equal(removed, 0);
  assert.ok(fs.existsSync(foreign), "unregistered dirs must never be deleted");
  assert.ok(fs.existsSync(unrelated), "unrelated dirs must never be deleted");
});

test("sweep preserves a registered dir whose ownership marker is missing", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const tmpRoot = makeTempDir();
  const dir = makeOwnedDir(tmpRoot, "codex-companion-nomarker", "tok-a", { marker: false });
  writeRegistry(cwd, [{ dir, token: "tok-a" }]);

  const removed = sweepOrphanedBrokerSessionDirs({ cwd, tmpRoot, minAgeMs: 1000 });
  assert.equal(removed, 0);
  assert.ok(fs.existsSync(dir), "missing ownership evidence must mean preserve");
});

test("sweep preserves a registered dir whose marker is malformed or mismatched", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const tmpRoot = makeTempDir();
  const malformed = makeOwnedDir(tmpRoot, "codex-companion-badmarker", "tok-b", { marker: "malformed" });
  const mismatched = makeOwnedDir(tmpRoot, "codex-companion-wrongtok", "actual-token");
  writeRegistry(cwd, [
    { dir: malformed, token: "tok-b" },
    { dir: mismatched, token: "expected-token" }
  ]);

  const removed = sweepOrphanedBrokerSessionDirs({ cwd, tmpRoot, minAgeMs: 1000 });
  assert.equal(removed, 0);
  assert.ok(fs.existsSync(malformed));
  assert.ok(fs.existsSync(mismatched));
});

test("sweep never deletes a registered dir reported as foreign-owned", { skip: typeof process.getuid !== "function" }, (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const tmpRoot = makeTempDir();
  const dir = makeOwnedDir(tmpRoot, "codex-companion-foreign-owner", "tok-foreign");
  const registryFile = writeRegistry(cwd, [{ dir, token: "tok-foreign" }]);
  const originalLstatSync = fs.lstatSync;

  fs.lstatSync = (target, ...args) => {
    const result = originalLstatSync(target, ...args);
    return target === dir
      ? { ...result, uid: process.getuid() + 1, isDirectory: () => result.isDirectory() }
      : result;
  };
  let removed;
  try {
    removed = sweepOrphanedBrokerSessionDirs({ cwd, tmpRoot, minAgeMs: 1000 });
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.equal(removed, 0);
  assert.ok(fs.existsSync(dir), "foreign-owned dirs must never be deleted");
  assert.deepEqual(JSON.parse(fs.readFileSync(registryFile, "utf8")), [], "foreign-owned dirs must stop being tracked");
});

test("sweep never follows or deletes a symlinked registry entry", { skip: onWindows }, (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const tmpRoot = makeTempDir();
  const target = makeOwnedDir(tmpRoot, "codex-companion-target", "tok-c");
  const link = path.join(tmpRoot, "codex-companion-link");
  fs.symlinkSync(target, link);
  writeRegistry(cwd, [{ dir: link, token: "tok-c" }]);

  const removed = sweepOrphanedBrokerSessionDirs({ cwd, tmpRoot, minAgeMs: 1000 });
  assert.equal(removed, 0);
  assert.ok(fs.existsSync(target), "symlink target must survive");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "symlink itself must survive");
});

test("sweep refuses registered paths outside the temp root", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const tmpRoot = makeTempDir();
  const outsideRoot = makeTempDir();
  const outside = makeOwnedDir(outsideRoot, "codex-companion-outside", "tok-d");
  writeRegistry(cwd, [{ dir: outside, token: "tok-d" }]);

  const removed = sweepOrphanedBrokerSessionDirs({ cwd, tmpRoot, minAgeMs: 1000 });
  assert.equal(removed, 0);
  assert.ok(fs.existsSync(outside), "paths outside the temp root must never be deleted");
});

test("sweep removes a valid stale owned dir and preserves a live one", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const tmpRoot = makeTempDir();
  const stale = makeOwnedDir(tmpRoot, "codex-companion-stale", "tok-e");
  fs.writeFileSync(path.join(stale, "broker.pid"), "2147483646\n", "utf8");
  const live = makeOwnedDir(tmpRoot, "codex-companion-live", "tok-f");
  fs.writeFileSync(path.join(live, "broker.pid"), `${process.pid}\n`, "utf8");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(live, old, old);
  writeRegistry(cwd, [
    { dir: stale, token: "tok-e" },
    { dir: live, token: "tok-f" }
  ]);

  const removed = sweepOrphanedBrokerSessionDirs({ cwd, tmpRoot, minAgeMs: 1000 });
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(stale), "stale owned dir must be removed");
  assert.ok(fs.existsSync(live), "live broker dir must survive");
});

test("sweep re-verifies the inode immediately before removing an owned dir", (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const tmpRoot = makeTempDir();
  const dir = makeOwnedDir(tmpRoot, "codex-companion-swapped", "tok-swap");
  const entry = { dir, token: "tok-swap" };
  const registryFile = writeRegistry(cwd, [entry]);
  const originalLstatSync = fs.lstatSync;
  let dirLstatCalls = 0;

  fs.lstatSync = (target, ...args) => {
    const result = originalLstatSync(target, ...args);
    if (target === dir && ++dirLstatCalls === 2) {
      return { ...result, ino: result.ino + 1, isDirectory: () => result.isDirectory() };
    }
    return result;
  };
  let removed;
  try {
    removed = sweepOrphanedBrokerSessionDirs({ cwd, tmpRoot, minAgeMs: 1000 });
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.equal(dirLstatCalls, 2, "the registered path must be checked again before removal");
  assert.equal(removed, 0);
  assert.ok(fs.existsSync(dir), "a path whose inode changed must survive");
  assert.deepEqual(JSON.parse(fs.readFileSync(registryFile, "utf8")), [entry], "swapped paths must be retried later");
});

test("ensureBrokerSession registers its session dir with an ownership marker", { skip: onWindows }, async (t) => {
  withPluginDataDir(t, makeTempDir());
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const scriptPath = installStubBroker(binDir);
  const session = await ensureBrokerSession(cwd, { scriptPath, sweep: false });
  assert.ok(session, "expected a broker session");
  t.after(() => {
    try {
      process.kill(session.pid);
    } catch {
      // Already exited.
    }
  });
  const marker = JSON.parse(fs.readFileSync(path.join(session.sessionDir, "broker.owner"), "utf8"));
  const registry = JSON.parse(
    fs.readFileSync(path.join(resolveStateDir(cwd), "broker-sessions.json"), "utf8")
  );
  const entry = registry.find((candidate) => candidate.dir === session.sessionDir);
  assert.ok(entry, "session dir must be registered");
  assert.equal(entry.token, marker.token, "registry token must match the ownership marker");
  assert.ok(marker.token.length >= 32, "ownership token must be high-entropy");
});

test("isProcessAlive distinguishes live and dead pids", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2147483646), false);
  assert.equal(isProcessAlive(null), false);
});
