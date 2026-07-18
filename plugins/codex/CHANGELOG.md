# Changelog

This is an unofficial reliability fork of `openai/codex-plugin-cc`. Fork
releases are versioned `<upstream-base>-fork.<n>`; internal iterations before
the first public release are collapsed into the entry below.

## 1.0.6-fork.3

First public fork release, based on upstream v1.0.6. Relative to the upstream
plugin, delegated Codex work now fails fast, reports honestly, and resumes
exactly:

### Changed

- Every delegated `task` requires exactly one explicit intent flag,
  `--read-only` or `--write` (a deliberate breaking change), validated by
  static preflight and runtime sandbox attestation before any model turn.
- Results carry `runStatus` (did the call complete) separately from
  `outcomeStatus` (did the work succeed); non-success outcomes such as
  `BLOCKED`, `PARTIAL`, and `INFRA_FAILED` are preserved instead of being
  summarized as success. Checks may report `EXPECTED_FAIL` with a required
  justification; `FAIL` remains fatal to success claims.
- Job state is durable and atomic: per-job records survive session end,
  writes go through a real state lock, and interrupted jobs become
  `INTERRUPTED / NEEDS_RECONCILIATION` for later exact-thread recovery
  (`reconcile` with hash-bound snapshot acceptance, then
  `task --resume-job <job-id>`). Correlation ids make dispatches idempotent.
- Turn progress is observable (`lastProgressAt`, quiet-turn warnings), and a
  dead app-server transport fails typed within seconds with thread and turn
  identifiers preserved for exact resume.

### Fixed and hardened for public consumption

- The broker records startup, shutdown, and app-server death (with captured
  stderr) in `broker.log`, and archives a dead broker's log tail to
  `state/broker-deaths.log` before teardown removes it.
- Broker lifecycle safety: ensure/spawn is serialized per workspace with an
  owner-verified lock, a live-but-busy broker is never torn down, an unready
  spawned broker is terminated with its process tree, and temp-dir cleanup
  deletes only registered session dirs that carry a matching random ownership
  marker (missing evidence always means preserve; symlinks are never
  followed).
- Every process signal (cancel, session end, reconciliation, broker teardown,
  test cleanup) verifies a recorded launch identity — pid, start time, and a
  random argv token — immediately before signaling, so a recycled pid can
  never terminate an unrelated process. Records without an identity are never
  signaled.
- Durable state is user-private: directories are created `0700` and state,
  job, lock, and log files `0600` regardless of umask; symlinked or
  foreign-owned state roots are rejected.
- Terminal job artifacts are retained with a TTL and count cap
  (`CODEX_COMPANION_JOB_TTL_DAYS`, `CODEX_COMPANION_MAX_TERMINAL_JOBS`) and an
  explicit `purge` subcommand; unresolved jobs are always preserved.
- The test suite runs in a per-run private temp root and cleans up only
  identity-verified processes it launched itself; job results record their
  transport identity (`transport.kind`, broker endpoint) and the
  `pluginVersion` that served them.
