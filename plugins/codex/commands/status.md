---
description: Show active and recent Codex jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, `runStatus`, `outcomeStatus`, phase, elapsed or duration, `lastProgressAt`, `turnQuietMs`, `turnQuietWarning`, summary, and follow-up commands.
- If more than one active job is present, list every candidate and require an explicit job ID for any follow-up action. Do not guess.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

Interpretation rules:
- `runStatus` is the execution/transport state; `outcomeStatus` is the task result. `runStatus=FINISHED` is not proof of success.
- If `turnQuietWarning` persists across two consecutive `status --wait` cycles, surface the stall to the caller with the job ID and log file instead of waiting out the full budget. Quietness alone does not interrupt the job and may represent deep reasoning.
- Session end preserves job records. An active attempt may become `INTERRUPTED` with `outcomeStatus=NEEDS_RECONCILIATION`; inspect and reconcile that exact job before retrying or resuming it.
