-- Stage A6: locked report storage and bounded call-level diagnostic readers.
BEGIN;
CREATE OR REPLACE FUNCTION telemetry.valid_report_aggregate(body JSONB) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE k TEXT; total NUMERIC; incomplete NUMERIC; censored NUMERIC;
BEGIN
 IF body IS NULL OR jsonb_typeof(body)<>'object' OR octet_length(body::text)>8192 THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(body))<>5 THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['total_roots','complete_roots','incomplete_roots','censored_roots'] LOOP
  IF NOT body?k OR jsonb_typeof(body->k)<>'string' OR (body->>k) !~ '^(0|[1-9][0-9]{0,29})$' THEN RETURN false; END IF;
 END LOOP;
 IF NOT body?'canonical_total' OR body->'canonical_total'<>'null'::jsonb OR body->>'complete_roots'<>'0' THEN RETURN false; END IF;
 total:=(body->>'total_roots')::numeric; incomplete:=(body->>'incomplete_roots')::numeric; censored:=(body->>'censored_roots')::numeric;
 RETURN total=incomplete AND censored<=incomplete;
END $$;
ALTER FUNCTION telemetry.valid_report_aggregate(JSONB) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.valid_report_aggregate(JSONB) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
CREATE OR REPLACE FUNCTION telemetry.valid_mapping_versions(versions TEXT[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v TEXT;
BEGIN
 IF versions IS NULL OR array_ndims(versions) IS DISTINCT FROM 1 OR cardinality(versions) NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
 FOREACH v IN ARRAY versions LOOP
  IF v IS NULL OR octet_length(v) NOT BETWEEN 1 AND 128 OR v !~ '^[A-Za-z0-9_.:-]+$' THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(DISTINCT x)=cardinality(versions) FROM unnest(versions) x);
END $$;
ALTER FUNCTION telemetry.valid_mapping_versions(TEXT[]) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.valid_mapping_versions(TEXT[]) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
CREATE TABLE IF NOT EXISTS telemetry.reports (
 report_id UUID PRIMARY KEY,
 project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
 cutoff_at TIMESTAMPTZ NOT NULL CHECK(isfinite(cutoff_at)),
 manifest_version TEXT NOT NULL CHECK(octet_length(manifest_version) BETWEEN 1 AND 128),
 mapping_versions TEXT[] NOT NULL CHECK(telemetry.valid_mapping_versions(mapping_versions)),
 report_digest TEXT NOT NULL CHECK(report_digest ~ '^[a-f0-9]{64}$'),
 aggregate_json JSONB NOT NULL CHECK(telemetry.valid_report_aggregate(aggregate_json)),
 supersedes_report_id UUID,
 finalized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(finalized_at)),
 UNIQUE(project_id,report_id),
 FOREIGN KEY(project_id,supersedes_report_id) REFERENCES telemetry.reports(project_id,report_id) ON DELETE RESTRICT,
 CHECK(supersedes_report_id IS DISTINCT FROM report_id),
 CHECK(cutoff_at<=finalized_at)
);
CREATE INDEX IF NOT EXISTS telemetry_reports_project_cutoff ON telemetry.reports(project_id,cutoff_at,report_id);
CREATE TABLE IF NOT EXISTS telemetry.report_members (
 project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
 report_id UUID NOT NULL,
 lifecycle_id UUID NOT NULL,
 event_sequence BIGINT NOT NULL CHECK(event_sequence>0),
 event_digest TEXT NOT NULL CHECK(event_digest ~ '^[a-f0-9]{64}$'),
 outcome TEXT CHECK(outcome IN ('success','failed','abandoned','cancelled')),
 eligibility_reason TEXT NOT NULL CHECK(eligibility_reason IN ('attribution-incomplete','observer-coverage-unproven','mapping-unverified','unsettled','censored','unclassified')),
 PRIMARY KEY(project_id,report_id,lifecycle_id),
 FOREIGN KEY(project_id,report_id) REFERENCES telemetry.reports(project_id,report_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,lifecycle_id,event_sequence,event_digest)
   REFERENCES telemetry.lifecycle_events(project_id,lifecycle_id,sequence,event_digest) ON DELETE RESTRICT
);
-- No policies/grants/publication function: report bodies cannot yet be accepted
-- from any service. Reconciler must derive counts/membership and verify chronology.
ALTER TABLE telemetry.reports OWNER TO telemetry_owner;
ALTER TABLE telemetry.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE telemetry.report_members OWNER TO telemetry_owner;
ALTER TABLE telemetry.report_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.report_members FORCE ROW LEVEL SECURITY;
REVOKE ALL ON telemetry.reports,telemetry.report_members FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
DROP TRIGGER IF EXISTS telemetry_report_immutable ON telemetry.reports;
CREATE TRIGGER telemetry_report_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.reports FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();
DROP TRIGGER IF EXISTS telemetry_report_member_immutable ON telemetry.report_members;
CREATE TRIGGER telemetry_report_member_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.report_members FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();

-- Open only the existing function owner's scoped read path, never table access.
DROP POLICY IF EXISTS observation_service_select ON telemetry.observations;
CREATE POLICY observation_service_select ON telemetry.observations FOR SELECT TO telemetry_owner
 USING(telemetry.authorized(project_id,'ingest') OR telemetry.authorized(project_id,'read'));
DROP POLICY IF EXISTS settlement_service_select ON telemetry.settlements;
CREATE POLICY settlement_service_select ON telemetry.settlements FOR SELECT TO telemetry_owner
 USING(telemetry.authorized(project_id,'ingest') OR telemetry.authorized(project_id,'read'));
DROP POLICY IF EXISTS quality_service_select ON telemetry.quality_events;
CREATE POLICY quality_service_select ON telemetry.quality_events FOR SELECT TO telemetry_owner USING(telemetry.authorized(project_id,'read'));
CREATE INDEX IF NOT EXISTS telemetry_quality_project_invocation ON telemetry.quality_events(project_id,invocation_id) WHERE invocation_id IS NOT NULL;

-- Replace the shorter prefix index with the complete keyset order.
CREATE INDEX IF NOT EXISTS telemetry_observations_project_page ON telemetry.observations(project_id,invocation_id,revision,kind);
DROP INDEX IF EXISTS telemetry.telemetry_observations_project_revision;

CREATE OR REPLACE FUNCTION telemetry.read_observations(p_project UUID,p_invocation UUID,p_after_revision BIGINT DEFAULT NULL,p_after_kind TEXT DEFAULT NULL,p_limit INTEGER DEFAULT 25)
RETURNS TABLE(observation_id UUID,revision BIGINT,kind TEXT,observed_at TIMESTAMPTZ,canonical_status TEXT,reported_total TEXT,numeric_usage JSONB,mapping_revision TEXT,normalized_error TEXT,missing_reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT telemetry.authorized(p_project,'read') THEN RAISE EXCEPTION 'Telemetry access denied' USING ERRCODE='42501'; END IF;
 IF p_invocation IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
 OR ((p_after_revision IS NULL)<>(p_after_kind IS NULL))
 OR p_after_revision<1 OR (p_after_kind IS NOT NULL AND p_after_kind NOT IN ('USAGE','PARTIAL','FAILURE')) THEN
  RAISE EXCEPTION 'Invalid telemetry page' USING ERRCODE='22023';
 END IF;
 IF p_after_revision IS NULL THEN
  RETURN QUERY SELECT o.observation_id,o.revision,o.kind,o.observed_at,o.canonical_status,o.reported_total::text,o.numeric_usage,o.mapping_revision,o.normalized_error,o.missing_reason
  FROM telemetry.observations o WHERE o.project_id=p_project AND o.invocation_id=p_invocation
  ORDER BY o.revision,o.kind LIMIT p_limit;
 ELSE
  RETURN QUERY SELECT o.observation_id,o.revision,o.kind,o.observed_at,o.canonical_status,o.reported_total::text,o.numeric_usage,o.mapping_revision,o.normalized_error,o.missing_reason
  FROM telemetry.observations o WHERE o.project_id=p_project AND o.invocation_id=p_invocation
  AND (o.revision,o.kind)>(p_after_revision,p_after_kind)
  ORDER BY o.revision,o.kind LIMIT p_limit;
 END IF;
END $$;
ALTER FUNCTION telemetry.read_observations(UUID,UUID,BIGINT,TEXT,INTEGER) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.read_observations(UUID,UUID,BIGINT,TEXT,INTEGER) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_operator;
GRANT EXECUTE ON FUNCTION telemetry.read_observations(UUID,UUID,BIGINT,TEXT,INTEGER) TO telemetry_reporter;

CREATE OR REPLACE FUNCTION telemetry.read_settlement(p_project UUID,p_invocation UUID)
RETURNS TABLE(settlement_id UUID,ledger_call_id UUID,ledger_outcome TEXT,recorded_at TIMESTAMPTZ,has_quality_flags BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT telemetry.authorized(p_project,'read') THEN RAISE EXCEPTION 'Telemetry access denied' USING ERRCODE='42501'; END IF;
 IF p_invocation IS NULL THEN RAISE EXCEPTION 'Invalid telemetry invocation' USING ERRCODE='22023'; END IF;
 RETURN QUERY SELECT s.settlement_id,s.ledger_call_id,s.ledger_outcome,s.recorded_at,
 EXISTS(SELECT 1 FROM telemetry.quality_events q WHERE q.project_id=p_project AND q.invocation_id=p_invocation)
 FROM telemetry.settlements s WHERE s.project_id=p_project AND s.invocation_id=p_invocation;
END $$;
ALTER FUNCTION telemetry.read_settlement(UUID,UUID) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.read_settlement(UUID,UUID) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_operator;
GRANT EXECUTE ON FUNCTION telemetry.read_settlement(UUID,UUID) TO telemetry_reporter;
COMMIT;
