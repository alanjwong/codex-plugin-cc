import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  buildStaticPreflight,
  captureWorkspaceSnapshot,
  changedFilesBetween
} from "../plugins/codex/scripts/lib/preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function buildEnv(binDir) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CLAUDE_PLUGIN_DATA: makeTempDir("codex-plugin-data-")
  };
}

function makeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "fixture"], { cwd: repo });
  return repo;
}

test("task --help prints task help without starting Codex", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--help"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /task --read-only\|--write/);
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), false);
});

test("-- keeps dash-prefixed prompt text out of option parsing", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const result = run("node", [SCRIPT, "task", "--read-only", "--", "--help"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /task --read-only\|--write/);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "--help");
});

test("task requires exactly one explicit intent", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const omitted = run("node", [SCRIPT, "task", "inspect the repo"], { cwd: repo, env });
  assert.equal(omitted.status, 1);
  assert.match(omitted.stderr, /Choose exactly one of --read-only or --write/);

  const conflicting = run(
    "node",
    [SCRIPT, "task", "--read-only", "--write", "inspect the repo"],
    { cwd: repo, env }
  );
  assert.equal(conflicting.status, 1);
  assert.match(conflicting.stderr, /Choose exactly one of --read-only or --write/);
});

test("task rejects unknown flags instead of forwarding them as prompt text", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--read-only", "--bogus", "inspect"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --bogus/);
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), false);
});

test("task rejects missing required commands and artifacts before turn start", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const missingCommand = run(
    "node",
    [SCRIPT, "task", "--read-only", "--require-command", "definitely-not-installed", "inspect"],
    { cwd: repo, env }
  );
  assert.equal(missingCommand.status, 1);
  assert.match(missingCommand.stderr, /Required command not found: definitely-not-installed/);

  const missingArtifact = run(
    "node",
    [SCRIPT, "task", "--read-only", "--require-artifact", "missing-plan.md", "inspect"],
    { cwd: repo, env }
  );
  assert.equal(missingArtifact.status, 1);
  assert.match(missingArtifact.stderr, /Required artifact not found: missing-plan.md/);
});

test("task stops before turn start when effective sandbox mismatches intent", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "wrong-sandbox");

  const result = run("node", [SCRIPT, "task", "--write", "make a safe edit"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Runtime sandbox mismatch/);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.lastTurnStart ?? null, null);
});

test("task stops before turn start when a write sandbox attestation is absent", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "missing-sandbox");

  const result = run("node", [SCRIPT, "task", "--write", "make a safe edit"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Runtime sandbox mismatch/);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.lastTurnStart ?? null, null);
});

test("Git snapshot capture reports maxBuffer failures instead of accepting truncated output", () => {
  const repo = makeRepo();
  assert.throws(
    () => captureWorkspaceSnapshot(repo, { gitMaxBuffer: 1 }),
    /Could not capture the Git workspace baseline/
  );
});

test("workspace fingerprints detect content changes to already-dirty and untracked files", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "dirty one\n", "utf8");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "one\n", "utf8");
  const before = buildStaticPreflight({ cwd: repo, intent: "write" });

  fs.writeFileSync(path.join(repo, "README.md"), "dirty two\n", "utf8");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "two\n", "utf8");
  const after = buildStaticPreflight({ cwd: repo, intent: "write" });

  assert.notEqual(after.git.dirtyFingerprint, before.git.dirtyFingerprint);
  assert.deepEqual(changedFilesBetween(before, after), ["README.md", "untracked.txt"]);

  run("git", ["add", "README.md", "untracked.txt"], { cwd: repo });
  run("git", ["commit", "-m", "task commit"], { cwd: repo });
  const committed = buildStaticPreflight({ cwd: repo, intent: "write" });
  assert.deepEqual(changedFilesBetween(after, committed), ["README.md", "untracked.txt"]);
});

test("workspace fingerprints support unborn HEAD and preserve index versus worktree state", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "first.txt"), "staged\n", "utf8");
  run("git", ["add", "first.txt"], { cwd: repo });
  const staged = buildStaticPreflight({ cwd: repo, intent: "write" });
  assert.equal(staged.git.head, null);

  fs.writeFileSync(path.join(repo, "first.txt"), "worktree\n", "utf8");
  const mixed = buildStaticPreflight({ cwd: repo, intent: "write" });
  assert.notEqual(mixed.git.dirtyFingerprint, staged.git.dirtyFingerprint);
  assert.deepEqual(changedFilesBetween(staged, mixed), ["first.txt"]);

  run("git", ["add", "first.txt"], { cwd: repo });
  const restaged = buildStaticPreflight({ cwd: repo, intent: "write" });
  assert.notEqual(restaged.git.dirtyFingerprint, mixed.git.dirtyFingerprint);
  assert.deepEqual(changedFilesBetween(mixed, restaged), ["first.txt"]);
});

test("changedFilesBetween includes clean commits and the first commit", () => {
  const repo = makeRepo();
  const before = buildStaticPreflight({ cwd: repo, intent: "write" });
  fs.writeFileSync(path.join(repo, "committed.txt"), "committed\n", "utf8");
  run("git", ["add", "committed.txt"], { cwd: repo });
  run("git", ["commit", "-m", "clean task commit"], { cwd: repo });
  const after = buildStaticPreflight({ cwd: repo, intent: "write" });
  assert.deepEqual(changedFilesBetween(before, after), ["committed.txt"]);

  const unborn = makeTempDir();
  initGitRepo(unborn);
  const empty = buildStaticPreflight({ cwd: unborn, intent: "write" });
  fs.writeFileSync(path.join(unborn, "first.txt"), "first\n", "utf8");
  run("git", ["add", "first.txt"], { cwd: unborn });
  run("git", ["commit", "-m", "first commit"], { cwd: unborn });
  const firstCommit = buildStaticPreflight({ cwd: unborn, intent: "write" });
  assert.deepEqual(changedFilesBetween(empty, firstCommit), ["first.txt"]);

  fs.writeFileSync(path.join(unborn, "second.txt"), "second\n", "utf8");
  run("git", ["add", "second.txt"], { cwd: unborn });
  run("git", ["commit", "-m", "second commit"], { cwd: unborn });
  const secondCommit = buildStaticPreflight({ cwd: unborn, intent: "write" });
  assert.deepEqual(changedFilesBetween(empty, secondCommit), ["first.txt", "second.txt"]);
});

test("workspace fingerprints attribute moved and dirty submodules", () => {
  const origin = makeRepo();
  const parent = makeRepo();
  run("git", [
    "-c", "protocol.file.allow=always",
    "submodule", "add", origin, "vendor/sub"
  ], { cwd: parent });
  run("git", ["commit", "-am", "add submodule"], { cwd: parent });
  const before = buildStaticPreflight({ cwd: parent, intent: "write" });

  fs.writeFileSync(path.join(origin, "second.txt"), "second\n", "utf8");
  run("git", ["add", "second.txt"], { cwd: origin });
  run("git", ["commit", "-m", "advance submodule"], { cwd: origin });
  const nextHead = run("git", ["rev-parse", "HEAD"], { cwd: origin }).stdout.trim();
  const submodule = path.join(parent, "vendor", "sub");
  run("git", ["-c", "protocol.file.allow=always", "fetch", "origin"], { cwd: submodule });
  run("git", ["checkout", nextHead], { cwd: submodule });
  const moved = buildStaticPreflight({ cwd: parent, intent: "write" });
  assert.deepEqual(changedFilesBetween(before, moved), ["vendor/sub"]);

  fs.writeFileSync(path.join(submodule, "README.md"), "nested dirty\n", "utf8");
  const nestedDirty = buildStaticPreflight({ cwd: parent, intent: "write" });
  assert.deepEqual(changedFilesBetween(moved, nestedDirty), ["vendor/sub"]);

  run("git", ["reset", "--hard"], { cwd: submodule });
  run("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--force", "vendor/sub"], {
    cwd: parent
  });
  run("git", ["submodule", "deinit", "-f", "vendor/sub"], { cwd: parent });
  const deinitialized = buildStaticPreflight({ cwd: parent, intent: "write" });
  assert.equal(deinitialized.git.exact, false);

  fs.rmSync(path.join(parent, "vendor", "sub"), { recursive: true, force: true });
  const absent = buildStaticPreflight({ cwd: parent, intent: "write" });
  assert.equal(absent.git.exact, false);
});

test("native review keeps its tailored focus-text redirect instead of a parser error", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "review", "check the --retry-flag handling"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /adversarial-review/);
  assert.doesNotMatch(result.stderr, /Unknown option/);
});

test("adversarial-review preserves option-like focus text verbatim", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n", "utf8");
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run(
    "node",
    [SCRIPT, "adversarial-review", "check the --retry-flag handling"],
    { cwd: repo, env: buildEnv(binDir) }
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /check the --retry-flag handling/);
});

test("a machine without git degrades to a non-Git workspace instead of failing preflight", () => {
  const dir = makeTempDir();
  const probe = run(
    "node",
    [
      "--input-type=module",
      "-e",
      "import { buildStaticPreflight } from './plugins/codex/scripts/lib/preflight.mjs'; const p = buildStaticPreflight({ cwd: process.argv[1], intent: 'write' }); console.log(JSON.stringify({ git: p.git }));",
      dir
    ],
    { cwd: ROOT, env: { ...process.env, PATH: path.dirname(process.execPath) } }
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(JSON.parse(probe.stdout).git, null);
});
