import path from "node:path";

const MODEL_OUTCOMES = new Set([
  "READY_FOR_INTEGRATION",
  "COMPLETED_READ_ONLY",
  "BLOCKED",
  "NEEDS_CONTEXT",
  "PARTIAL",
  "FAILED"
]);

const TOP_LEVEL_KEYS = [
  "blocker",
  "changedFiles",
  "checks",
  "evidence",
  "inspected",
  "outcomeStatus",
  "report",
  "schemaVersion"
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function isUniqueStringList(value, { nonempty = false } = {}) {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && (!nonempty || entry.length > 0)) &&
    new Set(value).size === value.length;
}

function isSafeWorkspaceRelativePath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) return false;
  const portable = value.replaceAll("\\", "/");
  return portable === path.posix.normalize(portable) &&
    portable !== ".." &&
    !portable.startsWith("../") &&
    !portable.includes("/../");
}

function validateTaskEnvelope(value) {
  if (!hasExactKeys(value, TOP_LEVEL_KEYS)) return "invalid top-level fields";
  if (value.schemaVersion !== 1 || !MODEL_OUTCOMES.has(value.outcomeStatus)) return "invalid schema version or outcome";
  if (typeof value.report !== "string" || value.report.length === 0) return "invalid report";
  if (!isUniqueStringList(value.changedFiles, { nonempty: true })) return "invalid changedFiles";
  if (!value.changedFiles.every(isSafeWorkspaceRelativePath)) return "unsafe changedFiles path";
  if (!isUniqueStringList(value.evidence, { nonempty: true })) return "invalid evidence";
  if (typeof value.inspected !== "boolean") return "invalid inspected flag";
  if (!Array.isArray(value.checks) || !value.checks.every((check) =>
    hasExactKeys(check, ["command", "status", "summary"]) &&
    typeof check.command === "string" &&
    ["PASS", "FAIL", "EXPECTED_FAIL", "SKIPPED"].includes(check.status) &&
    typeof check.summary === "string"
  )) return "invalid checks";
  if (value.checks.some((check) =>
    check.status === "EXPECTED_FAIL" && !check.summary.trim()
  )) return "EXPECTED_FAIL checks require a justification summary";
  if (value.blocker !== null && !(
    hasExactKeys(value.blocker, ["kind", "message", "retryWhen"]) &&
    typeof value.blocker.kind === "string" && value.blocker.kind.length > 0 &&
    typeof value.blocker.message === "string" && value.blocker.message.length > 0 &&
    (value.blocker.retryWhen === null || typeof value.blocker.retryWhen === "string")
  )) return "invalid blocker";
  return null;
}

function unclassified(rawOutput, message) {
  return {
    schemaVersion: 1,
    outcomeStatus: "UNCLASSIFIED",
    success: false,
    retryable: false,
    report: rawOutput || "Codex returned no usable final report.",
    rawOutput,
    changedFiles: [],
    checks: [],
    blocker: null,
    inspected: false,
    evidence: [],
    unattributedDriftFiles: [],
    protocolError: message
  };
}

export function parseTaskOutcome(rawOutput, context = {}) {
  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return unclassified(rawOutput, "Codex task output was not valid JSON.");
  }
  const shapeError = validateTaskEnvelope(parsed);
  if (shapeError) return unclassified(rawOutput, `Codex task output failed local schema validation: ${shapeError}.`);
  if (!parsed.report.trim()) return unclassified(rawOutput, "Codex task output omitted its report.");
  if (parsed.outcomeStatus === "READY_FOR_INTEGRATION" && context.intent !== "write") {
    return unclassified(rawOutput, "READY_FOR_INTEGRATION requires write intent.");
  }
  if (parsed.outcomeStatus === "COMPLETED_READ_ONLY") {
    if (context.intent !== "read-only" || parsed.inspected !== true || parsed.evidence.length === 0) {
      return unclassified(rawOutput, "COMPLETED_READ_ONLY requires read-only intent and inspection evidence.");
    }
  }
  if (context.intent === "read-only" && parsed.changedFiles.length > 0) {
    return unclassified(rawOutput, "Read-only output reported changed files.");
  }
  if ((parsed.outcomeStatus === "BLOCKED" || parsed.outcomeStatus === "NEEDS_CONTEXT") && !parsed.blocker) {
    return unclassified(rawOutput, `${parsed.outcomeStatus} requires blocker details.`);
  }
  if (
    (parsed.outcomeStatus === "READY_FOR_INTEGRATION" || parsed.outcomeStatus === "COMPLETED_READ_ONLY") &&
    parsed.checks.some((check) => check?.status === "FAIL")
  ) {
    return unclassified(rawOutput, `${parsed.outcomeStatus} cannot contain failed checks.`);
  }

  const reported = new Set(parsed.changedFiles);
  const events = new Set(context.eventTouchedFiles ?? []);
  const snapshot = new Set(context.snapshotChangedFiles ?? []);

  const eventTouchedButUnreported = [...events].filter((file) => !reported.has(file));
  if (eventTouchedButUnreported.length > 0) {
    return unclassified(rawOutput, `Observed but unreported file changes: ${eventTouchedButUnreported.join(", ")}.`);
  }
  const reportedButUncorroborated = [...reported].filter(
    (file) => !events.has(file) && !snapshot.has(file)
  );
  if (context.exactWorkspaceEvidence && reportedButUncorroborated.length > 0) {
    return unclassified(rawOutput, `Reported file changes were not present: ${reportedButUncorroborated.join(", ")}.`);
  }
  const unattributedDriftFiles = [...snapshot]
    .filter((file) => !reported.has(file) && !events.has(file))
    .sort();
  const consistencyWarnings = [
    ...reportedButUncorroborated.map((file) =>
      `Reported change could not be corroborated because exact workspace evidence is unavailable: ${file}`),
    ...unattributedDriftFiles.map((file) =>
      `Workspace drift not attributed to this task: ${file}`)
  ];
  return {
    ...parsed,
    success: parsed.outcomeStatus === "READY_FOR_INTEGRATION" || parsed.outcomeStatus === "COMPLETED_READ_ONLY",
    retryable: parsed.outcomeStatus === "BLOCKED" || parsed.outcomeStatus === "NEEDS_CONTEXT",
    rawOutput,
    protocolError: null,
    consistencyWarnings,
    unattributedDriftFiles
  };
}

export function buildInfrastructureOutcome(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    schemaVersion: 1,
    outcomeStatus: "INFRA_FAILED",
    success: false,
    retryable: true,
    report: message,
    rawOutput: "",
    changedFiles: [],
    checks: [],
    blocker: { kind: "infrastructure", message, retryWhen: "The runtime capability is restored" },
    inspected: false,
    evidence: [],
    unattributedDriftFiles: [],
    protocolError: null,
    consistencyWarnings: []
  };
}

export function renderTaskOutcome(outcome) {
  const lines = [`Outcome: ${outcome.outcomeStatus}`, "", outcome.report.trim()];
  if (outcome.protocolError) lines.push("", `Protocol error: ${outcome.protocolError}`);
  if (outcome.consistencyWarnings?.length) {
    lines.push("", "Evidence warnings:", ...outcome.consistencyWarnings.map((item) => `- ${item}`));
  }
  return `${lines.join("\n")}\n`;
}
