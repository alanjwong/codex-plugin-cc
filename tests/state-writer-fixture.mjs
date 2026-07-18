import fs from "node:fs";

import { transitionStoredJob } from "../plugins/codex/scripts/lib/state.mjs";

const [workspace, jobId, mode = "upsert"] = process.argv.slice(2);
if (mode === "hold-lock") {
  transitionStoredJob(workspace, jobId, (current) => {
    const readyFile = `${workspace}/holder-ready`;
    const releaseFile = `${workspace}/holder-release`;
    fs.writeFileSync(readyFile, "ready\n", "utf8");
    while (!fs.existsSync(releaseFile)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return { ...current, id: jobId, runStatus: "FINISHED" };
  });
} else if (mode === "heartbeat-loop") {
  for (let index = 0; index < 50; index += 1) {
    transitionStoredJob(workspace, jobId, (current) =>
      current.runStatus === "RUNNING"
        ? { ...current, heartbeatAt: new Date().toISOString() }
        : current
    );
  }
} else if (mode === "finish") {
  transitionStoredJob(workspace, jobId, (current) => ({
    ...current,
    runStatus: "FINISHED",
    outcomeStatus: "COMPLETED_READ_ONLY",
    completedAt: new Date().toISOString()
  }));
} else {
  transitionStoredJob(workspace, jobId, (current) => ({
    ...current,
    id: jobId,
    runStatus: current.runStatus ?? "RUNNING",
    outcomeStatus: current.outcomeStatus ?? null,
    updatedAt: new Date().toISOString()
  }));
}
