# Modifications

This repository is an unofficial fork of
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc),
based on upstream v1.0.6 (commit `db52e28`).
It is not affiliated with or endorsed by OpenAI.

Per Apache License 2.0 section 4(b), this file records that the fork
changed the upstream files listed below. See the README section
"The Reliability Overhaul" and `plugins/codex/CHANGELOG.md` for what
changed and why. `LICENSE` and `NOTICE` are unmodified upstream copies.

## Upstream files modified by this fork (36)

- `.claude-plugin/marketplace.json`
- `.github/workflows/pull-request-ci.yml`
- `README.md`
- `package-lock.json`
- `package.json`
- `plugins/codex/.claude-plugin/plugin.json`
- `plugins/codex/CHANGELOG.md`
- `plugins/codex/agents/codex-rescue.md`
- `plugins/codex/commands/cancel.md`
- `plugins/codex/commands/rescue.md`
- `plugins/codex/commands/result.md`
- `plugins/codex/commands/setup.md`
- `plugins/codex/commands/status.md`
- `plugins/codex/commands/transfer.md`
- `plugins/codex/scripts/app-server-broker.mjs`
- `plugins/codex/scripts/codex-companion.mjs`
- `plugins/codex/scripts/lib/app-server.mjs`
- `plugins/codex/scripts/lib/args.mjs`
- `plugins/codex/scripts/lib/broker-lifecycle.mjs`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/scripts/lib/process.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/lib/state.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/session-lifecycle-hook.mjs`
- `plugins/codex/scripts/stop-review-gate-hook.mjs`
- `plugins/codex/skills/codex-cli-runtime/SKILL.md`
- `plugins/codex/skills/codex-result-handling/SKILL.md`
- `plugins/codex/skills/gpt-5-4-prompting/references/codex-prompt-recipes.md`
- `tests/commands.test.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/process.test.mjs`
- `tests/render.test.mjs`
- `tests/runtime.test.mjs`
- `tests/state.test.mjs`

## Files added by this fork (22)

- `MODIFICATIONS.md` (this file)
- `plugins/codex/schemas/task-output.schema.json`
- `plugins/codex/scripts/lib/correlation.mjs`
- `plugins/codex/scripts/lib/job-reconciliation.mjs`
- `plugins/codex/scripts/lib/preflight.mjs`
- `plugins/codex/scripts/lib/task-outcome.mjs`
- `scripts/generate-modifications.mjs`
- `scripts/prebuild.mjs`
- `scripts/run-tests.mjs`
- `tests/broker-lifecycle.test.mjs`
- `tests/correlation.test.mjs`
- `tests/job-reconciliation.test.mjs`
- `tests/preflight.test.mjs`
- `tests/process-identity.test.mjs`
- `tests/publication.test.mjs`
- `tests/retention.test.mjs`
- `tests/run-tests-sweep.test.mjs`
- `tests/state-permissions.test.mjs`
- `tests/state-writer-fixture.mjs`
- `tests/task-outcome.test.mjs`
- `tests/tracked-jobs.test.mjs`
- `tests/turn-progress.test.mjs`

Regenerate with `node scripts/generate-modifications.mjs`.
