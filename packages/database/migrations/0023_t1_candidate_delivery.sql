-- Observer staging only, not an authoritative dispatch/in-flight inventory.
BEGIN;
CREATE OR REPLACE FUNCTION telemetry.assert_ingestor(p_project UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT telemetry.authorized(p_project,'ingest') THEN RAISE EXCEPTION 'Telemetry access denied' USING ERRCODE='42501'; END IF;
 -- Reject misprovisioned service logins, including NOINHERIT memberships that
 -- could SET ROLE to a ledger writer before calling this function in the same TX.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role(session_user,r.oid,'MEMBER')
   AND (pg_catalog.has_any_column_privilege(r.oid,'public.model_call_ledgers','INSERT,UPDATE')
     OR pg_catalog.has_table_privilege(r.oid,'public.model_call_ledgers','DELETE,TRUNCATE'))) THEN
  RAISE EXCEPTION 'Telemetry service has business write authority' USING ERRCODE='42501';
 END IF;
END $$;
ALTER FUNCTION telemetry.assert_ingestor(UUID) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.assert_ingestor(UUID) FROM PUBLIC,app_runtime,telemetry_reporter,telemetry_operator;
GRANT EXECUTE ON FUNCTION telemetry.assert_ingestor(UUID) TO telemetry_ingestor;
CREATE TABLE IF NOT EXISTS telemetry.ledger_candidates (
 candidate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
 invocation_id UUID NOT NULL,
 ledger_call_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 candidate_digest TEXT NOT NULL CHECK(candidate_digest ~ '^[a-f0-9]{64}$'),
 UNIQUE(project_id,candidate_id),
 UNIQUE(project_id,invocation_id,ledger_call_id),
 FOREIGN KEY(project_id,invocation_id) REFERENCES telemetry.invocations(project_id,invocation_id) ON DELETE RESTRICT
 -- No ledger FK: the observed candidate may still be uncommitted or rolled back.
);
ALTER TABLE telemetry.ledger_candidates OWNER TO telemetry_owner;
ALTER TABLE telemetry.ledger_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.ledger_candidates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON telemetry.ledger_candidates FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
DROP POLICY IF EXISTS candidate_select ON telemetry.ledger_candidates;
CREATE POLICY candidate_select ON telemetry.ledger_candidates FOR SELECT TO telemetry_owner USING(telemetry.authorized(project_id,'ingest'));
DROP POLICY IF EXISTS candidate_insert ON telemetry.ledger_candidates;
CREATE POLICY candidate_insert ON telemetry.ledger_candidates FOR INSERT TO telemetry_owner WITH CHECK(telemetry.authorized(project_id,'ingest'));
DROP TRIGGER IF EXISTS candidate_immutable ON telemetry.ledger_candidates;
CREATE TRIGGER candidate_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.ledger_candidates FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();
CREATE OR REPLACE FUNCTION telemetry.stage_ledger_candidate(p_project UUID,p_invocation UUID,p_ledger UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE binding TEXT; result UUID;
BEGIN
 PERFORM telemetry.assert_ingestor(p_project);
 IF p_invocation IS NULL OR p_ledger IS NULL THEN RAISE EXCEPTION 'Invalid telemetry candidate' USING ERRCODE='22023'; END IF;
 SELECT binding_digest INTO binding FROM telemetry.invocations WHERE project_id=p_project AND invocation_id=p_invocation;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid telemetry invocation' USING ERRCODE='22023'; END IF;
 INSERT INTO telemetry.ledger_candidates(project_id,invocation_id,ledger_call_id,candidate_digest)
 VALUES(p_project,p_invocation,p_ledger,encode(public.digest(convert_to(jsonb_build_array('telemetry-candidate-v1',p_project,p_invocation,p_ledger,binding)::text,'UTF8'),'sha256'),'hex'))
 ON CONFLICT(project_id,invocation_id,ledger_call_id) DO NOTHING;
 SELECT candidate_id INTO result FROM telemetry.ledger_candidates WHERE project_id=p_project AND invocation_id=p_invocation AND ledger_call_id=p_ledger;
 RETURN result;
END $$;
ALTER FUNCTION telemetry.stage_ledger_candidate(UUID,UUID,UUID) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.stage_ledger_candidate(UUID,UUID,UUID) FROM PUBLIC,app_runtime,telemetry_reporter,telemetry_operator;
GRANT EXECUTE ON FUNCTION telemetry.stage_ledger_candidate(UUID,UUID,UUID) TO telemetry_ingestor;
CREATE OR REPLACE FUNCTION telemetry.reconcile_candidates(p_project UUID,p_after UUID DEFAULT '00000000-0000-0000-0000-000000000000',p_limit INTEGER DEFAULT 25)
RETURNS TABLE(candidate_id UUID,invocation_id UUID,settlement_id UUID,disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c RECORD; linked RECORD;
BEGIN
 PERFORM telemetry.assert_ingestor(p_project);
 IF p_after IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid telemetry page' USING ERRCODE='22023'; END IF;
 FOR c IN SELECT x.* FROM telemetry.ledger_candidates x WHERE x.project_id=p_project AND x.candidate_id>p_after ORDER BY x.candidate_id LIMIT p_limit LOOP
  -- A dedicated service login cannot INSERT business ledgers. This query therefore
  -- observes only rows committed by the independent business transaction.
  IF NOT EXISTS(SELECT 1 FROM public.model_call_ledgers l WHERE l.project_id=p_project AND l.call_id=c.ledger_call_id) THEN
   RETURN QUERY SELECT c.candidate_id,c.invocation_id,NULL::uuid,'pending'::text;
  ELSE
   SELECT * INTO linked FROM telemetry.link_ledger(p_project,c.invocation_id,c.ledger_call_id);
   RETURN QUERY SELECT c.candidate_id,c.invocation_id,linked.settlement_id,linked.disposition;
  END IF;
 END LOOP;
END $$;
ALTER FUNCTION telemetry.reconcile_candidates(UUID,UUID,INTEGER) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.reconcile_candidates(UUID,UUID,INTEGER) FROM PUBLIC,app_runtime,telemetry_reporter,telemetry_operator;
GRANT EXECUTE ON FUNCTION telemetry.reconcile_candidates(UUID,UUID,INTEGER) TO telemetry_ingestor;
COMMIT;
