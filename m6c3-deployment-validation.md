# M6C-3 — Signed Production Deployment Gate

Baseline: `7edf453` on main. Its CI #43348718857 passed all four jobs. [Team review of 7edf453](https://github.com/shmtoan08/SoftwareFactory/commit/7edf45398045bde80d065ead2fbeeb7e5b443efc#commitcomment-209696069) is **ĐẠT**, with no blocking issues. Its optional token-permission wording note is addressed in README and the verifier report.

## Implemented boundary

The gate is disabled until an operator supplies an explicit stable signing key and a target-keyed executor registry. Production executors require PostgreSQL (including when requirePostgres=false is requested); memory execution requires the explicit in-process testOnlyEmulator flag and is only for provider-free unit tests, with no environment switch. No cloud backend, credential or automatic production deployment is included. It protects this execution entry point; it does not govern out-of-band operator deployments.

An authenticated PROJECT_APPROVER/ORG_ADMIN approves the exact accepted Stage 9 release, package SHA-256, live Git main commit, artifact SHA-256, target and lifetime (15-minute default, one-hour maximum). HMAC-SHA256 binds the authenticated principal and one approval UUID as well. The approval token is returned to the approver; only its SHA-256 is persisted. This is a Factory-signed record of an authenticated approver action, not a user-held signing-key or physical-presence protocol.

The execution API accepts only approval ID/token. Core API rechecks project authorization, signature, exact durable binding and release/main. A transactional, row-locked claim consumes approval and creates RUNNING evidence; its transaction must commit before the operator backend is invoked. Nested outer transactions are rejected. Replays read existing state rather than redispatching. A project/target partial unique index holds both RUNNING and UNKNOWN outcomes, including against a different approval. Revocation races serialize on the approval row.

The backend receives a frozen action (deployment UUID, project, release/package/commit/artifact/target) plus AbortSignal. Provider configuration/credentials belong to the operator backend, not request bodies or task context. The backend must verify artifact bytes and provenance, use the deployment UUID as its provider idempotency key and return a SHA-256 receipt. Real artifact-building/provenance and cloud execution are not established by the test executor.

Timeout/error/invalid receipt becomes UNKNOWN without exposing provider error text. A crash before terminal recording leaves RUNNING. No automatic redispatch, unlock, compensation, or exactly-once physical side-effect guarantee is claimed. There is deliberately no force-unlock HTTP route in this slice: unresolved targets hold until a separately implemented, evidence-bound operator reconciliation workflow is available. Concrete cloud executors and that recovery workflow are still needed before production rollout.

## Database and audit

Migration 0014 adds composite tenant-bound FKs, immutable approval bindings, single-use transition guards, terminal-only deployment updates, a unique approval per deployment and unresolved target exclusion. Approver/requester principals must match the authenticated database session; approval issuance also requires project approver membership. Both tables FORCE RLS and restrict mutation to the Core API role and narrow status/receipt columns. No DELETE or identity UPDATE grants are added. Core store transitions and outbox audit commit together; signatures and raw backend errors are absent from audit payloads.

The memory implementation mirrors the gate and uses transaction undo tracking. PostgreSQL uses real row locks/unique constraints. Application role checks are enforced at Core API entry points; only trusted in-process code has access to the signing service and executor registry.

## Verification

- Focused suite: 4/4 passed on Node 24 / PostgreSQL 17 before final regression. Memory, HTTP and real PG cover role denial, disabled configuration, MAC tampering, wrong approval/project, strict request fields, nested TX rejection, concurrent replay, target exclusion, expiry/revocation, live-main drift, unknown outcomes, timeout, lost terminal persistence and restart. A separate Node process exits during executor dispatch after claim commit; the durable RUNNING row remains and a retry does not invoke a backend.
- SQL probes cover RLS invisibility, cross-project reads, principal impersonation rejection, append-only grants and immutable/terminal transitions. Test release prerequisites are seeded through existing trusted store methods; the suite does not claim to repeat real cloud deployment or artifact provenance validation.
- Full local regression: **128/128 passed, 16 suites, 0 failures, 0 skips** on Node 24.16.0 / PostgreSQL 17.10 (~302 seconds). Final request-ID and durable-store guards were then checked by rerunning the focused deployment suite: **4/4 passed**. Lint/typecheck/shell syntax: **138 inputs passed**; secret scan: **137 inputs, 0 leaks**.
- Migration 0014 was applied twice in clean and historical upgrade paths on both PostgreSQL versions. Completed [source CI #43352652066](https://github.com/shmtoan08/SoftwareFactory/actions/runs/43352652066) on `c19c0eb` and [follow-up CI #43352911192](https://github.com/shmtoan08/SoftwareFactory/actions/runs/43352911192) on `f7f137a` both passed all four jobs. Logs from the follow-up show **128/128, 16 suites, 0 skips** on each PG16/17 job, **2/2 real gVisor** and **2/2 native Codex**, with no failures/skips. Review and subsequent CI evidence: [issue #10](https://github.com/shmtoan08/SoftwareFactory/issues/10).

No live model or production API call occurred. Existing Codex production blocking and gVisor policy remain. Tier 2/3/4 execution connectors, trust-tier routing, Firecracker, Lima/WSL2 and M6C/G7 acceptance remain pending.
