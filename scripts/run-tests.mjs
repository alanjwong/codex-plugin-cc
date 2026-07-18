#!/usr/bin/env node
// Cross-platform test runner. Replaces the old `posttest` shell sweep, which
// scanned the whole process table with pkill patterns (unescaped $PWD, shared
// codex-plugin-test-* naming) and could terminate unrelated processes.
//
// Strategy: run the suite inside a fresh per-run private temp root, then
// terminate only processes this run demonstrably launched — pids recorded in
// state files under the run root whose launch identity (pid + start time +
// argv token) still verifies — and finally delete the run root.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateProcessTreeVerified } from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_WALK_DEPTH = 10;

function walkFiles(dir, depth, visit) {
  if (depth > MAX_WALK_DEPTH) {
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, depth + 1, visit);
    } else if (entry.isFile()) {
      visit(entryPath, entry.name);
    }
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function buildChildEnv(parentEnv, runRoot) {
  const env = {
    ...parentEnv,
    TMPDIR: runRoot,
    TEMP: runRoot,
    TMP: runRoot,
    CLAUDE_PLUGIN_DATA: path.join(runRoot, "plugin-data")
  };
  delete env.CODEX_COMPANION_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  delete env.CODEX_COMPANION_APP_SERVER_PID_FILE;
  delete env.CODEX_COMPANION_APP_SERVER_LOG_FILE;
  return env;
}

// Collects every launch identity recorded by this run: broker registry
// entries, broker session state, and per-job worker identities. Only files
// under the run root are consulted, so nothing outside this run can match.
export function collectRunOwnedIdentities(runRoot) {
  const identities = new Map();
  const add = (identity) => {
    if (identity && Number.isFinite(identity.pid) && Number.isFinite(identity.startedAt) && typeof identity.token === "string" && identity.token.length > 0) {
      identities.set(identity.pid, identity);
    }
  };
  walkFiles(runRoot, 0, (filePath, name) => {
    if (name === "broker-sessions.json") {
      const entries = readJson(filePath);
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          add({ pid: entry?.pid, startedAt: entry?.startedAt, token: entry?.token ?? null });
        }
      }
      return;
    }
    if (name === "broker.json") {
      const session = readJson(filePath);
      add(session?.identity ?? null);
      return;
    }
    if (name.endsWith(".json")) {
      const record = readJson(filePath);
      add(record?.workerIdentity ?? null);
    }
  });
  return [...identities.values()];
}

export function sweepRunOwnedProcesses(runRoot) {
  const results = [];
  for (const identity of collectRunOwnedIdentities(runRoot)) {
    // terminateProcessTreeVerified re-verifies pid + start time + token
    // immediately before signaling, so a recycled pid is never touched.
    const termination = terminateProcessTreeVerified(identity);
    results.push({ pid: identity.pid, ...termination });
  }
  return results;
}

async function main() {
  // macOS's default tmpdir is ~45 chars; nesting a run root under it pushes
  // unix-socket paths past the 104-char sun_path limit. Use the short /tmp
  // alias there (the run root itself is chmod 0700, so it stays private).
  const tmpBase = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const runRoot = fs.mkdtempSync(path.join(tmpBase, "cxc-testrun-"));
  try {
    fs.chmodSync(runRoot, 0o700);
  } catch {
    // mkdtemp already restricts to the creating user on POSIX.
  }
  const runRootStat = fs.lstatSync(runRoot);
  const defaultTestFiles = fs
    .readdirSync(path.join(ROOT, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join("tests", name));
  const testArgs = process.argv.length > 2 ? process.argv.slice(2) : ["--test", ...defaultTestFiles];

  const child = spawn(process.execPath, testArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env: buildChildEnv(process.env, runRoot)
  });

  const code = await new Promise((resolve) => {
    child.on("exit", (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
    child.on("error", () => resolve(1));
  });

  const swept = sweepRunOwnedProcesses(runRoot);
  const delivered = swept.filter((entry) => entry.delivered).length;
  if (delivered > 0) {
    process.stderr.write(`run-tests: terminated ${delivered} verified run-owned process(es).\n`);
  }
  try {
    const confirm = fs.lstatSync(runRoot);
    if (confirm.dev === runRootStat.dev && confirm.ino === runRootStat.ino && confirm.isDirectory()) {
      fs.rmSync(runRoot, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup of our own run root.
  }
  process.exit(code);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main();
}
