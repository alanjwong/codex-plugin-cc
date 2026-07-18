---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- The leading `Outcome: <STATUS>` line
- Job ID, `runStatus`, and `outcomeStatus`
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`

`runStatus=FINISHED` only means the transport finished. Route on `outcomeStatus` and preserve typed `BLOCKED`, `NEEDS_CONTEXT`, `PARTIAL`, and `INFRA_FAILED` output unchanged. `INFRA_FAILED` is a bridge/runtime failure, not an inspected clean audit; a successful inspected read-only task reports `COMPLETED_READ_ONLY` with inspection evidence.
