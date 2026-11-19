# T1 B3 — real pipeline / observer / PostgreSQL integration

This test slice exercises `ProductPipelineService.intakeAndExtractStage1` with the real PostgreSQL repository, Cost Guard, optional observer and authenticated SQL delivery. The model client is an in-process deterministic fixture: no HTTP, paid provider or runtime activation.

## Evidence

`npm run test:telemetry:pipeline` requires the migrated PostgreSQL test database. It clones that database, provisions a dedicated telemetry login and registry entry, and removes the clone/login on completion. Missing PostgreSQL configuration produces an explicit skip; CI PostgreSQL jobs must run without skips.

Eight executions compare commit and injected TX2 rollback under four configurations: observer absent, SQL delivery, unavailable telemetry database, and registration deliberately delayed until TX2 holds the cost-session row lock.

The artifact-storage barrier holds the actual TX2 after `commitAllowedLedger`. With registration already delivered during the fixture provider call, reconciliation sees the candidate as pending and no ledger is externally visible. Commit yields one settlement linked to the durable ALLOWED ledger. Rollback leaves the abandoned candidate pending and links only the compensating FAILED_VALIDATION ledger. Reconciliation replay returns duplicate for the durable ledger, without quality mismatch markers.

Every execution asserts exactly one provider call and one durable business ledger, three billed tokens, session cost equal to ledger cost, and the expected artifact count (one on success, zero on rollback). The business summaries match the observer-absent baseline even when delivery fails.

## Observed coverage limitation

Registration arriving during TX2 can contend on the cost-session foreign-key check. The SQL delivery lock deadline rejects that batch; the observer drops it without retry. The late-registration fixture verifies zero persisted invocations/settlements and unchanged business outcome and billing. This is intentional lossy observation, **not complete call coverage**. The test's provider barrier establishes the early-registration schedule only for visibility assertions; production execution does not wait for telemetry.

No production wiring, provider mappings, protected-template verification, canonical usage, TASK_BOUND eligibility, lifecycle completion, reports or gate approval are added. Stage 1 represents the real TX2 transaction path; this does not claim end-to-end coverage of every pipeline stage or provider.

Local validation: PostgreSQL 17, combined B1/B2/B3 tests 14 passed, zero failed/skipped. Full PostgreSQL 16/17 regression remains tracked by CI on the merged source SHA.
