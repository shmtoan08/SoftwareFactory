# M6C-3 — gVisor Verifier Foundation

Date: 2026-11-13. Baseline: `eaec0cb` on main, reviewed ĐẠT with all three CI jobs successful. This is the first implementation slice of M6C-3, not release gate G7 acceptance.

## Implemented

- Core API operator configuration `SF_VERIFIER_ISOLATION=gvisor` sets an immutable constructor policy. Unknown values fail before opening owned resources. Caller `require_kernel_isolation=true` may strengthen standard policy; false or HTTP admin overrides do not weaken the constructor policy.
- Required gVisor rejects host/subprocess/supervisor modes and network access, requires a working Docker daemon, local immutable image digest and registered `runsc`, and always passes `--runtime=runsc` to every tier. Docker launch failure follows the existing bounded INFRA_ERROR retry/manual-intervention path and never changes runtime. Missing prerequisites reject before candidate commands execute.
- All tiers use the inspected image digest rather than a mutable tag. Existing read-only mounts, no-new-privileges, capability/resource limits, tmpfs, environment sanitization, immutable snapshot and independent verification/review/approval bindings remain.
- `isolationRuntime` is included in the report hash. Core API persists `isolation_runtime` and publishes it in `verification.completed`. Both stores validate runtime/backend/network/image bindings. Migration 0013 enforces the same CHECK at raw SQL INSERT; verification records retain append-only permissions and FORCE RLS.
- Historical/standard evidence remains NULL. A runtime field indicates selection, not proof of successful execution; assess the status and tier outcomes. Docker daemon/runtime installation remains in the trusted operator boundary. Candidate-supplied runtime strings or dmesg output are not treated as attestation.

## Validation

- Focused policy/CLI-double + PostgreSQL suite: **3/3 passed, 0 skips** on Node 24.16.0 / PostgreSQL 17.10. Covers invalid config, server-policy downgrade rejection, missing/malformed runtime/daemon/image, digest pinning for every tier, bounded launch-error retries, report binding, memory/PG persistence, contradictory raw SQL INSERT rejection and unscoped RLS invisibility.
- Migration 0013: applied/reapplied on a clean PostgreSQL 17 schema; RLS-T1..T8 passed. CI includes reapplication on clean and three historical upgrade paths.
- Full local regression: **124/124 passed, 15 suites, 0 failures, 0 skips** on Node 24.16.0 / PostgreSQL 17.10 (~280 seconds). Lint/typecheck/shell syntax: **133 inputs passed**; secret scan: **132 inputs, 0 leaks**.
- Dedicated real gVisor Linux CI: **2/2 passed, 0 skips** on source commit `f963c6d`, [run #43345652351](https://github.com/shmtoan08/SoftwareFactory/actions/runs/43345652351/job/131624275877). The same run passed **124/124** on each PostgreSQL 16/17 job and **2/2** native Codex tests, all without skips. The gVisor job installs `release-20261109.0` from its upstream release tarball pinned by SHA-256 `0846228061b05eb936a96ed2ea205cbd8ddf6936c946f8a390b699cff3b5c138`. It ran three tiers and checked protected/root mounts, no Docker socket/provider credentials, loopback-only network and no surviving verifier containers after success or timeout. No conditional skip, optional failure or fallback.

Local macOS has no Docker daemon; CLI-double success is not claimed as Linux gVisor isolation evidence. The native smoke is a separate entry point (`npm run test:m6c3:gvisor`), because its runtime prerequisites are mandatory. Existing PG16/17 and native Codex jobs remain.

## Operations and Remaining M6C-3

Apply migrations through 0013 before starting the new API. Install and register gVisor on the Docker host using the [official installation guide](https://gvisor.dev/docs/user_guide/install/) and [Docker guide](https://gvisor.dev/docs/user_guide/quick_start/docker/). A runtime removed after probing causes Docker launch failure, never fallback. Existing standard-policy behavior is unchanged until the operator enables the stronger policy; no external/untrusted connector is opened under standard policy.

Still pending: concrete Tier 2/3/4 connectors with identity/health/capability checks, mandatory trust-tier routing into the stronger verifier, Firecracker abstraction, Lima/WSL2 backends and full SandboxIsolationTestSuite, signed candidate/artifact-bound production deployment approval gate. No cloud provisioning, live model call or production deployment occurred. Codex production remains blocked by the owner-selected Cost Guard policy. M6C/G7 remain pending.

## Review follow-up — f963c6d

[Team review](https://github.com/shmtoan08/SoftwareFactory/commit/f963c6dbbb20a03776e094e5d5a8420cbfdc76c9#commitcomment-209693209): **ĐẠT**, no critical/medium issues. Follow-up handling:

1. Replaced the obsolete pending-CI line above with the completed source run and job evidence.
2. Verified repository settings on 2026-11-13: `GET /branches/main` reports `protected=false`; `/rules/branches/main` returns `[]` and no repository rulesets are listed. The development token observed HTTP 404 at `/branches/main/protection`; the reviewer token observed HTTP 403 due to its permissions. Protection state is established by the branch flag and effective rules, not that permission-dependent status code. README now describes unconditional workflow execution without claiming merge enforcement. No repository settings were changed; enabling required checks would change the established direct-to-main workflow and remains an owner administration decision.
3. Budget auto-pause permits at most two policy transition attempts plus a final convergence read. If a violation remains, it raises SQLSTATE 23514 and rolls back the usage transaction. Regression injects a persistence no-op while using real SQL detection, verifies bounded failure and confirms no usage metric or pause event survives rollback; the existing project/task pause regression still checks the normal path.
4. Fake compiler now parses the value following `-o`; regression checks output-option positions before and after other arguments, then verifies the original helper-spawn ENOENT path. It no longer relies on the final compiler argument being the output path.

Follow-up focused suite: **6/6 passed, 0 skips** on PostgreSQL 17.10 / Node 24.16.0. Static and CI results are recorded in issue #9 after verification. The review checklist remains with the team; M6C-3/G7 scope is unchanged.

[Review of the follow-up commit 7edf453](https://github.com/shmtoan08/SoftwareFactory/commit/7edf45398045bde80d065ead2fbeeb7e5b443efc#commitcomment-209696069) is **ĐẠT**. Its one optional documentation note about token-dependent protection API responses is clarified above and in README.
