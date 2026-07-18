# Codex plugin for Claude Code — unofficial reliability fork

> [!IMPORTANT]
> **This is an unofficial fork. It is not affiliated with or endorsed by OpenAI.**
> It is a fork of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) carrying a reliability overhaul of the codex-companion CLI, currently based on upstream **v1.0.6**. Fork releases are versioned `<upstream-base>-fork.<n>` (e.g. `1.0.6-fork.1`) so they can never collide with upstream version numbers.
>
> The fork is *stricter* than upstream, not universally better: most notably, every delegated task must declare an explicit `--read-only` or `--write` intent — a deliberate breaking change. See [The Reliability Overhaul](#the-reliability-overhaul) for what changed and why. The install steps below install this fork; for the original plugin, use [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc).

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs

## The Reliability Overhaul

This section explains what this fork changes relative to upstream and why. It is the fork's operating manual; the per-command documentation below already reflects the forked behavior.

### The trust problem

The stock plugin had a trust problem when used for real delegation: a Codex dispatch could run in the wrong mode silently, report "completed" when the transport finished regardless of whether the work succeeded, lose job records when a session ended, resume the wrong thread, and duplicate paid write-work on retries. The fork makes delegation fail fast, report honestly, and resume exactly.

### The eight changes

In dependency order:

1. **Explicit intent + preflight** — every `task` requires exactly one of `--read-only`/`--write`; the workspace, branch, and required commands/artifacts are validated *before* any paid model turn, and the runtime's actual sandbox is attested against the request before the turn starts.
2. **Typed outcomes** — results carry `runStatus` (did the call complete) separately from `outcomeStatus` (did the work succeed). Only `READY_FOR_INTEGRATION` / `COMPLETED_READ_ONLY` are success; `BLOCKED` / `NEEDS_CONTEXT` / `PARTIAL` are finished transports (exit 0) that are *not* success; infrastructure failures become `INFRA_FAILED` instead of blank results. Claimed file changes are cross-checked against event evidence and workspace snapshots.
3. **Durable, atomic job state** — a real state lock (with atomic dead-owner steal), atomic writes, per-job files that survive the display cap and session end, heartbeats, and state-format migration.
4. **Correlation + exact resume** — `--workflow-id`/`--task-id`/`--attempt-id` make dispatches idempotent (an exact duplicate returns the existing job instead of paying twice); `--resume-job <id>` resumes the *exact* stored thread; at most one active write task per workspace (parallel writes belong in separate Git worktrees).
5. **Reconciliation** — dead jobs become `INTERRUPTED / NEEDS_RECONCILIATION` instead of lying; interrupted Git writes require `reconcile <job> --accept-snapshot <sha256>` (hash-bound, no force flag) before exact resume; cancellation is two-stage and never mistakes "asked to stop" for "stopped".
6. **Claude-side contracts** — the rescue agent and skills demand explicit intent, forbid inferring success from "completed", and never relaunch after a timeout (inspect → reconcile → resume instead).
7. **Observability** — active jobs record `lastProgressAt` from turn notifications and surface a warning after a configurable quiet period; definite transport death fails an in-flight task promptly as `FAILED / INFRA_FAILED` with its thread and turn identifiers preserved for exact resume.
8. **Consumer-safety hardening** — persisted process signals are gated on a recorded launch identity (pid + start time + exact `--launch-token` argv match) and fail closed when that identity cannot be verified, so a recycled pid is not signaled through those paths; temp cleanup and broker teardown act only on marker-authenticated, owner- and inode-checked session dirs and do not follow symlinks; durable state is created `0700`/`0600` (repaired even under a permissive umask), and symlinked or foreign-owned state roots and files are rejected; terminal job artifacts are retained under a TTL and count cap with a `purge` subcommand that validates the state-directory chain before deleting and preserves unresolved (`NEEDS_RECONCILIATION`) jobs. These protections defend against other local users and accidental self-harm; they are best-effort against a same-user process that can race filesystem operations between check and use, which a single-process Node tool cannot fully prevent.

### The two-axis status model

Everything downstream of a dispatch reads two independent fields:

- **`runStatus`** answers "did the execution/transport complete?" (`FINISHED`, `INTERRUPTED`, `CANCEL_REQUESTED`, …)
- **`outcomeStatus`** answers "did the task succeed?" (`READY_FOR_INTEGRATION`, `COMPLETED_READ_ONLY`, `BLOCKED`, `NEEDS_CONTEXT`, `PARTIAL`, `INFRA_FAILED`, `NEEDS_RECONCILIATION`, `UNCLASSIFIED`, …)

`runStatus: FINISHED` never implies success, and a non-success outcome is preserved verbatim instead of being converted into success by a summarizing layer. Checks inside a result may report `EXPECTED_FAIL` (with a required justification) for probes that legitimately cannot pass in the runtime environment; a plain `FAIL` remains strictly fatal to any success claim.

### The recovery contract

The full contract is in [Task Recovery Contract](#task-recovery-contract) below. The short version: never relaunch a task because a call stopped waiting. Inspect the correlated job; if it is active, wait or report; if it is interrupted, reconcile it (Git writes require hash-bound snapshot acceptance) and resume the exact thread with `task --resume-job <job-id>`. A fresh retry is allowed only after the prior attempt is terminal, under a new attempt ID.

### What this costs you

The strictness is a tradeoff, made deliberately:

- **`--read-only`/`--write` is mandatory** on every delegated task. Prompts that worked on upstream fail fast here until an intent is declared. This is the fork's core breaking change.
- One write-intent task per workspace at a time; parallel write work requires separate Git worktrees.
- Interrupted write work cannot be silently retried; it must be reconciled first.

If you want the upstream behavior, use the upstream plugin — this fork optimizes for auditability of delegated work over frictionless dispatch.

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

> [!NOTE]
> This fork sets no model or reasoning defaults of its own: every run uses your Codex CLI configuration (`~/.codex/config.toml` or a project-level override) or an explicit `--model`/`--effort` flag — see [Common Configurations](#common-configurations). The fork's development and test tooling is validated on macOS/Linux (POSIX) only; the plugin runtime contains Windows support paths (named pipes, `taskkill`), but this fork has not validated them on Windows.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add alanjwong/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@alanjwong-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you. Setup is diagnostic; every delegated task still performs its own static and runtime preflight.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--read-only`, `--write`, `--resume`, and `--fresh`. Every task declares exactly one intent: implementation or other explicit change requests use `--write`; review, diagnosis, planning, research, and audit requests use `--read-only`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue --read-only investigate why the tests started failing
/codex:rescue --write fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- `/codex:rescue --resume` uses `task --resume-last` as a human convenience for the latest eligible task in the current Claude session
- controllers use `task --resume-job <job-id>` for an exact correlated resume
- correlation controls (`--workflow-id`, `--task-id`, and `--attempt-id`) are runtime metadata and are never copied into prompt prose
- one write-intent task may be active per workspace; parallel write work belongs in isolated Git worktrees

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

The printed `codex resume <session-id>` command is the human handoff path into Codex. It is separate from companion-controlled task recovery with `task --resume-job <job-id>`.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

Status exposes two distinct fields. `runStatus` describes execution or transport state; `outcomeStatus` describes the task result. A `runStatus` of `FINISHED` does not imply success. If more than one active job matches the current session, pass a job ID instead of guessing which one to inspect.

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

The result begins with `Outcome: <STATUS>`. Successful task outcomes are `READY_FOR_INTEGRATION` for write work and `COMPLETED_READ_ONLY` for inspected read-only work. Typed `BLOCKED`, `NEEDS_CONTEXT`, `PARTIAL`, and `INFRA_FAILED` results are preserved instead of being converted into success or replaced by Claude-side work. In particular, `INFRA_FAILED` means the bridge or runtime failed; it is not an inspected clean audit.

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

Cancellation may remain pending until worker termination is confirmed. Inspect the same job before retrying, and do not bypass an active logical-task or workspace write reservation.

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

Setup does not replace per-task preflight. Task startup verifies the workspace, required commands and artifacts, requested intent, and effective runtime. `externalSandbox` runtimes are deliberately unsupported for tasks: runtime attestation fails closed before a model turn when the effective sandbox does not match the requested task sandbox.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Task Recovery Contract

If a rescue call times out or disappears, inspect the correlated job before retrying. Do not launch a replacement task merely because the outer Agent or Bash call stopped waiting. If the job is still active, report or wait on that job. If it is interrupted and has a stored thread, reconcile it and then use exact `task --resume-job <job-id>` recovery. A fresh retry is allowed only after the prior attempt is terminal and uses a new explicit attempt ID; the same attempt ID is reserved for an exact duplicate request.

`reconcile [job-id] [--accept-snapshot <sha256>]` does not edit the target workspace and does not start a model turn, but it does persist companion reconciliation state. Snapshot acceptance is explicit and hash-bound. An interrupted Git write requires acceptance of the exact observed snapshot before it can resume. An interrupted non-Git write has no exact Git snapshot and cannot be exact-resumed; inspect it and start a fresh attempt only with explicit direction.

Session end preserves completed and active job records instead of deleting them. An active job may be retained as `CANCEL_REQUESTED` or recorded as `INTERRUPTED` with `outcomeStatus=NEEDS_RECONCILIATION`, so the next session can inspect and reconcile the same attempt.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue --read-only investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background --read-only investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#enabling-review-gate) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
