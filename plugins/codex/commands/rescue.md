---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--read-only|--write] [--resume|--fresh] [--workflow-id <id>] [--task-id <id>] [--attempt-id <id>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`), forwarding the raw user request as the prompt.
`codex:codex-rescue` is a subagent, not a skill — do not call `Skill(codex:codex-rescue)` (no such skill) or `Skill(codex:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex:codex-rescue` subagent in the background.
- If the request includes `--wait`, run the `codex:codex-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- Dispatch with explicit task intent. Preserve an explicit `--write` or `--read-only`; otherwise add `--write` only for an explicit implementation/change request and add `--read-only` for review, diagnosis, planning, research, or audit work.
- Preserve `--workflow-id`, `--task-id`, and `--attempt-id` as correlation controls. Do not include them in the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...` and return that command's stdout as-is.
- Inspect `outcomeStatus`; `runStatus=FINISHED` does not mean the task succeeded. Preserve typed `BLOCKED`, `NEEDS_CONTEXT`, `PARTIAL`, and `INFRA_FAILED` output unchanged.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.

Timeout and retry sequence:

Do not launch a replacement task after a timeout. Follow this correlated recovery sequence:

1. Dispatch the rescue subagent once with explicit intent.
2. If it returns a typed result, route on `outcomeStatus`.
3. If the outer Agent/Bash call times out or disappears, do not launch a replacement task.
4. Query current-session status and reconcile the matching job.
5. If the job is still running, report it or wait on that job.
6. If it is interrupted with a stored thread, continue with `--resume-job <job-id>` only after reconciliation.
7. If reconciliation reports workspace drift, stop and ask for direction.
8. For a fresh retry after a terminal non-resumable attempt, allocate a new attempt ID; do not bypass an active logical-task reservation.

Status ambiguity is a blocker: when more than one active job matches the current session and no task ID was supplied, list the candidates instead of guessing.

`reconcile` never edits the target workspace or starts a model turn. It does persist companion reconciliation state. Snapshot acceptance must be explicit and hash-bound with `--accept-snapshot <sha256>`. An interrupted Git write requires exact snapshot acceptance before `--resume-job`; an interrupted non-Git write cannot be exact-resumed.
