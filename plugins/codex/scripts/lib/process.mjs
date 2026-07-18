import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) throw result.error;
  if (result.signal) throw new Error(formatCommandFailure(result));
  if (result.status !== 0) throw new Error(formatCommandFailure(result));
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

// pid + start time uniquely identifies a process for the lifetime of a boot;
// the optional launch token (embedded in the child's argv at spawn) adds a
// second, random factor. Identity is captured at spawn and re-verified
// immediately before any signal so a recycled pid can never be terminated.
const START_TIME_TOLERANCE_MS = 1500;

function extractLaunchToken(commandLine) {
  const parts = String(commandLine).split(/\s+/);
  const idx = parts.indexOf("--launch-token");
  return idx >= 0 && idx + 1 < parts.length ? parts[idx + 1] : null;
}

export function getProcessStartTimeMs(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  if (platform === "win32") {
    const result = runCommandImpl(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CreationDate.ToUniversalTime().ToString('o')`
      ],
      { shell: false }
    );
    if (result.error || result.status !== 0) {
      return null;
    }
    const parsed = Date.parse(result.stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  const result = runCommandImpl("ps", ["-p", String(Math.trunc(pid)), "-o", "lstart="], {
    env: { ...process.env, LC_ALL: "C" }
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const text = result.stdout.trim();
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getProcessCommandLine(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  if (platform === "win32") {
    const result = runCommandImpl(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`
      ],
      { shell: false }
    );
    if (result.error || result.status !== 0) {
      return null;
    }
    return result.stdout.trim() || null;
  }
  const result = runCommandImpl("ps", ["-p", String(Math.trunc(pid)), "-o", "command="], {
    env: { ...process.env, LC_ALL: "C" }
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

export function captureProcessIdentity(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return null;
  }
  return {
    pid: Math.trunc(pid),
    startedAt: getProcessStartTimeMs(pid, options),
    command: getProcessCommandLine(pid, options),
    capturedAt: new Date().toISOString()
  };
}

export function verifyProcessIdentity(identity, options = {}) {
  if (!identity || !Number.isFinite(identity.pid)) {
    return { verified: false, reason: "missing-identity" };
  }
  if (!Number.isFinite(identity.startedAt)) {
    // The identity was recorded without a start time (or comes from a legacy
    // record): refuse to verify rather than guess.
    return { verified: false, reason: "unverifiable-identity" };
  }
  const currentStart = getProcessStartTimeMs(identity.pid, options);
  if (currentStart === null) {
    return { verified: false, reason: "not-running" };
  }
  const tolerance = options.toleranceMs ?? START_TIME_TOLERANCE_MS;
  if (Math.abs(currentStart - identity.startedAt) > tolerance) {
    return { verified: false, reason: "start-time-mismatch" };
  }
  if (identity.token) {
    const command = getProcessCommandLine(identity.pid, options);
    if (command === null) {
      return { verified: false, reason: "argv-unreadable" };
    }
    if (extractLaunchToken(command) !== identity.token) {
      return { verified: false, reason: "token-mismatch" };
    }
  }
  return { verified: true, reason: null };
}

export function terminateProcessTreeVerified(identity, options = {}) {
  const verification = verifyProcessIdentity(identity, options);
  if (!verification.verified) {
    return { attempted: false, delivered: false, method: null, verified: false, reason: verification.reason };
  }
  if (!(typeof identity.token === "string" && identity.token.length > 0)) {
    return { attempted: false, delivered: false, method: null, verified: false, reason: "no-token" };
  }
  const result = terminateProcessTree(identity.pid, options);
  return { ...result, verified: true, reason: null };
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
