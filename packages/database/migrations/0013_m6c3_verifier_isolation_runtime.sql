-- Selected runtime is evidence of configuration; tier outcomes say what executed.
-- Historical verifications retain NULL, never backfilled as kernel-isolated.
BEGIN;
ALTER TABLE verification_runs ADD COLUMN IF NOT EXISTS isolation_runtime TEXT NULL;
ALTER TABLE verification_runs DROP CONSTRAINT IF EXISTS chk_vr_runsc_binding;
ALTER TABLE verification_runs ADD CONSTRAINT chk_vr_runsc_binding CHECK (
  isolation_runtime IS NULL OR (
    isolation_runtime = 'runsc' AND execution_backend = 'docker'
    AND is_docker_isolated AND hermetic_network_disabled
    AND verifier_image_digest ~ '^sha256:[a-f0-9]{64}$'
  )
);
COMMIT;
