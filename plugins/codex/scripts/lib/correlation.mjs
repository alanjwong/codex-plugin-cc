import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildTaskIdentity(packet) {
  const requestFingerprint = sha256(JSON.stringify({
    workspaceRealpath: packet.workspaceRealpath,
    intent: packet.intent,
    prompt: packet.prompt,
    model: packet.model ?? null,
    effort: packet.effort ?? null,
    sandbox: packet.sandbox ?? null,
    expectedBranch: packet.expectedBranch ?? null,
    expectedHead: packet.expectedHead ?? null,
    requiredArtifacts: [...(packet.requiredArtifacts ?? [])].sort(),
    requiredCommands: [...(packet.requiredCommands ?? [])].sort()
  }));
  const workflowId = packet.workflowId ?? packet.sessionId ?? `standalone-${requestFingerprint.slice(0, 12)}`;
  const taskId = packet.taskId ?? `task-${requestFingerprint.slice(0, 16)}`;
  const attemptId = packet.attemptId ?? "initial";
  const logicalTaskKey = `${workflowId}:${taskId}`;
  return {
    workflowId,
    taskId,
    attemptId,
    logicalTaskKey,
    requestFingerprint,
    idempotencyKey: `${logicalTaskKey}:${attemptId}`
  };
}

function isActive(job) {
  return ["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(job.runStatus);
}

export function isWriteIntent(job) {
  return (
    job.intent === "write" ||
    job.preflight?.intent === "write" ||
    job.write === true
  );
}

export function decideTaskClaim(jobs, candidate) {
  const exact = jobs.find((job) => job.idempotencyKey === candidate.idempotencyKey);
  if (exact) {
    return {
      job: exact,
      conflict: exact.requestFingerprint === candidate.requestFingerprint
        ? null
        : `The same workflow and task attempt already exists with a different request: ${exact.id}.`
    };
  }
  const active = jobs.find((job) =>
    job.logicalTaskKey === candidate.logicalTaskKey && isActive(job)
  );
  if (active) {
    return {
      job: active,
      conflict: `Logical task ${candidate.logicalTaskKey} already has active attempt ${active.id}.`
    };
  }
  if (isWriteIntent(candidate)) {
    const activeWriter = jobs.find((job) => isActive(job) && isWriteIntent(job));
    if (activeWriter) {
      return {
        job: activeWriter,
        conflict:
          `Workspace already has active write attempt ${activeWriter.id}. ` +
          "Wait for it to finish or use an isolated worktree."
      };
    }
  }
  return null;
}
