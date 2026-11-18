-- Stage A2: operator-provisioned database login -> project capability binding.
-- No login, membership, binding row or application runtime hook is provisioned here.
BEGIN;
CREATE TABLE IF NOT EXISTS telemetry.service_projects (
  principal_oid OID NOT NULL,
  principal_name NAME NOT NULL,
  project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
  capability TEXT NOT NULL CHECK(capability IN ('ingest','read')),
  PRIMARY KEY(principal_oid,project_id,capability)
);
ALTER TABLE telemetry.service_projects OWNER TO telemetry_owner;
ALTER TABLE telemetry.service_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.service_projects FORCE ROW LEVEL SECURITY;
REVOKE ALL ON telemetry.service_projects FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
-- Only the non-login function owner can examine the operator-maintained registry.
DROP POLICY IF EXISTS telemetry_registry_owner ON telemetry.service_projects;
CREATE POLICY telemetry_registry_owner ON telemetry.service_projects FOR SELECT TO telemetry_owner USING(true);

CREATE OR REPLACE FUNCTION telemetry.authorized(p_project UUID,p_capability TEXT) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_roles r JOIN telemetry.service_projects s
      ON s.principal_oid=r.oid AND s.principal_name=r.rolname
    WHERE r.rolname=session_user AND r.rolcanlogin AND NOT r.rolsuper
      AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolbypassrls
      AND NOT pg_catalog.pg_has_role(r.oid,'app_runtime','MEMBER')
      AND pg_catalog.pg_has_role(r.oid,CASE p_capability WHEN 'ingest' THEN 'telemetry_ingestor' ELSE 'telemetry_reporter' END,'MEMBER')
      AND s.project_id=p_project AND s.capability=p_capability
      AND p_capability IN ('ingest','read'));
$$;
ALTER FUNCTION telemetry.authorized(UUID,TEXT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.authorized(UUID,TEXT) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
DROP POLICY IF EXISTS telemetry_invocation_service_select ON telemetry.invocations;
CREATE POLICY telemetry_invocation_service_select ON telemetry.invocations FOR SELECT TO telemetry_owner
USING(telemetry.authorized(project_id,'ingest') OR telemetry.authorized(project_id,'read'));
DROP POLICY IF EXISTS telemetry_invocation_service_insert ON telemetry.invocations;
CREATE POLICY telemetry_invocation_service_insert ON telemetry.invocations FOR INSERT TO telemetry_owner
WITH CHECK(telemetry.authorized(project_id,'ingest'));

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

-- Bounded metadata reader deliberately excludes protected prompt fingerprints/digests.
CREATE OR REPLACE FUNCTION telemetry.read_calls(p_project UUID,p_after TIMESTAMPTZ DEFAULT NULL,p_after_id UUID DEFAULT NULL,p_limit INTEGER DEFAULT 25)
RETURNS TABLE(invocation_id UUID,created_at TIMESTAMPTZ,binding_state TEXT,provider TEXT,model TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT telemetry.authorized(p_project,'read') THEN RAISE EXCEPTION 'Telemetry access denied' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR ((p_after IS NULL)<>(p_after_id IS NULL)) THEN
   RAISE EXCEPTION 'Invalid telemetry page' USING ERRCODE='22023';
 END IF;
 RETURN QUERY SELECT i.invocation_id,i.created_at,i.binding_state,i.provider,i.model FROM telemetry.invocations i
 WHERE i.project_id=p_project AND (p_after IS NULL OR (i.created_at,i.invocation_id)<(p_after,p_after_id))
 ORDER BY i.created_at DESC,i.invocation_id DESC LIMIT p_limit;
END $$;
ALTER FUNCTION telemetry.read_calls(UUID,TIMESTAMPTZ,UUID,INTEGER) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.read_calls(UUID,TIMESTAMPTZ,UUID,INTEGER) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_operator;
GRANT EXECUTE ON FUNCTION telemetry.read_calls(UUID,TIMESTAMPTZ,UUID,INTEGER) TO telemetry_reporter;
COMMIT;
