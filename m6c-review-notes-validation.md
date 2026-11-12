# Issue #8 — Remaining Review Notes

Baseline: `8de7623` on `main`. This report tracks 9 notes from `f941d94d`, 3 older notes from `038d19a9`, and 2 new notes from the `8de76234` review. Reviewer acceptance remains with the project owner; the completed five-item checklist is not edited.

| Note | Resolution |
|---|---|
| N01 dependency parity | PostgreSQL uses LEFT JOIN and NULL-safe status rejection, matching memory when an upstream is missing; composite FKs remain authoritative. |
| N02 queue completion parity | Both stores validate 40-hex hashes case-insensitively, normalize lowercase and preserve omitted fields. Terminal result bindings are enforced. |
| N03 budget parity | Both stores return events in descending timestamp/ID order; PG post-spend pauses both project and task scopes in the same transaction. |
| N04 queue DB state machine | Migration 0011 permits QUEUED → PROCESSING → terminal only, protects identity and checks result/timestamp/attempt bindings; terminal records cannot be rewritten. |
| N05 import receipt | Lease lookup index plus shared defensive metadata validation in both stores. SQL FK/CHECK/lease trigger still enforce authority and complete bindings. |
| N06 Codex runtime | Credential encoding/clipped-tail redaction and provider-aware fallback; timeout remains explicitly owned by WNA. Native sandbox smoke is a mandatory CI job, independent of the PG jobs. |
| N07 constraint definitions | Migration 0011 verifies 58 original constraint definitions and rejects named impostors. CI applies/reapplies 0011/0012 and invokes the definition probe on clean and all historical upgrade paths. |
| N08 CAS policy | The legacy CAS API is a queue facade. Fresh merges enqueue/claim under the project lock; requests cannot jump older FIFO entries. A private drain context prevents recursive locking. Already-merged reconciliation is read-only with respect to main. |
| N09 Codex costs | Owner explicitly selected fail-closed production blocking until trustworthy Cost Guard metering exists. Only explicit emulator mode with a fixed dummy credential is accepted; no production opt-out environment switch or live-key test mode. |
| 038-FU-A artifact hashes | DB trigger verifies SHA-256 against canonical JSON on INSERT/UPDATE. Canonicalization follows UTF-16 key ordering and JS numeric formatting; read-time integrity verification remains. |
| 038-FU-B custom assertions | Parse, allowlist and reprint AST; permit declared export calls, const data bindings, selected assertions/data expressions. Reject arbitrary export calls, reflection, mutation, shadowing, dynamic code, extra statements and control flow. Candidate code still executes only within the verifier sandbox. |
| 038-FU-C bootstrap recovery | POSIX kernel flock helper releases ownership after helper exit/parent EOF; permanent sidecar inode avoids unlink races. Pending-ref GC is invoked during bootstrap and preserves live owners; it uses ref creation time and SHA-guarded deletion. |
| New-A no active TX | Budget checks open a fresh tenant transaction when no transaction is active; denial remains typed and journals/replays correctly under contention. No anonymous read is elevated to replay privilege. |
| New-B process crash | Migration 0012 adds an immutable FORCE-RLS intent journal without uncommitted-parent FKs. Intent commits before completion registration. Recovery waits for the owning xid to finish, then persists pause/event/ledger and marks completion atomically. Deterministic ledger IDs make replay idempotent. |

## Validation

- Focused remaining-note suite: 5/5 passed on PostgreSQL 17, including process death, queue FIFO, normalization, event ordering, both pause scopes, AST validation, constraint drift, raw SQL artifact hash rejection, and journal replay.
- Native Codex sandbox + WNA smoke: 2/2 passed with the installed Codex 0.167.2 native binary and dummy credential. A follow-up wrapper-path smoke verifies the CI invocation environment.
- Earlier M6C-1 + FIX-01..05 regression: 12/12 passed against real PostgreSQL after journal integration.
- Complete local regression: **120/120 passed, 14 suites, 0 failures, 0 skips** on Node 24.16.0 / PostgreSQL 17.10. The final worker-level production block and its negative test were then checked by rerunning both native Codex/WNA tests: **2/2 passed**.
- Final lint/typecheck/shell syntax: **127 inputs passed**. Secret scan: **126 inputs, 0 leaks**.
- GitHub CI on PostgreSQL 16/17 and the mandatory macOS native sandbox job: pending the main push; the issue comment will record the final run and results.

The first complete discovery run had one failing cross-tenant receipt fixture: explicit metadata validation correctly rejected its stale staging ref before reaching the composite FK. The fixture now supplies a canonical staging ref for its forged target so it still tests and expects the original FK rejection; that assertion was not weakened. Privileged StageArtifact corruption fixtures temporarily disable only the new hash trigger in a transaction and restore it, retaining independent read-time integrity coverage; production INSERT rejection is tested separately.

## Operations and Scope

Apply migrations 0011 and 0012 after 0010. Existing constraint mismatches fail the migration instead of being silently accepted. Artifact hash guards protect new writes; historical artifacts retain read-time verification.

Journal payloads store validated request metadata/hashes and observed violations, not prompts or credentials. Normal completion is awaited. If an external lock delays replay, intent remains PENDING and new executions fail closed. Authorized snapshot/dispatch/preflight paths retry; replay does not run for an in-progress owner xid. A vanished task/cost-session is not fabricated to satisfy FKs; the surviving project keeps denial audit. Rolled-back projects retain their durable journal identity without inventing domain rows. General per-session Cost Guard fallbacks are outside this aggregate-budget mechanism.

Bootstrap requires POSIX flock and a C compiler on the coordinator. A helper is compiled once into a private temporary directory. Lock files persist intentionally and must not be unlinked while in use. Stop old existence-lock coordinators during upgrade. Cleanup skips foreign-host/live owners; it does not claim distributed-filesystem lock semantics where flock is unsupported.

Codex production remains unavailable by explicit owner policy, not declared metered or approved for unbounded spend. No live provider call or provider-cost enforcement claim is made. M6C-3/G7 remain pending. No Rust work is included.
