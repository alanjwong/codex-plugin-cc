import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function realpath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function runGit(args, { cwd, maxBuffer = GIT_MAX_BUFFER } = {}) {
  return runCommand("git", args, { cwd, maxBuffer });
}

function commandExists(command, env = process.env) {
  const bareCandidates = path.isAbsolute(command)
    ? [command]
    : String(env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.join(entry, command));
  const extensions = process.platform === "win32"
    ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [];
  const candidates = bareCandidates.flatMap((candidate) => [
    candidate,
    ...extensions.map((extension) => `${candidate}${extension}`)
  ]);
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function readGitSnapshot(cwd, visitedRoots = new Set(), gitMaxBuffer = GIT_MAX_BUFFER) {
  const root = runGit(["rev-parse", "--show-toplevel"], { cwd, maxBuffer: gitMaxBuffer });
  if (root.error?.code === "ENOENT") return null;
  if (root.error) throw new Error("Could not capture the Git workspace baseline.");
  if (root.status !== 0) return null;
  const repoRoot = root.stdout.trim();
  const canonicalRepoRoot = realpath(repoRoot);
  if (visitedRoots.has(canonicalRepoRoot)) {
    throw new Error(`Recursive Git worktree detected at ${canonicalRepoRoot}.`);
  }
  const nextVisitedRoots = new Set(visitedRoots);
  nextVisitedRoots.add(canonicalRepoRoot);
  const branch = runGit(["branch", "--show-current"], { cwd: repoRoot, maxBuffer: gitMaxBuffer });
  const headResult = runGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: repoRoot,
    maxBuffer: gitMaxBuffer
  });
  if (headResult.error || ![0, 1].includes(headResult.status)) {
    throw new Error("Could not resolve the Git HEAD baseline.");
  }
  const head = headResult.status === 0 ? headResult.stdout.trim() : null;
  const stagedBase = head ? [head] : [];
  const stagedPaths = runGit(
    ["diff", "--cached", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", ...stagedBase],
    { cwd: repoRoot, maxBuffer: gitMaxBuffer }
  );
  const unstagedPaths = runGit(
    ["diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z"],
    { cwd: repoRoot, maxBuffer: gitMaxBuffer }
  );
  const untrackedPaths = runGit(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot, maxBuffer: gitMaxBuffer }
  );
  const indexState = runGit(["ls-files", "--stage", "-z"], { cwd: repoRoot, maxBuffer: gitMaxBuffer });
  const stagedDiff = runGit(
    ["diff", "--cached", "--binary", "--no-ext-diff", "--no-renames", "--ignore-submodules=none", ...stagedBase],
    { cwd: repoRoot, maxBuffer: gitMaxBuffer }
  );
  const unstagedDiff = runGit(
    ["diff", "--binary", "--no-ext-diff", "--no-renames", "--ignore-submodules=none"],
    { cwd: repoRoot, maxBuffer: gitMaxBuffer }
  );
  if (
    branch.error || branch.status !== 0 ||
    stagedPaths.error || stagedPaths.status !== 0 ||
    unstagedPaths.error || unstagedPaths.status !== 0 ||
    untrackedPaths.error || untrackedPaths.status !== 0 ||
    indexState.error || indexState.status !== 0 ||
    stagedDiff.error || stagedDiff.status !== 0 ||
    unstagedDiff.error || unstagedDiff.status !== 0
  ) {
    throw new Error("Could not capture the Git workspace baseline.");
  }
  const dirtyPaths = [...new Set(
    `${stagedPaths.stdout}\0${unstagedPaths.stdout}\0${untrackedPaths.stdout}`
      .split("\0")
      .filter(Boolean)
  )].sort();
  const indexEntriesByPath = new Map();
  for (const record of indexState.stdout.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab === -1) throw new Error("Git returned a malformed index entry.");
    const [mode, objectId, stage] = record.slice(0, tab).split(" ");
    const relativePath = record.slice(tab + 1);
    const entries = indexEntriesByPath.get(relativePath) ?? [];
    entries.push({ mode, objectId, stage });
    indexEntriesByPath.set(relativePath, entries);
  }
  const gitlinkRoots = new Map();
  for (const [relativePath, entries] of indexEntriesByPath) {
    if (!entries.some((entry) => entry.mode === "160000")) continue;
    const absolutePath = path.resolve(repoRoot, relativePath);
    const nestedRoot = runGit(["rev-parse", "--show-toplevel"], {
      cwd: absolutePath,
      maxBuffer: gitMaxBuffer
    });
    const canonicalNestedRoot = !nestedRoot.error && nestedRoot.status === 0
      ? realpath(nestedRoot.stdout.trim())
      : null;
    gitlinkRoots.set(
      relativePath,
      canonicalNestedRoot === realpath(absolutePath) ? canonicalNestedRoot : null
    );
  }
  const fileStates = Object.fromEntries(dirtyPaths.map((relativePath) => {
    const absolutePath = path.resolve(repoRoot, relativePath);
    const relative = path.relative(repoRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Git reported a path outside the workspace: ${relativePath}`);
    }
    try {
      const stat = fs.lstatSync(absolutePath);
      const indexEntries = indexEntriesByPath.get(relativePath) ?? [];
      const isGitlink = indexEntries.some((entry) => entry.mode === "160000");
      let worktreeFingerprint;
      let nested = null;
      if (stat.isDirectory() && isGitlink) {
        nested = gitlinkRoots.get(relativePath)
          ? readGitSnapshot(absolutePath, nextVisitedRoots, gitMaxBuffer)
          : null;
        worktreeFingerprint = sha256(JSON.stringify(nested == null
          ? { unavailable: true }
          : {
              root: nested.root,
              branch: nested.branch,
              head: nested.head,
              dirtyFingerprint: nested.dirtyFingerprint,
              exact: nested.exact
            }));
      } else {
        worktreeFingerprint = sha256(Buffer.concat([
          Buffer.from(`${stat.mode}:${stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : "other"}:`),
          stat.isSymbolicLink()
            ? Buffer.from(fs.readlinkSync(absolutePath))
            : stat.isFile()
              ? fs.readFileSync(absolutePath)
              : Buffer.from("directory")
        ]));
      }
      return [relativePath, {
        indexEntries,
        worktreeFingerprint,
        exact:
          !isGitlink ||
          (gitlinkRoots.get(relativePath) != null && nested != null && nested.exact !== false)
      }];
    } catch (error) {
      const indexEntries = indexEntriesByPath.get(relativePath) ?? [];
      const isGitlink = indexEntries.some((entry) => entry.mode === "160000");
      if (error?.code === "ENOENT") return [relativePath, {
        indexEntries,
        worktreeFingerprint: "missing",
        exact: !isGitlink
      }];
      throw error;
    }
  }));
  return {
    root: canonicalRepoRoot,
    branch: branch.stdout.trim() || "HEAD",
    head,
    dirtyFingerprint: sha256(JSON.stringify({
      stagedDiff: sha256(stagedDiff.stdout),
      unstagedDiff: sha256(unstagedDiff.stdout),
      fileStates
    })),
    fileStates,
    exact:
      [...gitlinkRoots.values()].every((value) => value !== null) &&
      Object.values(fileStates).every((state) => state.exact !== false)
  };
}

export function changedFilesBetween(before, after) {
  if (!before?.git || !after?.git || before.git.root !== after.git.root) return [];
  const beforeStates = before.git.fileStates ?? {};
  const afterStates = after.git.fileStates ?? {};
  let committedPaths = [];
  if (before.git.head !== after.git.head) {
    const committed = before.git.head && after.git.head
      ? runGit(
          ["diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", before.git.head, after.git.head],
          { cwd: after.git.root, maxBuffer: GIT_MAX_BUFFER }
        )
      : after.git.head
        ? runGit(
            ["ls-tree", "-r", "--name-only", "-z", after.git.head],
            { cwd: after.git.root, maxBuffer: GIT_MAX_BUFFER }
          )
        : { status: 0, stdout: "" };
    if (committed.error || committed.status !== 0) {
      throw new Error("Could not compare task start and completion commits.");
    }
    committedPaths = committed.stdout.split("\0").filter(Boolean);
  }
  const committedSet = new Set(committedPaths);
  const paths = new Set([
    ...committedPaths,
    ...Object.keys(beforeStates),
    ...Object.keys(afterStates)
  ]);
  return [...paths]
    .filter((file) =>
      committedSet.has(file) ||
      JSON.stringify(beforeStates[file] ?? null) !==
        JSON.stringify(afterStates[file] ?? null)
    )
    .sort();
}

export function normalizeTaskIntent(options) {
  const readOnly = Boolean(options["read-only"]);
  const write = Boolean(options.write);
  if (readOnly === write) {
    throw new Error("Choose exactly one of --read-only or --write.");
  }
  return write ? "write" : "read-only";
}

export function captureWorkspaceSnapshot(cwd, options = {}) {
  const resolvedCwd = path.resolve(cwd);
  const workspaceRoot = resolveWorkspaceRoot(resolvedCwd);
  return {
    cwd: realpath(resolvedCwd),
    workspaceRoot,
    workspaceRealpath: realpath(workspaceRoot),
    git: readGitSnapshot(resolvedCwd, new Set(), options.gitMaxBuffer ?? GIT_MAX_BUFFER)
  };
}

export function buildStaticPreflight(request) {
  const cwd = path.resolve(request.cwd);
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);

  const captured = captureWorkspaceSnapshot(cwd);
  const { workspaceRoot, workspaceRealpath, git } = captured;
  if (request.expectedBranch && git?.branch !== request.expectedBranch) {
    throw new Error(`Expected branch ${request.expectedBranch}, found ${git?.branch ?? "non-Git workspace"}.`);
  }
  if (request.expectedHead && git?.head !== request.expectedHead) {
    throw new Error(`Expected HEAD ${request.expectedHead}, found ${git?.head ?? "non-Git workspace"}.`);
  }
  if (request.intent === "write") {
    fs.accessSync(workspaceRealpath, fs.constants.W_OK);
  }

  const requiredCommands = [...new Set(request.requiredCommands ?? [])];
  for (const command of requiredCommands) {
    if (!commandExists(command, request.env)) {
      throw new Error(`Required command not found: ${command}`);
    }
  }
  const requiredArtifacts = [...new Set(request.requiredArtifacts ?? [])];
  for (const artifact of requiredArtifacts) {
    const absolute = path.resolve(workspaceRealpath, artifact);
    const relative = path.relative(workspaceRealpath, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Required artifact escapes the workspace: ${artifact}`);
    }
    if (!fs.existsSync(absolute)) throw new Error(`Required artifact not found: ${artifact}`);
  }

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    cwd: realpath(cwd),
    workspaceRoot,
    workspaceRealpath,
    intent: request.intent,
    requested: {
      model: request.model ?? null,
      effort: request.effort ?? null,
      sandbox: request.intent === "write" ? "workspace-write" : "read-only"
    },
    git,
    requiredCommands,
    requiredArtifacts
  };
}

export function normalizeEffectiveSandbox(value) {
  const type = typeof value === "string" ? value : value?.type;
  return {
    readOnly: "read-only",
    workspaceWrite: "workspace-write",
    dangerFullAccess: "danger-full-access"
  }[type] ?? type ?? null;
}

export function assertRuntimeAttestation(preflight, effective) {
  const effectiveCwd = realpath(effective.cwd);
  if (effectiveCwd !== preflight.workspaceRealpath) {
    throw new Error(`Runtime workspace mismatch: expected ${preflight.workspaceRealpath}, found ${effectiveCwd}.`);
  }
  const sandbox = normalizeEffectiveSandbox(effective.sandbox);
  if (sandbox !== preflight.requested.sandbox) {
    throw new Error(`Runtime sandbox mismatch: expected ${preflight.requested.sandbox}, found ${sandbox}.`);
  }
  if (preflight.requested.model && effective.model && effective.model !== preflight.requested.model) {
    throw new Error(`Runtime model mismatch: expected ${preflight.requested.model}, found ${effective.model}.`);
  }
}
