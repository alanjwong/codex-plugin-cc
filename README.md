# Codex for Claude Code — Unofficial Reliability Fork

[![CI](https://github.com/alanjwong/codex-plugin-cc/actions/workflows/pull-request-ci.yml/badge.svg?branch=main)](https://github.com/alanjwong/codex-plugin-cc/actions/workflows/pull-request-ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Upstream](https://img.shields.io/badge/fork%20of-openai%2Fcodex--plugin--cc%20v1.0.6-black)](https://github.com/openai/codex-plugin-cc)
[![Release](https://img.shields.io/badge/release-1.0.6--fork.3-brightgreen)](https://github.com/alanjwong/codex-plugin-cc/tags)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.18-informational)](https://nodejs.org)
[![Unofficial](https://img.shields.io/badge/unofficial-not%20affiliated%20with%20OpenAI-orange)](#unofficial-fork)

> Use OpenAI Codex from inside Claude Code — for code reviews and delegated tasks, made to fail fast, report honestly, and resume exactly.

[Install](#install) · [Commands](#commands) · [The Reliability Overhaul](#the-reliability-overhaul) · [Config](#config) · [FAQ](#faq)

<a id="unofficial-fork"></a>
> [!IMPORTANT]
> **Unofficial fork of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), based on upstream v1.0.6. Not affiliated with or endorsed by OpenAI.**
> It is *stricter* than upstream, not universally better: every delegated task must declare an explicit `--read-only` or `--write` intent — a deliberate breaking change. Want the original? Install [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) instead.

## Install

In Claude Code:

```bash
/plugin marketplace add alanjwong/codex-plugin-cc
/plugin install codex@alanjwong-codex
/reload-plugins
/codex:setup
```

`/codex:setup` tells you whether Codex is ready and can offer to install Codex for you.

**Requires:**
- A ChatGPT account (any plan, including Free) or an OpenAI API key — usage counts toward your [Codex limits](https://developers.openai.com/codex/pricing).
- Node.js 18.18+
- The Codex CLI — `npm install -g @openai/codex`, then `codex login` (in Claude Code, prefix with `!`: `!codex login`), or let `/codex:setup` do it.

## Commands

| Command | What it does |
| --- | --- |
| `/codex:review` | Read-only Codex review of your current work (`--base <ref>`, `--background`, `--wait`). |
| `/codex:adversarial-review` | Steerable "challenge" review — pressure-tests design, tradeoffs, and risk areas. |
| `/codex:rescue` | Delegate a task to Codex (`--read-only`/`--write`, `--resume`/`--fresh`, `--model`, `--effort`). |
| `/codex:transfer` | Turn the current Claude session into a resumable Codex thread. |
| `/codex:status` | Show running and recent Codex jobs for this repo. |
| `/codex:result` | Show the final output (and Codex session id) of a finished job. |
| `/codex:cancel` | Cancel an active background job. |
| `/codex:setup` | Check Codex install/auth; toggle the optional review gate. |

**Quick start:**

```bash
/codex:review --background   # kick off a review
/codex:status                # check progress
/codex:result                # read the result
```

## The Reliability Overhaul

Upstream is simpler; this fork adds a reliability layer so real delegation can be trusted:

- **Explicit intent + preflight**: every task is `--read-only` or `--write`, validated (workspace, branch, commands, and the runtime's actual sandbox) *before* any paid model turn.
- **Honest, typed outcomes**: `runStatus` (did the call complete) is separate from `outcomeStatus` (did the work succeed); `FINISHED` never implies success, and `BLOCKED`/`PARTIAL`/`INFRA_FAILED` are preserved, never dressed up as success.
- **Durable jobs + exact resume**: per-job state survives session end; correlation ids make dispatch idempotent; interrupted Git writes reconcile against a hash-bound snapshot and resume the *exact* thread instead of paying twice.
- **Two-stage cancel + reconciliation**: dead jobs become `INTERRUPTED / NEEDS_RECONCILIATION` instead of lying; cancel never mistakes "asked to stop" for "stopped".
- **Consumer-safety hardening**: process signals are gated on a recorded launch identity and fail closed if it can't be verified; temp/broker cleanup only touches marker-authenticated, owner- and inode-checked dirs and won't follow symlinks; durable state is `0700`/`0600`. These defend against other local users and accidental self-harm; they are best-effort against a same-user process that can race the filesystem, which a single-process Node tool can't fully prevent.

The tradeoff: prompts that worked on upstream fail fast here until you declare an intent, and one write task runs per workspace at a time. This fork optimizes for auditability of delegated work over frictionless dispatch.

<details>
<summary><b>Command reference & recovery contract</b></summary>

### `/codex:setup`
Checks whether Codex is installed and authenticated, can offer to install Codex for you, and toggles the optional review gate. When auth is missing it points you to `codex login` (in Claude Code, `!codex login`).

### `/codex:review`
Read-only review of your current work; never changes code. `--base <ref>` reviews a branch vs a base, and it takes `--wait`/`--background`.

### `/codex:adversarial-review`
A steerable "challenge" review that uses the same review target selection as `/codex:review`, plus free-text focus after the flags to question the chosen design (auth, data loss, rollback, race conditions, …). Example: `/codex:adversarial-review --base main challenge whether this was the right caching and retry design`.

### `/codex:rescue`
Delegates to the `codex:codex-rescue` subagent. Declare exactly one intent: `--write` for implementation/change requests, `--read-only` for review/diagnosis/planning/research/audit. Supports `--background`, `--wait`, `--resume`/`--fresh`, `--model`, `--effort`. If you do not pass `--model` or `--effort`, Codex chooses its own defaults; pass them to pin a run, e.g. `--model gpt-5.4-mini --effort medium`. If you ask for `spark`, the plugin maps that to `gpt-5.3-codex-spark`. One write-intent task per workspace; parallel write work belongs in separate Git worktrees.

### `/codex:transfer`
Turns the current Claude session into a resumable Codex thread, so you can continue a previous Codex task directly in Codex.

### `/codex:status`
Shows running and recent Codex jobs for this repo.

### `/codex:result`
Shows the final stored output and, when available, a `codex resume <session-id>` to reopen the run in Codex. Success outcomes are `READY_FOR_INTEGRATION` (write) and `COMPLETED_READ_ONLY` (read-only); `INFRA_FAILED` means the bridge/runtime failed, not a clean audit.

### `/codex:cancel`
Cancels an active background job. Dead or cancelled jobs become `INTERRUPTED / NEEDS_RECONCILIATION` rather than silently vanishing.

### Task recovery contract
If a call times out, **inspect the correlated job before retrying**: don't launch a replacement just because the outer call stopped waiting. If active, wait or report. If interrupted with a stored thread, `reconcile <job> [--accept-snapshot <sha256>]` (no workspace edits, no model turn) then resume the exact thread with `task --resume-job <job-id>`. A fresh retry is allowed only after the prior attempt is terminal, under a new attempt id.

### Review gate (optional)
```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```
When enabled, a `Stop` hook runs a targeted Codex review of Claude's response and blocks the stop if it finds issues. It can create a long Claude/Codex loop and drain usage — enable it only while actively watching the session.

</details>

## Config

This fork sets **no model or effort defaults of its own**: it uses your Codex CLI config or an explicit `--model`/`--effort` flag. Set defaults in `~/.codex/config.toml` (user) or `.codex/config.toml` (project, when the project is [trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)):

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

It wraps your local [Codex CLI](https://developers.openai.com/codex/cli/) and [app server](https://developers.openai.com/codex/app-server) — same install, same auth, same repo checkout. Dev/test tooling is validated on macOS/Linux only; the runtime has Windows paths (named pipes, `taskkill`) that this fork hasn't validated on Windows.

## FAQ

**Do I need a separate Codex account?** No — if you're already signed into Codex on this machine, it works here. Otherwise sign in with a ChatGPT account or API key ([`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login)).

**Does it use a separate Codex runtime?** No — it delegates through your local Codex CLI/app server on the same machine, with your existing auth and config.

**Can I keep my current API key / base URL?** Yes. Point the OpenAI provider elsewhere with `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations) if needed.

## License

Apache-2.0 — `LICENSE` and `NOTICE` are unmodified upstream copies. See [`MODIFICATIONS.md`](MODIFICATIONS.md) for the Apache §4(b) inventory of what this fork changed, and [`plugins/codex/CHANGELOG.md`](plugins/codex/CHANGELOG.md) for release notes.
