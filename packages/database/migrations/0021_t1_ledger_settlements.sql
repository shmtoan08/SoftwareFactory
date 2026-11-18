-- Stage A5: explicit call-level ledger links, no ledger mutation or runtime hook.
BEGIN;
-- The non-login function owner can read only identity/outcome columns. No prompt
-- hashes, raw errors, requests or usage/cost fields are needed or granted.
GRANT SELECT(call_id,project_id,cost_session_id,pipeline_session_id,task_id,provider,model,prompt_id,prompt_version,status)
 ON public.model_call_ledgers TO telemetry_owner;
-- Legacy SELECT policy applies to PUBLIC and trusts app GUCs. A restrictive policy
-- is essential: permissive policies OR together, while this guard ANDs for owner.
DROP POLICY IF EXISTS telemetry_ledger_select ON public.model_call_ledgers;
CREATE POLICY telemetry_ledger_select ON public.model_call_ledgers FOR SELECT TO telemetry_owner
 USING(telemetry.authorized(project_id,'ingest'));
DROP POLICY IF EXISTS telemetry_ledger_guard ON public.model_call_ledgers;
CREATE POLICY telemetry_ledger_guard ON public.model_call_ledgers AS RESTRICTIVE FOR SELECT TO telemetry_owner
 USING(telemetry.authorized(project_id,'ingest'));
CREATE TABLE IF NOT EXISTS telemetry.settlements (
 settlement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
 invocation_id UUID NOT NULL,
 ledger_call_id UUID NOT NULL REFERENCES public.model_call_ledgers(call_id) ON DELETE RESTRICT,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at)),
 ledger_outcome TEXT NOT NULL CHECK(ledger_outcome IN ('ALLOWED','BLOCKED_PREFLIGHT','BLOCKED_POSTCALL','FAILED_VALIDATION','FAILED_PROVIDER')),
 settlement_digest TEXT NOT NULL CHECK(settlement_digest ~ '^[a-f0-9]{64}$'),
 UNIQUE(project_id,invocation_id),
 UNIQUE(project_id,ledger_call_id),
 FOREIGN KEY(project_id,invocation_id) REFERENCES telemetry.invocations(project_id,invocation_id) ON DELETE RESTRICT
);
ALTER TABLE telemetry.settlements OWNER TO telemetry_owner;
ALTER TABLE telemetry.settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.settlements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON telemetry.settlements FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
DROP POLICY IF EXISTS settlement_service_select ON telemetry.settlements;
CREATE POLICY settlement_service_select ON telemetry.settlements FOR SELECT TO telemetry_owner USING(telemetry.authorized(project_id,'ingest'));
DROP POLICY IF EXISTS settlement_service_insert ON telemetry.settlements;
CREATE POLICY settlement_service_insert ON telemetry.settlements FOR INSERT TO telemetry_owner WITH CHECK(telemetry.authorized(project_id,'ingest'));
DROP TRIGGER IF EXISTS telemetry_settlement_immutable ON telemetry.settlements;
CREATE TRIGGER telemetry_settlement_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.settlements
 FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_quality_link_dedup ON telemetry.quality_events(project_id,invocation_id,conflict_digest)
 WHERE category='ledger-link-mismatch';

CREATE OR REPLACE FUNCTION telemetry.link_ledger(p_project UUID,p_invocation UUID,p_ledger UUID)
RETURNS TABLE(settlement_id UUID,disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i RECORD; l RECORD; v_digest TEXT; v_id UUID; v_existing TEXT; v_count INTEGER;
BEGIN
 IF NOT telemetry.authorized(p_project,'ingest') THEN RAISE EXCEPTION 'Telemetry access denied' USING ERRCODE='42501'; END IF;
 IF p_invocation IS NULL OR p_ledger IS NULL THEN RAISE EXCEPTION 'Invalid telemetry link' USING ERRCODE='22023'; END IF;
 SELECT * INTO i FROM telemetry.invocations WHERE project_id=p_project AND invocation_id=p_invocation;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid telemetry invocation' USING ERRCODE='22023'; END IF;
 SELECT call_id,project_id,cost_session_id,pipeline_session_id,task_id,provider,model,prompt_id,prompt_version,status
 INTO l FROM public.model_call_ledgers WHERE project_id=p_project AND call_id=p_ledger;
 IF NOT FOUND OR l.cost_session_id IS DISTINCT FROM i.cost_session_id
 OR l.pipeline_session_id IS DISTINCT FROM i.pipeline_session_id OR l.task_id IS DISTINCT FROM i.task_id
 OR l.provider IS DISTINCT FROM i.provider OR l.model IS DISTINCT FROM i.model
 OR l.prompt_id IS DISTINCT FROM i.prompt_id OR l.prompt_version IS DISTINCT FROM i.prompt_version THEN
  v_digest:=encode(public.digest(convert_to(jsonb_build_array('telemetry-link-mismatch-v1',p_project,p_invocation,p_ledger)::text,'UTF8'),'sha256'),'hex');
  INSERT INTO telemetry.quality_events(project_id,invocation_id,category,conflict_digest)
  VALUES(p_project,p_invocation,'ledger-link-mismatch',v_digest) ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT NULL::uuid,'mismatch'::text;
  RETURN;
 END IF;
 -- Digest binds the immutable invocation (including protected prompt reference)
 -- and ledger identity/outcome. Prompt id/version equality is not HMAC verification.
 v_digest:=encode(public.digest(convert_to(jsonb_build_array('telemetry-settlement-v1',p_project,p_invocation,p_ledger,i.binding_digest,l.cost_session_id,l.pipeline_session_id,l.task_id,l.provider,l.model,l.prompt_id,l.prompt_version,l.status)::text,'UTF8'),'sha256'),'hex');
 INSERT INTO telemetry.settlements(project_id,invocation_id,ledger_call_id,ledger_outcome,settlement_digest)
 VALUES(p_project,p_invocation,p_ledger,l.status,v_digest) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 SELECT s.settlement_id,s.settlement_digest INTO v_id,v_existing FROM telemetry.settlements s WHERE s.project_id=p_project AND s.invocation_id=p_invocation;
 IF v_existing IS DISTINCT FROM v_digest THEN
  INSERT INTO telemetry.quality_events(project_id,invocation_id,category,conflict_digest)
  VALUES(p_project,p_invocation,'ledger-link-mismatch',v_digest) ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT NULL::uuid,'conflict'::text;
 ELSE
  RETURN QUERY SELECT v_id,CASE WHEN v_count=1 THEN 'recorded' ELSE 'duplicate' END;
 END IF;
END $$;
ALTER FUNCTION telemetry.link_ledger(UUID,UUID,UUID) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.link_ledger(UUID,UUID,UUID) FROM PUBLIC,app_runtime,telemetry_reporter,telemetry_operator;
GRANT EXECUTE ON FUNCTION telemetry.link_ledger(UUID,UUID,UUID) TO telemetry_ingestor;
COMMIT;
