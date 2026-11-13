# M6C-3 — Approved Deployment Reconciliation

Baseline `e6e503a`, reviewed [ĐẠT](https://github.com/shmtoan08/SoftwareFactory/commit/e6e503a2a10d8660c81fd66d582817277173a83a#commitcomment-209699705), with PG16/17 128/128 and both runtime jobs 2/2. This slice extends the approved deployment gate with an evidence-bound recovery API; it does not establish production rollout or G7 acceptance.

## Safety boundary and workflow

The provider verifier is an operator-configured, read-only adapter. It must attest an existing durable terminal fence for the exact deployment UUID: no delayed submission/retry of the old UUID can cause another effect. NOT_FOUND, process death, timeout and an unconfirmed cancellation are not evidence of that fence. This API does not create provider fencing, issue cancellation, deploy or retry. The verifier is disabled by default and no concrete cloud provider adapter is supplied. Providers without a durable fence/tombstone capability remain HOLD.

The project approver previews evidence, then explicitly approves its outcome and evidence SHA-256. A Factory HMAC token with a distinct purpose binds original approval/deployment/project IDs, immutable release/commit/artifact/target/start-time hash, expected execution status, full provider evidence, principal and lifetime. Default TTL is 5 minutes; maximum 15. Only the issuing authenticated approver may execute/revoke; recovery tokens are not delegated to developer sessions. This remains a server-signed record of authenticated consent, not a user-held asymmetric-key or physical-presence protocol.

Execution verifies the signature, snapshot and fresh full provider evidence outside database locks, then atomically consumes approval, appends an immutable reconciliation record and sets the old deployment's reconciled_at. Original status, receipt and consumed deploy approval remain untouched. The partial unique target index releases only this reconciled record; another unresolved deployment is unaffected. A new deployment always needs a separate current release approval. Recovery can close an old deployment even after main advances, because it is not authorization to deploy that old release again.

SUCCEEDED evidence must name the exact approved artifact; NOT_DEPLOYED requires a provider-confirmed terminal fence and null artifact. Failed/malformed/changed evidence, mismatched source status, expiry/revoke or transaction failure leaves HOLD. Concurrent identical execution and lost COMMIT responses reconcile to the same immutable row. Failures before COMMIT roll back approval consumption, audit and hold release together. A late old executor completion is rejected after reconciliation.

## Database authority

Migration 0015 adds FORCE-RLS approvals and append-only final reconciliation tables with composite tenant FKs and strict evidence/transition checks. Runtime receives no UPDATE grant on reconciled_at and no UPDATE/DELETE on final evidence. The narrow AFTER INSERT trigger runs as db_migrator, with fixed search_path/SQL and FORCE RLS still active; it checks Core API project/principal scope. Public/runtime direct execution is revoked. The original deployment trigger permits this single-column change only through the nested evidence trigger and matching appended record; ordinary writes cannot release a hold or alter history. App and SQL validate the same immutable snapshot and provider evidence shape.

Memory mirrors state transitions and undo tracking for emulator tests. Production resolution-verifier configuration forces PostgreSQL even without a deployment executor, and cannot be weakened by requirePostgres=false. No environment or HTTP flag enables the memory emulator mode.

## Validation

- Focused reconciliation suite: **3/3 passed, 0 skips**, Node24.16 / PG17.10. Memory/HTTP/real PostgreSQL cover signed decisions, MAC/purpose misuse, role/issuer/tenant isolation, expiry/revocation, bounded provider lookup, evidence drift, source-status races, concurrent replay, rollback-before-COMMIT and lost-response-after-COMMIT, history preservation, late completion and explicit fresh deployment after recovery.
- Existing deployment gate regression: **4/4 passed** after shared-fixture extraction, retaining its independent process-death and durable-claim coverage.
- Raw SQL rejects forged binding/evidence/outcome/principal, direct hold UPDATE, pending-approval rewrites and final evidence mutations. Catalog/permission probes verify FORCE RLS, owner/search_path/SECURITY DEFINER configuration and denied direct trigger-function execution.
- Full local regression: **131/131 passed, 17 suites, 0 failures/skips** on Node24.16 / PostgreSQL17.10 (~293 seconds). Lint/typecheck/shell syntax: **144 inputs passed**; secret scan: **143 inputs, 0 leaks**.
- Migration 0015 applies/reapplies on clean and historical upgrade paths. Exact source commits, completed CI evidence and reviewer acceptance are tracked in [issue #11](https://github.com/shmtoan08/SoftwareFactory/issues/11).

Tests use local emulators for provider state. They do not demonstrate real cloud fencing or artifact provenance. Real provider adapters must meet the fence contract before enabling this workflow in production. Operator review must map registered target keys consistently to physical targets; changing aliases is not recovery. External Tier 2/3/4 connectors, trust-tier routing, Firecracker/Lima/WSL2, concrete cloud deployment executors and M6C/G7 remain pending. No production or model provider call occurred; Codex production blocking is unchanged.
