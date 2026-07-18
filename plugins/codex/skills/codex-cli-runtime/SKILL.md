---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Pass exactly one of `--write` or `--read-only` on every `task` call.
- Use `--write` only for an explicit implementation/change request. Use `--read-only` for review, diagnosis, planning, research, or audit work.
- Pass `--require-command codex-code-mode-host` when the selected Codex runtime depends on that host.
- Preserve `--workflow-id`, `--task-id`, `--attempt-id`, and `--resume-job` as runtime controls; never include them in prompt prose.
- Reuse the same attempt ID only for an exact duplicate request. A deliberate fresh retry gets a new explicit attempt ID after the prior attempt is terminal; never change prompt/capability fields under an existing attempt ID.
- Inspect `outcomeStatus`; `runStatus=FINISHED` does not mean the task succeeded.
- Return typed `BLOCKED`, `NEEDS_CONTEXT`, `PARTIAL`, and `INFRA_FAILED` output unchanged.
- If invocation fails before a valid envelope is returned, preserve the companion's actionable stderr. Do not fabricate a substitute result.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- If the forwarded request includes `--resume-job`, pass the job ID through exactly. This is the controller path for an exact correlated resume after reconciliation.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: human convenience for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run. Controllers use `task --resume-job <job-id>`.

Safety rules:
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
