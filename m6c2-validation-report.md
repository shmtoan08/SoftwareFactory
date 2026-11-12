# M6C-2 — Second Runtime & Extended Code Imports

Date: 2026-11-12 (Asia/Tokyo). Changes remain in the working tree alongside M6C-1.

Historical implementation evidence for review baseline `f941d94d`. Subsequent fixes for issue #8 and their current validation are recorded in [the M6C review-fix report](./m6c-review-fixes-validation.md).

## Delivered

- `CodexCliAdapter` and operator-selected WNA runtime configuration. Explicit model/scoped credential, isolated runtime home, JSONL completion checks, credential redaction, real Git hashes, a clean worktree and the existing one-parent/shared import contract. A native permission profile extends `:workspace`, allowing only detached linked-worktree metadata and shared Git objects to be written; common refs/config remain read-only. WNA owns the controlled push; the agent does not receive its Git push token.
- Bundle/Patch/Artifact submissions through the signed core API and typed client. Server-pinned project repository, task base and contract; strict fields, canonical base64, 2 MiB decoded payload, 256 artifact operations and the existing 4 MiB HTTP body limit.
- Private Git quarantine and index-based normalization without checkout, archive extraction, hooks, fsmonitor, external diff or network transports. Deterministic patch/artifact commits; bundles advertise exactly one branch and the pinned base as sole parent. Git commands have timeout and output bounds.
- One common six-step validator for all transports. NUL-delimited Git inspection preserves renamed source paths and exact names; full-tree unsafe paths/case collisions and changed-file modes, binary, size, deletion, forbidden/protected and abnormal-change limits are enforced. Inherited baseline symlinks retain the verifier's structured FAIL behavior.
- Migration `0010`: immutable FORCE-RLS source receipts, exact composite binding to verified imports, active lease/epoch trigger, tenant isolation and append-only grants. One payload per lease, exact replay allowed after termination, conflicting replay rejected.
- Final publication under canonical lease/task locking, with active lease, expiry, base and contract rechecks. Receipt persistence failures roll back database records and compensate the isolated ref. Receipt lookup and compensation share the publication lock so concurrent retries cannot lose their committed ref. Lost COMMIT responses reconcile; an unavailable database leaves the isolated ref for retry/recovery.
- Candidate-bound lineage includes the source receipt. All three import forms traverse real candidate creation, three-tier verification, an independent reviewer session, human approval and serialized CAS merge. The existing expiry reconciler handles real uploaded refs when `task.completed` is missing.
- CI clean-install and historical upgrade paths apply `0010` twice; the root regression command includes the M6C-2 acceptance suite.

## Validation

Environment: macOS, Node `v26.3.0`, PostgreSQL `17.10`, real local Git repositories and HTTP servers. Codex CLI `0.167.2` was inspected with `exec --help`; invocation flags were checked against the [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

| Check | Result |
|---|---|
| Final M6C-2 acceptance within the complete regression | 9 passed, 0 failed, 0 skipped with PostgreSQL configured |
| Final WNA environment selection, recovery and expiry targeted rerun | 3 passed, 0 failed |
| Recovery/normalization hardening, including PostgreSQL and retry/compensation race | 3 passed, 0 failed |
| Final native Codex sandbox + WNA rerun after runtime-home cleanup | 2 passed, 0 failed; real sandbox commit succeeds and common ref writes are denied |
| Complete regression (`npm test`, Node 26.3.0) | 111 tests / 12 suites: 108 passed, 3 M5 failures, 0 skipped; command exited 1 |
| Isolated rerun of M5-Gate-2/3/4 after startup delays | 3 passed, 0 failed, 0 skipped on Node 24.16.0 and a separate freshly migrated PostgreSQL database; no code changes between failure and rerun |
| Fresh database migrations `0001`, `0003`–`0010`, then `0002` | Passed, including `0010` reapplication and RLS-T1..T8 |
| Strict lint / TypeScript, secret scan and whitespace | Passed, including final runtime cleanup; 117 lint inputs, 116 secret-scan inputs, 0 findings |

The acceptance suite covers a CLI emulator through real WNA and Git pre-receive; all three import transports through the complete merge path; a malicious-input matrix on memory and PostgreSQL stores; deterministic normalization; receipt persistence failure, lost COMMIT response and concurrent retry/compensation; lease revocation and expiry during normalization; signed HTTP membership, tenant and body limits; and PostgreSQL FORCE RLS, grants and exact receipt bindings.

Reproduce the provider-free native sandbox check with `SF_TEST_CODEX_SANDBOX_BINARY=<installed-codex-path> node --test --test-name-pattern='Codex adapter contract|Codex runtime passes' packages/test-harness/src/m6c-import-adapters.test.ts`. The optional branch runs the same emulator inside Codex's actual `sf-worker` permission profile and asserts that the common Git refs cannot be written. It also verifies private runtime-home removal after parsing. A plain workspace profile was separately confirmed to deny commit creation; the narrow metadata/object grants resolve that incompatibility without enabling common ref writes. See [Codex permission profiles](https://learn.chatgpt.com/docs/permissions).

An initial discovery regression exposed an inherited-symlink compatibility failure in M3; the inspector was corrected and M3-Gate-9 passed separately and in the final run. During that discovery run macOS delayed executable startup for several minutes; a time-sensitive M5 fault test also failed. The obsolete run was stopped and replaced with a clean-database regression. That run also encountered M5-Gate-2/3/4 failures while new Node executables remained at `_dyld_start` for minutes. All three passed together on an isolated Node 24.16.0/PostgreSQL rerun without code changes. Startup delays are the likely cause, not an established application regression; the failed full-run results remain recorded rather than counted as an uninterrupted green run.

The three recorded failures were `UND_ERR_HEADERS_TIMEOUT` (M5-Gate-2), worker `FAILED` instead of `COMPLETED` (M5-Gate-3), and `FENCED_STALE_LEASE` instead of `COMPLETED` (M5-Gate-4). The retry command was `node --test --test-name-pattern='M5-Gate-2 |M5-Gate-3 |M5-Gate-4 ' packages/test-harness/src/m5-acceptance.test.ts`, with PostgreSQL configured against a separate fresh database. Every test has a passing observation across these runs, but there is no claim that the final full command was green. M6C-1 passed 8/8 again; historical database upgrade checks through `0010` also passed.

## Operational Limits & Remaining Scope

No live Codex provider call was made. Runtime tests use an explicit emulator credential, not a real model credential. Independent review in the new import E2E tests uses an injected evaluator while exercising the real reviewer session and approval machinery. Opaque coding-CLI provider calls are not individually metered by the managed model Cost Guard; this report does not claim that additional accounting integration.

Local verifier execution uses the existing honest macOS subprocess fallback. Linux PG16/17 CI is configured but was not run in this session. Git quarantine and process bounds do not establish kernel isolation for hostile bundle decoding or verifier workloads.

M6C-3 remains pending: external target connectors, kernel-isolated verification, Lima/WSL2 backends and production deployment approval. M6C and release gate G7 are not complete. No production deployment or live provider smoke test is claimed.
