-- Stage A3: immutable cohort/lifecycle storage, deliberately no enrollment API.
BEGIN;
CREATE TABLE IF NOT EXISTS telemetry.cohort_manifests (
 manifest_id UUID PRIMARY KEY,
 project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
 contract_ref_hmac TEXT NOT NULL CHECK(contract_ref_hmac ~ '^[a-f0-9]{64}$'),
 key_version TEXT NOT NULL CHECK(octet_length(key_version) BETWEEN 1 AND 128),
 task_size TEXT NOT NULL,
 planned_file_count INTEGER CHECK(planned_file_count>=0),
 planned_package_count INTEGER CHECK(planned_package_count>=0),
 schema_migration BOOLEAN NOT NULL,
 auth_rls BOOLEAN NOT NULL,
 security_isolation BOOLEAN NOT NULL,
 recovery_lease BOOLEAN NOT NULL,
 public_contract BOOLEAN NOT NULL,
 operator_principal TEXT NOT NULL CHECK(octet_length(operator_principal) BETWEEN 1 AND 128),
 approved_at TIMESTAMPTZ NOT NULL CHECK(isfinite(approved_at)),
 source_sha TEXT NOT NULL CHECK(source_sha ~ '^[a-f0-9]{40}$'),
 manifest_version TEXT NOT NULL CHECK(octet_length(manifest_version) BETWEEN 1 AND 128),
 UNIQUE(project_id,manifest_id),
 CHECK(task_size=CASE
   WHEN planned_file_count IS NULL OR planned_package_count IS NULL THEN 'unclassified'
   WHEN planned_file_count<=5 AND planned_package_count<=1 THEN 'S'
   WHEN planned_file_count<=20 AND planned_package_count<=3 THEN 'M'
   ELSE 'L' END)
);
CREATE TABLE IF NOT EXISTS telemetry.lifecycles (
 lifecycle_id UUID PRIMARY KEY,
 project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
 task_id UUID NOT NULL,
 manifest_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 UNIQUE(project_id,task_id),
 UNIQUE(project_id,lifecycle_id),
 UNIQUE(project_id,manifest_id),
 FOREIGN KEY(task_id,project_id) REFERENCES public.tasks(task_id,project_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,manifest_id) REFERENCES telemetry.cohort_manifests(project_id,manifest_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS telemetry.lifecycle_events (
 event_id UUID PRIMARY KEY,
 project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
 lifecycle_id UUID NOT NULL,
 sequence BIGINT NOT NULL CHECK(sequence>0),
 kind TEXT NOT NULL CHECK(kind IN ('OPEN','AMEND','CLOSE','REOPEN','CENSOR')),
 outcome TEXT CHECK(outcome IN ('success','failed','abandoned','cancelled')),
 service_actor_ref TEXT NOT NULL CHECK(octet_length(service_actor_ref) BETWEEN 1 AND 128),
 observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(observed_at)),
 cutoff_at TIMESTAMPTZ CHECK(isfinite(cutoff_at)),
 prior_sequence BIGINT,
 prior_event_digest TEXT CHECK(prior_event_digest ~ '^[a-f0-9]{64}$'),
 event_digest TEXT NOT NULL CHECK(event_digest ~ '^[a-f0-9]{64}$'),
 UNIQUE(project_id,lifecycle_id,sequence),
 UNIQUE(project_id,lifecycle_id,sequence,event_digest),
 FOREIGN KEY(project_id,lifecycle_id) REFERENCES telemetry.lifecycles(project_id,lifecycle_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,lifecycle_id,prior_sequence,prior_event_digest)
   REFERENCES telemetry.lifecycle_events(project_id,lifecycle_id,sequence,event_digest) ON DELETE RESTRICT,
 CHECK((sequence=1 AND kind='OPEN' AND prior_sequence IS NULL AND prior_event_digest IS NULL)
    OR (sequence>1 AND kind<>'OPEN' AND prior_sequence IS NOT NULL
        AND prior_sequence=sequence-1 AND prior_event_digest IS NOT NULL)),
 CHECK((kind='CLOSE' AND outcome IS NOT NULL) OR (kind<>'CLOSE' AND outcome IS NULL)),
 CHECK((kind='CENSOR' AND cutoff_at IS NOT NULL AND cutoff_at<=observed_at)
    OR (kind<>'CENSOR' AND cutoff_at IS NULL))
);
-- These tables have no policies or grants. Schema constraints are structural,
-- not proof of pre-run enrollment, terminal settlement, coverage or event authority.
-- Typed lifecycle services must prove those before a later migration opens access.
ALTER TABLE telemetry.cohort_manifests OWNER TO telemetry_owner;
ALTER TABLE telemetry.cohort_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.cohort_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE telemetry.lifecycles OWNER TO telemetry_owner;
ALTER TABLE telemetry.lifecycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.lifecycles FORCE ROW LEVEL SECURITY;
ALTER TABLE telemetry.lifecycle_events OWNER TO telemetry_owner;
ALTER TABLE telemetry.lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.lifecycle_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON telemetry.cohort_manifests,telemetry.lifecycles,telemetry.lifecycle_events
 FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
DROP TRIGGER IF EXISTS telemetry_manifest_immutable ON telemetry.cohort_manifests;
CREATE TRIGGER telemetry_manifest_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.cohort_manifests
 FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();
DROP TRIGGER IF EXISTS telemetry_lifecycle_immutable ON telemetry.lifecycles;
CREATE TRIGGER telemetry_lifecycle_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.lifecycles
 FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();
DROP TRIGGER IF EXISTS telemetry_lifecycle_event_immutable ON telemetry.lifecycle_events;
CREATE TRIGGER telemetry_lifecycle_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.lifecycle_events
 FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();
-- A2 review210565014: reject invalid provider/HMAC uniformly before INSERT.
CREATE OR REPLACE FUNCTION telemetry.register_call(
 p_invocation UUID,p_project UUID,p_cost_session UUID,p_task UUID,p_pipeline UUID,
 p_provider TEXT,p_model TEXT,p_prompt TEXT,p_version TEXT,p_prompt_hmac TEXT,p_key_version TEXT,p_mapping TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_digest TEXT; v_existing TEXT;
BEGIN
 IF NOT telemetry.authorized(p_project,'ingest') THEN
   RAISE EXCEPTION 'Telemetry access denied' USING ERRCODE='42501';
 END IF;
 IF p_invocation IS NULL OR p_cost_session IS NULL OR p_provider IS NULL OR p_model IS NULL
   OR p_prompt IS NULL OR p_version IS NULL OR p_prompt_hmac IS NULL OR p_key_version IS NULL OR p_mapping IS NULL
   OR p_provider NOT IN ('anthropic','openai','google') OR p_prompt_hmac !~ '^[a-f0-9]{64}$'
   OR octet_length(p_model)>128 OR octet_length(p_prompt)>128 OR octet_length(p_version)>128
   OR octet_length(p_key_version)>128 OR octet_length(p_mapping)>128 OR octet_length(p_prompt_hmac)<>64 THEN
   RAISE EXCEPTION 'Invalid telemetry call' USING ERRCODE='22023';
 END IF;
 v_digest:=encode(public.digest(convert_to(jsonb_build_array('telemetry-call-v1',p_invocation,p_project,p_cost_session,p_task,p_pipeline,p_provider,p_model,p_prompt,p_version,p_prompt_hmac,p_key_version,p_mapping)::text,'UTF8'),'sha256'),'hex');
 INSERT INTO telemetry.invocations(invocation_id,project_id,cost_session_id,task_id,pipeline_session_id,binding_state,binding_reason,provider,model,prompt_id,prompt_version,prompt_hmac_ref,key_version,mapping_id,binding_digest)
 VALUES(p_invocation,p_project,p_cost_session,p_task,p_pipeline,'CALL_ONLY','execution-authority-unavailable',p_provider,p_model,p_prompt,p_version,p_prompt_hmac,p_key_version,p_mapping,v_digest)
 ON CONFLICT(invocation_id) DO NOTHING;
 SELECT binding_digest INTO v_existing FROM telemetry.invocations WHERE invocation_id=p_invocation AND project_id=p_project;
 IF v_existing IS DISTINCT FROM v_digest THEN
   RAISE EXCEPTION 'Telemetry invocation conflict' USING ERRCODE='23505';
 END IF;
 RETURN p_invocation;
END $$;
ALTER FUNCTION telemetry.register_call(UUID,UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.register_call(UUID,UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC,app_runtime,telemetry_reporter,telemetry_operator;
GRANT USAGE ON SCHEMA telemetry TO telemetry_ingestor,telemetry_reporter;
GRANT EXECUTE ON FUNCTION telemetry.register_call(UUID,UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO telemetry_ingestor;

COMMIT;
