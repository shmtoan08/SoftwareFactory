-- =============================================================================
-- Software Factory v1.5 — Milestone M3: Candidate Snapshot & 3-Tier Verifier Tiers
-- Spec Reference: MVP-SPEC-04 Sections 1 & 2, Roadmap Milestone M3
-- Additive migration extending `merge_candidates` & `verification_runs`.
-- =============================================================================

-- 1. Extend merge_candidates with immutable .tar snapshot metadata & retention class
ALTER TABLE merge_candidates
  ADD COLUMN IF NOT EXISTS snapshot_path TEXT NULL,
  ADD COLUMN IF NOT EXISTS snapshot_sha256 CHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS snapshot_size_bytes BIGINT NULL,
  ADD COLUMN IF NOT EXISTS snapshot_retention_class TEXT NOT NULL DEFAULT 'EPHEMERAL_14D';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_mc_snapshot_size_nonneg'
  ) THEN
    ALTER TABLE merge_candidates
      ADD CONSTRAINT chk_mc_snapshot_size_nonneg
      CHECK (snapshot_size_bytes IS NULL OR snapshot_size_bytes >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_mc_snapshot_sha256_hex'
  ) THEN
    ALTER TABLE merge_candidates
      ADD CONSTRAINT chk_mc_snapshot_sha256_hex
      CHECK (snapshot_sha256 IS NULL OR snapshot_sha256 ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_mc_snapshot_retention_class'
  ) THEN
    ALTER TABLE merge_candidates
      ADD CONSTRAINT chk_mc_snapshot_retention_class
      CHECK (snapshot_retention_class IN ('EPHEMERAL_14D', 'MERGED_PERMANENT'));
  END IF;
END
$$;

-- 2. Extend verification_runs with 3-tier execution results, tamper status,
--    infra retry counter, honest execution backend, and isolation guarantees.
ALTER TABLE verification_runs
  ADD COLUMN IF NOT EXISTS overall_status TEXT NOT NULL DEFAULT 'PASSED',
  ADD COLUMN IF NOT EXISTS tier1_trusted_acceptance_passed BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS tier2_protected_baseline_passed BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS tier2_baseline_tamper_detected BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tampered_baseline_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tier3_agent_tests_passed BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS tier3_assertions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS infra_retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_backend TEXT NOT NULL DEFAULT 'docker',
  ADD COLUMN IF NOT EXISTS hermetic_network_disabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS hardlink_cache_forbidden BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS is_docker_isolated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trusted_policy_sha256 CHAR(64) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_vr_overall_status'
  ) THEN
    ALTER TABLE verification_runs
      ADD CONSTRAINT chk_vr_overall_status
      CHECK (
        overall_status IN (
          'PASSED',
          'FAILED_ACCEPTANCE',
          'TEST_TAMPERING_DETECTED',
          'TEST_TIMEOUT',
          'INFRA_ERROR'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_vr_infra_retry_nonneg'
  ) THEN
    ALTER TABLE verification_runs
      ADD CONSTRAINT chk_vr_infra_retry_nonneg
      CHECK (infra_retry_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_vr_execution_backend'
  ) THEN
    ALTER TABLE verification_runs
      ADD CONSTRAINT chk_vr_execution_backend
      CHECK (execution_backend IN ('docker', 'linux-supervisor', 'host-subprocess'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_vr_trusted_policy_sha256_hex'
  ) THEN
    ALTER TABLE verification_runs
      ADD CONSTRAINT chk_vr_trusted_policy_sha256_hex
      CHECK (trusted_policy_sha256 IS NULL OR trusted_policy_sha256 ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_vr_pass_consistency'
  ) THEN
    ALTER TABLE verification_runs
      ADD CONSTRAINT chk_vr_pass_consistency
      CHECK (
        (
          verdict = 'PASS'
          AND overall_status = 'PASSED'
          AND tier2_baseline_tamper_detected = FALSE
          AND tier1_trusted_acceptance_passed IS DISTINCT FROM FALSE
          AND tier2_protected_baseline_passed IS DISTINCT FROM FALSE
        )
        OR verdict = 'FAIL'
      );
  END IF;
END
$$;
