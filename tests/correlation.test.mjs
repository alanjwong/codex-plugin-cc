import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskIdentity,
  decideTaskClaim
} from "../plugins/codex/scripts/lib/correlation.mjs";

const packet = {
  workspaceRealpath: "/repo",
  intent: "write",
  prompt: "fix the retry bug",
  // Deliberately synthetic values: the fixture only exercises fingerprint
  // stability, so no real model or effort name is needed here.
  model: "test-model-alpha",
  effort: "test-effort",
  expectedHead: "abc123",
  sessionId: "claude-session"
};

test("task identity is stable for the same logical request", () => {
  const left = buildTaskIdentity(packet);
  const right = buildTaskIdentity(packet);
  assert.equal(left.requestFingerprint, right.requestFingerprint);
  assert.equal(left.idempotencyKey, right.idempotencyKey);
  assert.equal(left.attemptId, "initial");
  assert.equal(right.attemptId, "initial");
});

test("explicit workflow and task ids control idempotency", () => {
  const identity = buildTaskIdentity({ ...packet, workflowId: "wf-1", taskId: "task-4" });
  assert.equal(identity.workflowId, "wf-1");
  assert.equal(identity.taskId, "task-4");
  assert.equal(identity.logicalTaskKey, "wf-1:task-4");
  assert.equal(identity.idempotencyKey, "wf-1:task-4:initial");
});

test("exact duplicate attempts are reused", () => {
  const identity = buildTaskIdentity(packet);
  const candidate = { id: "new", runStatus: "QUEUED", ...identity };
  const decision = decideTaskClaim([
    { id: "existing", runStatus: "RUNNING", ...identity }
  ], candidate);
  assert.equal(decision.job.id, "existing");
  assert.equal(decision.conflict, null);
});

test("changed input cannot bypass a logical task reservation", () => {
  const original = buildTaskIdentity({ ...packet, workflowId: "wf-1", taskId: "task-1" });
  const changed = buildTaskIdentity({
    ...packet,
    workflowId: "wf-1",
    taskId: "task-1",
    prompt: "fix the retry bug and refactor it"
  });
  const decision = decideTaskClaim([
    { id: "active", runStatus: "RUNNING", ...original }
  ], { id: "new", runStatus: "QUEUED", ...changed });
  assert.equal(decision.job.id, "active");
  assert.match(decision.conflict, /same workflow and task.*different request/i);
});

test("a different attempt waits for the active logical task", () => {
  const original = buildTaskIdentity({ ...packet, workflowId: "wf-1", taskId: "task-1" });
  const retry = buildTaskIdentity({
    ...packet,
    workflowId: "wf-1",
    taskId: "task-1",
    attemptId: "retry-2"
  });
  const decision = decideTaskClaim([
    { id: "active", runStatus: "RUNNING", ...original }
  ], { id: "retry", runStatus: "QUEUED", ...retry });
  assert.equal(decision.job.id, "active");
  assert.match(decision.conflict, /active attempt/i);
});

test("an unrelated active writer blocks a new write candidate in every active status", () => {
  const writer = {
    id: "writer",
    intent: "write",
    logicalTaskKey: "wf-9:task-9",
    idempotencyKey: "wf-9:task-9:initial",
    requestFingerprint: "zzz"
  };
  for (const runStatus of ["QUEUED", "RUNNING", "CANCEL_REQUESTED"]) {
    const decision = decideTaskClaim(
      [{ ...writer, runStatus }],
      { id: "new", runStatus: "QUEUED", intent: "write", ...buildTaskIdentity(packet) }
    );
    assert.equal(decision.job.id, "writer");
    assert.match(decision.conflict, /active write attempt/i);
  }
});

test("the writer policy ignores read-only jobs in both directions", () => {
  const activeWriter = {
    id: "writer",
    runStatus: "RUNNING",
    intent: "write",
    logicalTaskKey: "wf-9:task-9",
    idempotencyKey: "wf-9:task-9:initial",
    requestFingerprint: "zzz"
  };
  const readOnlyCandidate = {
    id: "reader",
    runStatus: "QUEUED",
    intent: "read-only",
    ...buildTaskIdentity({ ...packet, intent: "read-only", prompt: "inspect the repo" })
  };
  assert.equal(decideTaskClaim([activeWriter], readOnlyCandidate), null);

  const activeReader = {
    id: "reader",
    runStatus: "RUNNING",
    intent: "read-only",
    logicalTaskKey: "wf-8:task-8",
    idempotencyKey: "wf-8:task-8:initial",
    requestFingerprint: "yyy"
  };
  assert.equal(decideTaskClaim(
    [activeReader],
    { id: "new", runStatus: "QUEUED", intent: "write", ...buildTaskIdentity(packet) }
  ), null);
});

test("exact duplicate writer reuse wins over the workspace-writer conflict", () => {
  const identity = buildTaskIdentity(packet);
  const decision = decideTaskClaim(
    [{ id: "existing", runStatus: "RUNNING", intent: "write", ...identity }],
    { id: "new", runStatus: "QUEUED", intent: "write", ...identity }
  );
  assert.equal(decision.job.id, "existing");
  assert.equal(decision.conflict, null);
});
