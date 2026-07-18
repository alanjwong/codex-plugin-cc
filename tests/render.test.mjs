import test from "node:test";
import assert from "node:assert/strict";

import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderStoredJobResult
} from "../plugins/codex/scripts/lib/render.mjs";

test("renderJobStatusReport surfaces an active turn quiet warning", () => {
  const output = renderJobStatusReport({
    id: "task-quiet",
    runStatus: "RUNNING",
    kindLabel: "task",
    title: "Codex Task",
    turnQuietMs: 17 * 60_000,
    turnQuietWarning: true,
    logFile: "/tmp/task-quiet.log"
  });

  assert.match(
    output,
    /Warning: no turn activity observed for 17m\. This may be deep reasoning or a severed connection; inspect the log or cancel\./
  );
});

test("renderCancelReport says when a raced cancellation target already finished", () => {
  const output = renderCancelReport({
    id: "task-finished",
    runStatus: "FINISHED",
    outcomeStatus: "COMPLETED_READ_ONLY"
  }, { alreadyFinished: true });

  assert.match(output, /task-finished already finished before cancellation/);
  assert.doesNotMatch(output, /requires reconciliation/);
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

test("renderStoredJobResult prefers honest typed task rendering over the raw envelope", () => {
  const output = renderStoredJobResult(
    {
      id: "task-123",
      status: "completed",
      runStatus: "FINISHED",
      outcomeStatus: "BLOCKED",
      title: "Codex Task",
      jobClass: "task",
      threadId: "thr_456"
    },
    {
      threadId: "thr_456",
      outcomeStatus: "BLOCKED",
      rendered: "Outcome: BLOCKED\n\nThe required host is unavailable.\n",
      result: {
        outcomeStatus: "BLOCKED",
        rawOutput: '{"schemaVersion":1,"outcomeStatus":"BLOCKED"}'
      }
    }
  );

  assert.match(output, /^Outcome: BLOCKED/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /The required host is unavailable\./);
  assert.match(output, /Codex session ID: thr_456/);
});
