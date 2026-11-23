-- E1 storage foundation. FORCE RLS denies every service until a typed authority
-- migration introduces Cost Guard admission and lease-locked transitions.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_lifecycle_task_scope
 ON telemetry.lifecycles(project_id,lifecycle_id,task_id);

CREATE TABLE IF NOT EXISTS telemetry.dispatch_reservations (
 project_id UUID NOT NULL,
 reservation_id UUID NOT NULL,
 attempt_id UUID NOT NULL,
 logical_invocation_id UUID NOT NULL,
 attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal>0),
 cost_session_id UUID NOT NULL,
 reserved_tokens BIGINT NOT NULL CHECK(reserved_tokens>=0),
 reserved_micro_usd BIGINT NOT NULL CHECK(reserved_micro_usd>=0),
 reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(reserved_at)),
 expires_at TIMESTAMPTZ NOT NULL CHECK(isfinite(expires_at) AND expires_at>reserved_at),
 PRIMARY KEY(project_id,reservation_id),
 UNIQUE(project_id,attempt_id),
 UNIQUE(project_id,logical_invocation_id,attempt_ordinal),
 UNIQUE(project_id,reservation_id,attempt_id),
 FOREIGN KEY(cost_session_id,project_id)
  REFERENCES public.model_cost_sessions(cost_session_id,project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS telemetry.dispatch_attempts (
 project_id UUID NOT NULL,
 attempt_id UUID NOT NULL,
 reservation_id UUID NOT NULL,
 lifecycle_id UUID NOT NULL,
 task_id UUID NOT NULL,
 lease_id UUID NOT NULL,
 lease_epoch BIGINT NOT NULL CHECK(lease_epoch>0),
 execution_ref UUID NOT NULL,
 generation_ref TEXT NOT NULL CHECK(octet_length(generation_ref) BETWEEN 1 AND 128),
 pipeline_session_id UUID,
 route_version TEXT NOT NULL CHECK(octet_length(route_version) BETWEEN 1 AND 128),
 provider TEXT NOT NULL CHECK(provider IN ('anthropic','google','openai')),
 model TEXT NOT NULL CHECK(octet_length(model) BETWEEN 1 AND 128),
 prompt_id TEXT NOT NULL CHECK(octet_length(prompt_id) BETWEEN 1 AND 128),
 prompt_version TEXT NOT NULL CHECK(octet_length(prompt_version) BETWEEN 1 AND 128),
 prompt_hmac_ref TEXT NOT NULL CHECK(prompt_hmac_ref ~ '^[a-f0-9]{64}$'),
 key_version TEXT NOT NULL CHECK(octet_length(key_version) BETWEEN 1 AND 128),
 binding_digest TEXT NOT NULL CHECK(binding_digest ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(project_id,attempt_id),
 FOREIGN KEY(project_id,reservation_id,attempt_id)
  REFERENCES telemetry.dispatch_reservations(project_id,reservation_id,attempt_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,lifecycle_id,task_id)
  REFERENCES telemetry.lifecycles(project_id,lifecycle_id,task_id) ON DELETE RESTRICT,
 FOREIGN KEY(lease_id,project_id,task_id)
  REFERENCES public.task_leases(lease_id,project_id,task_id) ON DELETE RESTRICT,
 FOREIGN KEY(pipeline_session_id,project_id)
  REFERENCES public.product_pipeline_sessions(pipeline_session_id,project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS telemetry.dispatch_events (
 project_id UUID NOT NULL,
 attempt_id UUID NOT NULL,
 sequence INTEGER NOT NULL,
 kind TEXT NOT NULL,
 prior_kind TEXT,
 prior_digest TEXT,
 prior_sequence INTEGER GENERATED ALWAYS AS
  (CASE WHEN sequence>1 THEN sequence-1 END) STORED,
 event_digest TEXT NOT NULL CHECK(event_digest ~ '^[a-f0-9]{64}$'),
 actor_ref NAME NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at)),
 PRIMARY KEY(project_id,attempt_id,sequence),
 UNIQUE(project_id,attempt_id,sequence,kind,event_digest),
 FOREIGN KEY(project_id,attempt_id)
  REFERENCES telemetry.dispatch_attempts(project_id,attempt_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,attempt_id,prior_sequence,prior_kind,prior_digest)
  REFERENCES telemetry.dispatch_events(project_id,attempt_id,sequence,kind,event_digest) ON DELETE RESTRICT,
 CHECK((sequence=1 AND kind='PREPARED' AND prior_kind IS NULL AND prior_digest IS NULL)
    OR (sequence=2 AND kind IN ('DISPATCH_STARTED','CONFIRMED_NOT_SENT') AND prior_kind IS NOT NULL
        AND prior_kind='PREPARED' AND prior_digest IS NOT NULL)
    OR (sequence=3 AND kind='TERMINAL' AND prior_kind IS NOT NULL
        AND prior_kind='DISPATCH_STARTED' AND prior_digest IS NOT NULL))
);

-- No policies and no service grants. Even telemetry_owner cannot read/write
-- rows. Structural validation is independent of the later admission protocol.
DO $$
DECLARE relation_name TEXT;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['dispatch_reservations','dispatch_attempts','dispatch_events'] LOOP
  EXECUTE format('ALTER TABLE telemetry.%I OWNER TO telemetry_owner',relation_name);
  EXECUTE format('ALTER TABLE telemetry.%I ENABLE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('ALTER TABLE telemetry.%I FORCE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('REVOKE ALL ON telemetry.%I FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator',relation_name);
  EXECUTE format('DROP TRIGGER IF EXISTS dispatch_immutable ON telemetry.%I',relation_name);
  EXECUTE format('CREATE TRIGGER dispatch_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.%I
   FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation()',relation_name);
 END LOOP;
END $$;
COMMIT;
