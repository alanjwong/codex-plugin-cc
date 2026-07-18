import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import test from "node:test";

import {
  captureProcessIdentity,
  terminateProcessTreeVerified,
  verifyProcessIdentity
} from "../plugins/codex/scripts/lib/process.mjs";
import { waitForProcessExit } from "../plugins/codex/scripts/lib/job-reconciliation.mjs";

const onWindows = process.platform === "win32";

function spawnLongLivedChild(extraArgs = []) {
  // detached mirrors how production workers and brokers are launched (their
  // own process group), which is what tree termination targets.
  const args = ["-e", "setInterval(() => {}, 1000);"];
  if (extraArgs.length > 0) {
    args.push("--", ...extraArgs);
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

test("captured identity verifies against the live process", { skip: onWindows }, (t) => {
  const child = spawnLongLivedChild();
  t.after(() => killQuietly(child.pid));

  const identity = captureProcessIdentity(child.pid);
  assert.ok(identity, "identity must be captured");
  assert.equal(identity.pid, child.pid);
  assert.ok(Number.isFinite(identity.startedAt), "start time must be captured");

  const verification = verifyProcessIdentity(identity);
  assert.equal(verification.verified, true, verification.reason ?? "");
});

test("a start-time mismatch refuses to verify and never signals", { skip: onWindows }, async (t) => {
  const child = spawnLongLivedChild();
  t.after(() => killQuietly(child.pid));

  const identity = captureProcessIdentity(child.pid);
  const stale = { ...identity, startedAt: identity.startedAt - 60_000 };

  const verification = verifyProcessIdentity(stale);
  assert.equal(verification.verified, false);
  assert.equal(verification.reason, "start-time-mismatch");

  const termination = terminateProcessTreeVerified(stale);
  assert.equal(termination.attempted, false, "mismatched identity must not be signaled");
  assert.equal(termination.verified, false);

  const exited = await waitForProcessExit(child.pid, { timeoutMs: 300, pollMs: 50 });
  assert.equal(exited, false, "the unrelated process must still be alive");
});

test("missing identity never signals", () => {
  const termination = terminateProcessTreeVerified(null);
  assert.equal(termination.attempted, false);
  assert.equal(termination.reason, "missing-identity");

  const legacy = terminateProcessTreeVerified({ pid: process.pid, startedAt: null });
  assert.equal(legacy.attempted, false, "identity without a start time must not be signaled");
});

test("a launch token embedded in argv is part of the identity", { skip: onWindows }, (t) => {
  const token = "launch-token-fixture-0123456789abcdef";
  const child = spawnLongLivedChild(["--launch-token", token]);
  t.after(() => killQuietly(child.pid));

  const identity = { ...captureProcessIdentity(child.pid), token };
  const good = verifyProcessIdentity(identity);
  assert.equal(good.verified, true, good.reason ?? "");

  const impostor = { ...identity, token: "some-other-token-fedcba9876543210" };
  const bad = verifyProcessIdentity(impostor);
  assert.equal(bad.verified, false);
  assert.equal(bad.reason, "token-mismatch");
});

test("a fully verified identity terminates the intended process", { skip: onWindows }, async (t) => {
  const token = "termination-token-fixture-0123456789abcdef";
  const child = spawnLongLivedChild(["--launch-token", token]);
  t.after(() => killQuietly(child.pid));

  const identity = { ...captureProcessIdentity(child.pid), token };
  const termination = terminateProcessTreeVerified(identity);
  assert.equal(termination.verified, true);
  assert.equal(termination.attempted, true);

  const exited = await waitForProcessExit(child.pid, { timeoutMs: 3000, pollMs: 50 });
  assert.equal(exited, true, "the verified child must exit after termination");
});

test("a token-bearing identity fails closed when argv is unreadable", () => {
  const fixedLstart = "Mon Jul 14 12:34:56 2025";
  const identity = {
    pid: 42_001,
    startedAt: Date.parse(fixedLstart),
    token: "unreadable-argv-token-0123456789abcdef"
  };
  const options = {
    platform: "linux",
    runCommandImpl(_command, args) {
      if (args.at(-1) === "lstart=") {
        return { status: 0, stdout: `${fixedLstart}\n`, stderr: "", error: null };
      }
      return { status: 1, stdout: "", stderr: "argv unavailable", error: null };
    }
  };

  assert.deepEqual(verifyProcessIdentity(identity, options), {
    verified: false,
    reason: "argv-unreadable"
  });
});

test("a token substring outside --launch-token does not verify", () => {
  const fixedLstart = "Mon Jul 14 12:34:56 2025";
  const token = "substring-token-0123456789abcdef";
  const identity = {
    pid: 42_002,
    startedAt: Date.parse(fixedLstart),
    token
  };
  const options = {
    platform: "linux",
    runCommandImpl(_command, args) {
      if (args.at(-1) === "lstart=") {
        return { status: 0, stdout: `${fixedLstart}\n`, stderr: "", error: null };
      }
      return {
        status: 0,
        stdout: `node w --other=XX${token}YY\n`,
        stderr: "",
        error: null
      };
    }
  };

  assert.deepEqual(verifyProcessIdentity(identity, options), {
    verified: false,
    reason: "token-mismatch"
  });
});

test("tokenless verified identities are never signaled", () => {
  const fixedLstart = "Mon Jul 14 12:34:56 2025";
  let killCalls = 0;
  const identity = {
    pid: 42_003,
    startedAt: Date.parse(fixedLstart)
  };
  const options = {
    platform: "linux",
    runCommandImpl(_command, args) {
      assert.equal(args.at(-1), "lstart=");
      return { status: 0, stdout: `${fixedLstart}\n`, stderr: "", error: null };
    },
    killImpl() {
      killCalls += 1;
    }
  };

  assert.deepEqual(terminateProcessTreeVerified(identity, options), {
    attempted: false,
    delivered: false,
    method: null,
    verified: false,
    reason: "no-token"
  });
  assert.equal(killCalls, 0, "tokenless identities must not reach killImpl");
});
