---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel "$ARGUMENTS"`

Present the command output exactly as returned. Cancellation can remain `CANCEL_REQUESTED` or become `INTERRUPTED` with `outcomeStatus=NEEDS_RECONCILIATION` until worker termination is confirmed. Inspect `/codex:status <job-id>` before retrying; do not start a replacement task while the logical task or workspace write reservation is active.

Session end preserves the job record and reconciliation evidence. Cancelling or ending a session does not authorize a fresh attempt under the same attempt ID.
