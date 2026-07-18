import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInfrastructureOutcome,
  parseTaskOutcome,
  renderTaskOutcome
} from "../plugins/codex/scripts/lib/task-outcome.mjs";

function payload(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    outcomeStatus: "COMPLETED_READ_ONLY",
    report: "Inspected the target files. No findings.",
    changedFiles: [],
    checks: [],
    blocker: null,
    inspected: true,
    evidence: ["src/app.js:1"],
    ...overrides
  });
}

test("blocked output is a valid terminal result but not success", () => {
  const result = parseTaskOutcome(payload({
    outcomeStatus: "BLOCKED",
    report: "The required host is unavailable.",
    blocker: { kind: "runtime", message: "Host unavailable", retryWhen: "Host is installed" }
  }), { intent: "read-only" });
  assert.equal(result.outcomeStatus, "BLOCKED");
  assert.equal(result.success, false);
});

test("ready for integration requires write intent", () => {
  const result = parseTaskOutcome(payload({
    outcomeStatus: "READY_FOR_INTEGRATION",
    changedFiles: ["src/app.js"]
  }), { intent: "read-only" });
  assert.equal(result.outcomeStatus, "UNCLASSIFIED");
  assert.match(result.protocolError, /requires write intent/);
});

test("clean read-only completion requires inspection evidence", () => {
  const result = parseTaskOutcome(payload({ inspected: false, evidence: [] }), {
    intent: "read-only"
  });
  assert.equal(result.outcomeStatus, "UNCLASSIFIED");
  assert.match(result.protocolError, /inspection evidence/);
});

test("successful outcomes cannot contain failed checks", () => {
  const result = parseTaskOutcome(payload({
    checks: [{ command: "npm test", status: "FAIL", summary: "one failure" }]
  }), { intent: "read-only" });
  assert.equal(result.outcomeStatus, "UNCLASSIFIED");
  assert.match(result.protocolError, /failed checks/);
});

test("blocked and needs-context outcomes require a blocker", () => {
  for (const outcomeStatus of ["BLOCKED", "NEEDS_CONTEXT"]) {
    const result = parseTaskOutcome(payload({ outcomeStatus, blocker: null }), {
      intent: "read-only"
    });
    assert.equal(result.outcomeStatus, "UNCLASSIFIED");
    assert.match(result.protocolError, /requires blocker details/);
  }
});

test("event-attributed file changes must be reported even without exact snapshots", () => {
  const result = parseTaskOutcome(payload({
    outcomeStatus: "READY_FOR_INTEGRATION",
    changedFiles: []
  }), {
    intent: "write",
    eventTouchedFiles: ["src/app.js"],
    snapshotChangedFiles: [],
    exactWorkspaceEvidence: false
  });
  assert.equal(result.outcomeStatus, "UNCLASSIFIED");
  assert.match(result.protocolError, /Observed but unreported/);
});

test("reported changes must be corroborated when exact workspace evidence exists", () => {
  const result = parseTaskOutcome(payload({
    outcomeStatus: "READY_FOR_INTEGRATION",
    changedFiles: ["src/app.js"]
  }), {
    intent: "write",
    eventTouchedFiles: [],
    snapshotChangedFiles: [],
    exactWorkspaceEvidence: true
  });
  assert.equal(result.outcomeStatus, "UNCLASSIFIED");
  assert.match(result.protocolError, /not present/);
});

test("uncorroborated reports degrade to warnings without exact evidence", () => {
  const result = parseTaskOutcome(payload({
    outcomeStatus: "READY_FOR_INTEGRATION",
    changedFiles: ["output.txt"]
  }), {
    intent: "write",
    eventTouchedFiles: [],
    snapshotChangedFiles: [],
    exactWorkspaceEvidence: false
  });
  assert.equal(result.outcomeStatus, "READY_FOR_INTEGRATION");
  assert.equal(result.success, true);
  assert.equal(result.protocolError, null);
  assert.match(result.consistencyWarnings.join("\n"), /could not be corroborated/);
});

test("a reported path corroborated by events carries no warning", () => {
  const result = parseTaskOutcome(payload({
    outcomeStatus: "READY_FOR_INTEGRATION",
    changedFiles: ["src/app.js"]
  }), {
    intent: "write",
    eventTouchedFiles: ["src/app.js"],
    snapshotChangedFiles: [],
    exactWorkspaceEvidence: false
  });
  assert.equal(result.outcomeStatus, "READY_FOR_INTEGRATION");
  assert.deepEqual(result.consistencyWarnings, []);
});

test("snapshot-only drift never fails a read-only outcome", () => {
  const result = parseTaskOutcome(payload(), {
    intent: "read-only",
    eventTouchedFiles: [],
    snapshotChangedFiles: ["scratch/notes.md"],
    exactWorkspaceEvidence: true
  });
  assert.equal(result.outcomeStatus, "COMPLETED_READ_ONLY");
  assert.equal(result.success, true);
  assert.deepEqual(result.unattributedDriftFiles, ["scratch/notes.md"]);
  assert.match(result.consistencyWarnings.join("\n"), /drift/i);
});

test("snapshot-only drift on a write is surfaced for the bridge to reconcile", () => {
  const result = parseTaskOutcome(payload({
    outcomeStatus: "READY_FOR_INTEGRATION",
    changedFiles: ["app.txt"]
  }), {
    intent: "write",
    eventTouchedFiles: ["app.txt"],
    snapshotChangedFiles: ["app.txt", "scratch-drift.txt"],
    exactWorkspaceEvidence: true
  });
  assert.equal(result.outcomeStatus, "READY_FOR_INTEGRATION");
  assert.deepEqual(result.unattributedDriftFiles, ["scratch-drift.txt"]);
});

test("malformed output remains visible as unclassified", () => {
  const result = parseTaskOutcome("not-json", { intent: "read-only" });
  assert.equal(result.outcomeStatus, "UNCLASSIFIED");
  assert.equal(result.rawOutput, "not-json");
  assert.match(result.protocolError, /valid JSON/);
});

test("local validation rejects additional and malformed nested fields", () => {
  const additional = parseTaskOutcome(payload({ unexpected: true }), {
    intent: "read-only"
  });
  assert.equal(additional.outcomeStatus, "UNCLASSIFIED");
  assert.match(additional.protocolError, /top-level fields/);

  const malformedCheck = parseTaskOutcome(payload({
    checks: [{ command: "npm test", status: "PASS", summary: "ok", extra: true }]
  }), { intent: "read-only" });
  assert.equal(malformedCheck.outcomeStatus, "UNCLASSIFIED");
  assert.match(malformedCheck.protocolError, /checks/);

  const duplicateEvidence = parseTaskOutcome(payload({ evidence: ["a", "a"] }), {
    intent: "read-only"
  });
  assert.equal(duplicateEvidence.outcomeStatus, "UNCLASSIFIED");
  assert.match(duplicateEvidence.protocolError, /evidence/);

  const escapedPath = parseTaskOutcome(payload({ changedFiles: ["../secret.txt"] }), {
    intent: "read-only"
  });
  assert.equal(escapedPath.outcomeStatus, "UNCLASSIFIED");
  assert.match(escapedPath.protocolError, /changedFiles/);
});

test("infrastructure outcomes are bridge-generated and retryable", () => {
  const result = buildInfrastructureOutcome(new Error("failed to spawn code-mode host"));
  assert.equal(result.outcomeStatus, "INFRA_FAILED");
  assert.equal(result.retryable, true);
  assert.match(renderTaskOutcome(result), /INFRA_FAILED/);
});

test("expected failures with a justification do not block a successful audit", () => {
  const result = parseTaskOutcome(payload({
    checks: [
      { command: "git bundle verify backup.bundle", status: "PASS", summary: "valid" },
      { command: "git ls-remote origin", status: "EXPECTED_FAIL", summary: "sandbox has no network access" }
    ]
  }), { intent: "read-only" });
  assert.equal(result.outcomeStatus, "COMPLETED_READ_ONLY");
  assert.equal(result.success, true);
});

test("expected failures require a justification summary", () => {
  const result = parseTaskOutcome(payload({
    checks: [{ command: "git ls-remote origin", status: "EXPECTED_FAIL", summary: "  " }]
  }), { intent: "read-only" });
  assert.equal(result.outcomeStatus, "UNCLASSIFIED");
  assert.match(result.protocolError, /justification/);
});
