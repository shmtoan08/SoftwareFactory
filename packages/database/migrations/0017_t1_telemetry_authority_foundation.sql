-- T1 stage A1: isolated storage/role boundary. No runtime enrollment or writer API.
-- Dedicated login credentials and trusted service bindings are operator provisioning,
-- not this migration. Role groups deliberately start NOLOGIN, with no members.
BEGIN;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['telemetry_owner','telemetry_ingestor','telemetry_reporter','telemetry_operator'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',r);
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit))
      OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member WHERE p.rolname=r OR c.rolname=r) THEN
      RAISE EXCEPTION 'Telemetry role collision or unexpected membership' USING ERRCODE='42501';
    END IF;
  END LOOP;
END $$;
CREATE SCHEMA IF NOT EXISTS telemetry AUTHORIZATION telemetry_owner;
DO $$ BEGIN
  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='telemetry') <> 'telemetry_owner' THEN
    RAISE EXCEPTION 'Telemetry schema owner mismatch' USING ERRCODE='42501';
  END IF;
END $$;
REVOKE ALL ON SCHEMA telemetry FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
-- No policies/grants yet: FORCE RLS is deny-all even for owner. Service functions
-- and role-bound project authority must be independently reviewed before opening it.
CREATE TABLE IF NOT EXISTS telemetry.invocations (
  invocation_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
  task_id UUID NULL,
  cost_session_id UUID NOT NULL,
  pipeline_session_id UUID NULL,
  binding_state TEXT NOT NULL CHECK(binding_state='CALL_ONLY'),
  binding_reason TEXT NOT NULL CHECK(binding_reason IN ('execution-authority-unavailable','observer-coverage-unproven')),
  provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai','google')),
  model TEXT NOT NULL CHECK(octet_length(model) BETWEEN 1 AND 128),
  prompt_id TEXT NOT NULL CHECK(octet_length(prompt_id) BETWEEN 1 AND 128),
  prompt_version TEXT NOT NULL CHECK(octet_length(prompt_version) BETWEEN 1 AND 128),
  prompt_hmac_ref TEXT NOT NULL CHECK(prompt_hmac_ref ~ '^[a-f0-9]{64}$'),
  key_version TEXT NOT NULL CHECK(octet_length(key_version) BETWEEN 1 AND 128),
  mapping_id TEXT NOT NULL CHECK(octet_length(mapping_id) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  binding_digest TEXT NOT NULL CHECK(binding_digest ~ '^[a-f0-9]{64}$'),
  UNIQUE(project_id,invocation_id),
  FOREIGN KEY(task_id,project_id) REFERENCES public.tasks(task_id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY(cost_session_id,project_id) REFERENCES public.model_cost_sessions(cost_session_id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY(pipeline_session_id,project_id) REFERENCES public.product_pipeline_sessions(pipeline_session_id,project_id) ON DELETE RESTRICT
);
ALTER TABLE telemetry.invocations OWNER TO telemetry_owner;
ALTER TABLE telemetry.invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.invocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON telemetry.invocations FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
CREATE INDEX IF NOT EXISTS telemetry_invocations_project_created ON telemetry.invocations(project_id,created_at,invocation_id);
CREATE OR REPLACE FUNCTION telemetry.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Telemetry observations are immutable' USING ERRCODE='42501';
END $$;
ALTER FUNCTION telemetry.reject_mutation() OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.reject_mutation() FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
DROP TRIGGER IF EXISTS telemetry_invocation_immutable ON telemetry.invocations;
CREATE TRIGGER telemetry_invocation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.invocations
FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();
COMMIT;
