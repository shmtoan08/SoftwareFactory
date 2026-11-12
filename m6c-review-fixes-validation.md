# M6C Review Fixes — Issue #8

Historical evidence. Subsequent remaining-note changes (including durable denial journaling and the production Codex gate) are recorded in [the remaining-note report](./m6c-review-notes-validation.md).

Review baseline: `f941d94da2060ef53a94f92e3572703571b2d2e0`. Fix branch: `review/m6c-1-2`.

This report covers the five requested findings in [issue #8](https://github.com/shmtoan08/SoftwareFactory/issues/8). Acceptance and checklist decisions remain with the reviewer. No merge into `main` or M6C-3 implementation is included.

| Finding | Change | Regression evidence |
|---|---|---|
| M6C-FIX-01 | Public direct dispatch forces capacity/file exclusion after copying input, so even a JSON `reject_overlapping_active_files: false` cannot override it. | Real signed HTTP overlap rejection, direct API concurrency-cap rejection, unchanged task state on denial; memory and PostgreSQL. |
| M6C-FIX-02 | Typed `GlobIntersectionComplexityError` becomes a blocked scheduler task instead of aborting the batch. | Real 50,000-state search ceiling, adversarial task ordered before a healthy task; healthy task leases while the complex task stays Ready; memory and PostgreSQL. |
| M6C-FIX-03 | PG merge-queue lock fails closed without an explicit active tenant transaction. | Callback is not invoked outside a TX; scoped call succeeds. Existing real Git/PG queue concurrency and recovery tests remain enabled. |
| M6C-FIX-04 | Awaited transaction-end callbacks retry aggregate-budget denial persistence after outer locks/connection are released. | PostgreSQL with one pooled connection: self-held NOWAIT lock, external-connection contention, outer rollback, caught denial followed by commit, rolled-back policy, rolled-back cost session, durable pause/event/outbox/blocked ledger for committed parents, authorized resume, failure propagation and RLS reset. |
| M6C-FIX-05 | Redact hyphenated keys, assigned tokens/cookies, JWT, Basic, URL userinfo and private-key PEM. | Matrix tests check in-memory spans/events/status plus actual OTLP trace and counter/histogram HTTP exports; ordinary messages remain intact. |

## Verification

- Focused M6C-1 + review-fix suites: 12 passed, 0 failed, 0 skipped against real PostgreSQL 17 before the final external-contention case was added.
- Four M2/M3/M4 fixture compatibility regressions: 4 passed, 0 failed, 0 skipped.
- Final targeted M5-Gate-6 and expanded PostgreSQL FIX-01..04: 2 passed, 0 failed, 0 skipped, including task-policy/transient-task and external-connection cases.
- Final full regression (`npm test`): **115 passed, 0 failed, 0 skipped, 13 suites**, exit 0. Environment: macOS, Node `24.16.0`, real PostgreSQL `17.10`, separate freshly migrated database. Includes M6C-1 8/8, M6C-2 9/9 and the final four review-fix tests with all expanded PostgreSQL denial cases.
- Final strict lint/TypeScript and secret scan: passed (119 lint inputs, 118 scan inputs, 0 findings); whitespace check passed.
- Fresh database migrations through `0010` and RLS verification matrix: passed. No schema migration was required for these fixes.

The original fixture discovery run rejected overlapping direct dispatches as intended. M2/M3/M4/M5 gatekeeper/verifier/reviewer probes that require simultaneous legacy candidates now explicitly seed that privileged historical precondition through the repository. Public-route exclusion is verified independently by FIX-01; no HTTP bypass was added. Import rejection/recovery scenarios instead revoke completed fixture leases or reconcile expired ones before starting the next independent task. Existing downstream verification/approval assertions remain intact.

Run with PostgreSQL configured using the README migration sequence:

```bash
npm run lint
npm run scan:secrets
npm run test:m6c:fix
npm test
```

## Boundaries

The budget completion callback is awaited after the outer COMMIT/ROLLBACK and connection release, in a new RLS scope; it is not a detached promise or a retry within an aborted transaction. All queued callbacks are attempted, and an aggregate error surfaces persistence failures while retaining the original error. A rolled-back policy is restored if needed so its captured denial stays paused and resumable. A surviving project retains the denial audit when a transient task/cost session vanishes; no orphan FK-bound parent/ledger is invented. A rolled-back project itself cannot own a pause/audit. This transaction-end retry does not claim persistence of pending callbacks across process termination before they run. Separate per-session Cost Guard fallbacks are outside this aggregate-budget finding.

Minor notes in issue #8 are not declared fixed. CI Linux PostgreSQL 16/17 remains a required check after reviewer acceptance and merge into `main`; local macOS PostgreSQL testing does not establish Linux kernel/container isolation. M6C-3 and G7 remain pending.
