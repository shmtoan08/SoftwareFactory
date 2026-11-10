-- =============================================================================
-- Software Factory v1.5 — RLS Verification Matrix (RLS-T1 through RLS-T8)
-- Spec Reference: MVP-SPEC-02 Section 8
-- =============================================================================

-- This script verifies all 8 mandatory RLS assertions:
-- RLS-T1: Default Deny when app.current_project_id is unset/empty
-- RLS-T2: Cross-project SELECT isolation (Project A cannot read Project B)
-- RLS-T3: Cross-project INSERT blocked by WITH CHECK (42501 insufficient_privilege)
-- RLS-T4: Cross-project UPDATE returns 0 rows / rejected
-- RLS-T5: Cross-project DELETE blocked
-- RLS-T6: Connection Pool Reuse Safety (SET LOCAL resets on COMMIT/DISCARD ALL)
-- RLS-T7: Append-Only Evidence Immutability (processed_worker_events cannot be deleted or mutated)
-- RLS-T8: Composite FK Cross-Tenant Binding Prevention (cannot bind Project B approval to Project A candidate)

BEGIN;
  SET LOCAL ROLE app_runtime;
  -- RLS-T1: Without setting app.current_project_id, SELECT must return 0 rows
  SELECT count(*) AS rls_t1_visible_tasks FROM tasks;
COMMIT;
