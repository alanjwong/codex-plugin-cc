---
description: Transfer the current Claude Code session into a resumable Codex thread
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command.

`codex resume <session-id>` is the human handoff path into Codex. For companion-controlled task recovery, use exact `task --resume-job <job-id>` after reconciliation; `task --resume-last` is only a human convenience for the latest eligible task in the current Claude session.
