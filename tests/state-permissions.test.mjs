import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  appendJobEvent,
  ensurePrivateDir,
  ensureStateDir,
  privateAppendFileSync,
  privateWriteFileSync,
  resolveJobsDir,
  resolveStateDir,
  updateState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { createJobLogFile } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { ensureBrokerSession, loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
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

function modeOf(p) {
  return fs.lstatSync(p).mode & 0o777;
}

for (const mask of [0o000, 0o022]) {
  test(`ensurePrivateDir creates and repairs 0700 dirs under umask ${mask.toString(8)}`, { skip: onWindows }, (t) => {
    withUmask(t, mask);
    const parent = makeTempDir();
    const newDir = path.join(parent, "new-private-dir");
    const existingDir = path.join(parent, "existing-private-dir");

    ensurePrivateDir(newDir);
    assert.equal((fs.lstatSync(newDir).mode & 0o777).toString(8), "700");

    fs.mkdirSync(existingDir, { mode: 0o777 });
    fs.chmodSync(existingDir, 0o777);
    ensurePrivateDir(existingDir);
    assert.equal((fs.lstatSync(existingDir).mode & 0o777).toString(8), "700");
  });
}

test("privateAppendFileSync repairs a pre-existing file to 0600", { skip: onWindows }, (t) => {
  withUmask(t, 0o000);
  const filePath = path.join(makeTempDir(), "append.log");
  fs.writeFileSync(filePath, "before\n", { encoding: "utf8", mode: 0o644 });

  privateAppendFileSync(filePath, "after\n");

  assert.equal(fs.readFileSync(filePath, "utf8"), "before\nafter\n");
  assert.equal((fs.lstatSync(filePath).mode & 0o777).toString(8), "600");
});

test("privateWriteFileSync replaces a symlink without overwriting its target", { skip: onWindows }, () => {
  const parent = makeTempDir();
  const outsideDir = path.join(parent, "outside");
  const stateDir = path.join(parent, "state");
  const secret = path.join(outsideDir, "secret");
  const linkPath = path.join(stateDir, "state.json");
  fs.mkdirSync(outsideDir);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(secret, "original", "utf8");
  fs.symlinkSync(secret, linkPath);

  privateWriteFileSync(linkPath, "NEW");

  assert.equal(fs.readFileSync(secret, "utf8"), "original");
  assert.ok(fs.lstatSync(linkPath).isFile(), "state-file path must become a regular file");
  assert.equal(fs.readFileSync(linkPath, "utf8"), "NEW");
});

test("privateAppendFileSync replaces a symlink without appending to its target", { skip: onWindows }, () => {
  const parent = makeTempDir();
  const outsideDir = path.join(parent, "outside");
  const stateDir = path.join(parent, "state");
  const secret = path.join(outsideDir, "secret");
  const linkPath = path.join(stateDir, "events.jsonl");
  fs.mkdirSync(outsideDir);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(secret, "original", "utf8");
  fs.symlinkSync(secret, linkPath);

  privateAppendFileSync(linkPath, "NEW");

  assert.equal(fs.readFileSync(secret, "utf8"), "original");
  assert.ok(fs.lstatSync(linkPath).isFile(), "state-file path must become a regular file");
  assert.equal(fs.readFileSync(linkPath, "utf8"), "NEW");
});

test("privateWriteFileSync fails closed when a symlinked target cannot be removed", { skip: onWindows }, () => {
  const parent = makeTempDir();
  const outsideDir = path.join(parent, "outside");
  const stateDir = path.join(parent, "state");
  const secret = path.join(outsideDir, "secret");
  const linkPath = path.join(stateDir, "state.json");
  fs.mkdirSync(outsideDir);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(secret, "original", "utf8");
  fs.symlinkSync(secret, linkPath);

  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (p, ...rest) => {
    if (p === linkPath) {
      const error = new Error("EACCES: operation not permitted");
      error.code = "EACCES";
      throw error;
    }
    return realUnlink(p, ...rest);
  };
  try {
    assert.throws(
      () => privateWriteFileSync(linkPath, "NEW"),
      /EACCES/,
      "must refuse to write when a planted symlink cannot be removed"
    );
  } finally {
    fs.unlinkSync = realUnlink;
  }

  assert.equal(fs.readFileSync(secret, "utf8"), "original", "outside target must never be written through the link");
});

test("state dirs and files are private even under a permissive umask", { skip: onWindows }, (t) => {
  withPluginDataDir(t, makeTempDir());
  withUmask(t, 0o000);
  const cwd = makeTempDir();

  ensureStateDir(cwd);
  assert.equal(modeOf(resolveStateDir(cwd)), 0o700, "state dir must be 0700");
  assert.equal(modeOf(resolveJobsDir(cwd)), 0o700, "jobs dir must be 0700");

  updateState(cwd, (state) => state);
  assert.equal(modeOf(path.join(resolveStateDir(cwd), "state.json")), 0o600, "state file must be 0600");

  writeJobFile(cwd, "job-a", { id: "job-a" });
  assert.equal(modeOf(path.join(resolveJobsDir(cwd), "job-a.json")), 0o600, "job file must be 0600");

  appendJobEvent(cwd, "job-a", { type: "created" });
  assert.equal(modeOf(path.join(resolveJobsDir(cwd), "job-a.events.jsonl")), 0o600, "event file must be 0600");

  const logFile = createJobLogFile(cwd, "job-a", "Codex Task");
  assert.equal(modeOf(logFile), 0o600, "job log must be 0600");
});

test("a symlinked state dir is rejected", { skip: onWindows }, (t) => {
  const pluginDataDir = makeTempDir();
  withPluginDataDir(t, pluginDataDir);
  const cwd = makeTempDir();
  const stateDir = resolveStateDir(cwd);
  const elsewhere = makeTempDir();
  fs.mkdirSync(path.dirname(stateDir), { recursive: true });
  fs.symlinkSync(elsewhere, stateDir);

  assert.throws(() => ensureStateDir(cwd), /symlink/i, "symlinked state dir must be rejected");
});

test("a symlinked configured plugin data root is rejected without creating through it", { skip: onWindows }, (t) => {
  const parent = makeTempDir();
  const realPluginDataDir = path.join(parent, "real-plugin-data");
  const linkedPluginDataDir = path.join(parent, "linked-plugin-data");
  fs.mkdirSync(realPluginDataDir);
  fs.symlinkSync(realPluginDataDir, linkedPluginDataDir);
  withPluginDataDir(t, linkedPluginDataDir);
  const cwd = makeTempDir();

  assert.throws(() => ensureStateDir(cwd), /symlink/i, "symlinked configured root must be rejected");
  assert.deepEqual(fs.readdirSync(realPluginDataDir), [], "nothing may be created through the configured symlink");
});

test("broker session dir, marker, registry, and log are private", { skip: onWindows }, async (t) => {
  withPluginDataDir(t, makeTempDir());
  withUmask(t, 0o000);
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const scriptPath = path.join(binDir, "stub-broker.mjs");
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
const argv = process.argv.slice(2);
function opt(name) { const i = argv.indexOf("--" + name); return i === -1 ? null : argv[i + 1]; }
const endpoint = opt("endpoint");
const pidFile = opt("pid-file");
if (pidFile) fs.writeFileSync(pidFile, process.pid + "\\n");
process.on("SIGTERM", () => process.exit(0));
const server = net.createServer((socket) => { socket.end(); });
server.listen(endpoint.slice("unix:".length));
`
  );

  const session = await ensureBrokerSession(cwd, { scriptPath, sweep: false });
  assert.ok(session, "expected a broker session");
  t.after(() => {
    try {
      process.kill(session.pid);
    } catch {
      // Already exited.
    }
  });

  assert.equal(modeOf(session.sessionDir), 0o700, "broker session dir must be 0700");
  assert.equal(modeOf(path.join(session.sessionDir, "broker.owner")), 0o600, "ownership marker must be 0600");
  assert.equal(modeOf(session.logFile), 0o600, "broker log must be 0600");
  assert.equal(
    modeOf(path.join(resolveStateDir(cwd), "broker-sessions.json")),
    0o600,
    "broker registry must be 0600"
  );
  assert.equal(modeOf(path.join(resolveStateDir(cwd), "broker.json")), 0o600, "broker session state must be 0600");
  assert.ok(loadBrokerSession(cwd), "session state must load");
});
