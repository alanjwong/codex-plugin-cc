import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  runCommand,
  runCommandChecked,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";

function writeSigtermHelper(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-process-signal-"));
  const helper = path.join(directory, "sigterm.mjs");
  writeFileSync(
    helper,
    'process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000);\n',
    "utf8"
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return helper;
}

test("runCommand preserves signal termination", (t) => {
  const helper = writeSigtermHelper(t);
  const result = runCommand(process.execPath, [helper]);

  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGTERM");
});

test("runCommandChecked rejects signal termination", (t) => {
  const helper = writeSigtermHelper(t);

  assert.throws(
    () => runCommandChecked(process.execPath, [helper]),
    /signal=SIGTERM/
  );
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
