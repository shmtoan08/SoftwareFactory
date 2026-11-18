-- Stage A4: sanitized candidate counters only. No verified provider mapping.
BEGIN;
-- Unconstrained NUMERIC + CHECK avoids NUMERIC(30,0)'s implicit rounding.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='telemetry' AND t.typname='counter') THEN
  CREATE DOMAIN telemetry.counter AS NUMERIC
   CHECK(VALUE>=0 AND VALUE<1000000000000000000000000000000::numeric AND scale(VALUE)=0);
 END IF;
END $$;
ALTER DOMAIN telemetry.counter OWNER TO telemetry_owner;
REVOKE ALL ON DOMAIN telemetry.counter FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;

-- Candidate schemas from approved T0, not assertions about provider accounting.
-- Decimal strings preserve exact values across JS/JSON boundaries. Unknown keys,
-- JSON numbers, nulls, fractions, signs, leading zeros and >30 digits are rejected.
CREATE OR REPLACE FUNCTION telemetry.valid_candidate_usage(mapping TEXT, usage JSONB) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE allowed TEXT[]; item RECORD;
BEGIN
 IF usage IS NULL OR jsonb_typeof(usage)<>'object' OR octet_length(usage::text)>8192 THEN RETURN false; END IF;
 CASE mapping
 WHEN 'candidate-anthropic-v1-unverified' THEN allowed:=ARRAY['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens'];
 WHEN 'candidate-google-v1-unverified' THEN allowed:=ARRAY['promptTokenCount','candidatesTokenCount','totalTokenCount','cachedContentTokenCount','thoughtsTokenCount'];
 WHEN 'unsupported-v1-unverified' THEN allowed:=ARRAY[]::text[];
 ELSE RETURN false;
 END CASE;
 FOR item IN SELECT key,value FROM jsonb_each(usage) LOOP
  IF NOT item.key=ANY(allowed) OR jsonb_typeof(item.value)<>'string'
   OR (item.value#>>'{}') !~ '^(0|[1-9][0-9]{0,29})$' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER FUNCTION telemetry.valid_candidate_usage(TEXT,JSONB) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.valid_candidate_usage(TEXT,JSONB) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;

CREATE TABLE IF NOT EXISTS telemetry.observations (
 observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
 invocation_id UUID NOT NULL,
 revision BIGINT NOT NULL CHECK(revision>0),
 kind TEXT NOT NULL CHECK(kind IN ('USAGE','PARTIAL','FAILURE')),
 observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(observed_at)),
 canonical_status TEXT NOT NULL CHECK(canonical_status='unavailable'),
 canonical_input telemetry.counter,
 canonical_output telemetry.counter,
 canonical_total telemetry.counter,
 cache_read telemetry.counter,
 cache_write telemetry.counter,
 uncached telemetry.counter,
 reasoning telemetry.counter,
 reasoning_inclusion TEXT NOT NULL CHECK(reasoning_inclusion='unverified'),
 reported_total telemetry.counter,
 billed_amount NUMERIC CHECK(billed_amount IS NULL),
 currency TEXT CHECK(currency IS NULL),
 calculated_micro_usd telemetry.counter CHECK(calculated_micro_usd IS NULL),
 pricing_version TEXT CHECK(pricing_version IS NULL),
 normalized_error TEXT CHECK(normalized_error IN ('provider-timeout','provider-rate-limited','provider-rejected','transport-failure','usage-missing','mapping-unverified','attribution-incomplete','observer-persist-failed','observer-overflow','conflicting-observation','ledger-link-mismatch')),
 missing_reason TEXT NOT NULL CHECK(missing_reason='mapping-unverified'),
 numeric_usage JSONB NOT NULL,
 mapping_revision TEXT NOT NULL CHECK(telemetry.valid_candidate_usage(mapping_revision,numeric_usage)),
 provenance TEXT NOT NULL CHECK(provenance='provider-reported-unverified'),
 content_digest TEXT NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 UNIQUE(project_id,invocation_id,kind,revision),
 FOREIGN KEY(project_id,invocation_id) REFERENCES telemetry.invocations(project_id,invocation_id) ON DELETE RESTRICT,
 CHECK(canonical_input IS NULL AND canonical_output IS NULL AND canonical_total IS NULL
   AND cache_read IS NULL AND cache_write IS NULL AND uncached IS NULL AND reasoning IS NULL),
 CHECK(kind<>'FAILURE' OR normalized_error IS NOT NULL),
 CHECK(reported_total IS NOT DISTINCT FROM (numeric_usage->>'totalTokenCount')::numeric)
);
CREATE INDEX IF NOT EXISTS telemetry_observations_project_revision ON telemetry.observations(project_id,invocation_id,revision);
CREATE TABLE IF NOT EXISTS telemetry.quality_events (
 event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
 invocation_id UUID,
 lifecycle_id UUID,
 category TEXT NOT NULL CHECK(category IN ('usage-missing','mapping-unverified','attribution-incomplete','observer-persist-failed','observer-overflow','conflicting-observation','ledger-link-mismatch')),
 observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(observed_at)),
 conflict_digest TEXT CHECK(conflict_digest ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY(project_id,invocation_id) REFERENCES telemetry.invocations(project_id,invocation_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,lifecycle_id) REFERENCES telemetry.lifecycles(project_id,lifecycle_id) ON DELETE RESTRICT,
 CHECK(category<>'conflicting-observation' OR (invocation_id IS NOT NULL AND conflict_digest IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_quality_conflict_dedup ON telemetry.quality_events(project_id,invocation_id,conflict_digest) WHERE category='conflicting-observation';
CREATE INDEX IF NOT EXISTS telemetry_quality_project_observed ON telemetry.quality_events(project_id,observed_at);
ALTER TABLE telemetry.observations OWNER TO telemetry_owner;
ALTER TABLE telemetry.observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.observations FORCE ROW LEVEL SECURITY;
ALTER TABLE telemetry.quality_events OWNER TO telemetry_owner;
ALTER TABLE telemetry.quality_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.quality_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON telemetry.observations,telemetry.quality_events FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
DROP POLICY IF EXISTS observation_service_select ON telemetry.observations;
CREATE POLICY observation_service_select ON telemetry.observations FOR SELECT TO telemetry_owner USING(telemetry.authorized(project_id,'ingest'));
DROP POLICY IF EXISTS observation_service_insert ON telemetry.observations;
CREATE POLICY observation_service_insert ON telemetry.observations FOR INSERT TO telemetry_owner WITH CHECK(telemetry.authorized(project_id,'ingest'));
DROP POLICY IF EXISTS quality_service_insert ON telemetry.quality_events;
CREATE POLICY quality_service_insert ON telemetry.quality_events FOR INSERT TO telemetry_owner WITH CHECK(telemetry.authorized(project_id,'ingest'));
DROP TRIGGER IF EXISTS telemetry_observation_immutable ON telemetry.observations;
CREATE TRIGGER telemetry_observation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.observations
 FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();
DROP TRIGGER IF EXISTS telemetry_quality_immutable ON telemetry.quality_events;
CREATE TRIGGER telemetry_quality_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.quality_events
 FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();

CREATE OR REPLACE FUNCTION telemetry.append_unverified_usage(
 p_project UUID,p_invocation UUID,p_kind TEXT,p_revision BIGINT,p_usage JSONB,p_error TEXT DEFAULT NULL
) RETURNS TABLE(observation_id UUID,disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_provider TEXT; v_mapping TEXT; v_digest TEXT; v_id UUID; v_existing TEXT; v_count INTEGER;
BEGIN
 IF NOT telemetry.authorized(p_project,'ingest') THEN RAISE EXCEPTION 'Telemetry access denied' USING ERRCODE='42501'; END IF;
 IF p_invocation IS NULL OR p_kind IS NULL OR p_kind NOT IN ('USAGE','PARTIAL','FAILURE') OR p_revision IS NULL OR p_revision<1
 OR (p_kind='FAILURE' AND p_error IS NULL)
 OR (p_error IS NOT NULL AND p_error NOT IN ('provider-timeout','provider-rate-limited','provider-rejected','transport-failure','usage-missing','mapping-unverified','attribution-incomplete','observer-persist-failed','observer-overflow','conflicting-observation','ledger-link-mismatch')) THEN
  RAISE EXCEPTION 'Invalid telemetry observation' USING ERRCODE='22023';
 END IF;
 SELECT i.provider INTO v_provider FROM telemetry.invocations i WHERE i.project_id=p_project AND i.invocation_id=p_invocation;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid telemetry invocation' USING ERRCODE='22023'; END IF;
 v_mapping:=CASE v_provider WHEN 'anthropic' THEN 'candidate-anthropic-v1-unverified' WHEN 'google' THEN 'candidate-google-v1-unverified' ELSE 'unsupported-v1-unverified' END;
 IF NOT telemetry.valid_candidate_usage(v_mapping,p_usage) THEN RAISE EXCEPTION 'Invalid telemetry usage' USING ERRCODE='22023'; END IF;
 v_digest:=encode(public.digest(convert_to(jsonb_build_array('telemetry-unverified-usage-v1',p_project,p_invocation,p_kind,p_revision,p_usage,p_error,v_mapping)::text,'UTF8'),'sha256'),'hex');
 INSERT INTO telemetry.observations(project_id,invocation_id,revision,kind,canonical_status,reasoning_inclusion,reported_total,normalized_error,missing_reason,numeric_usage,mapping_revision,provenance,content_digest)
 VALUES(p_project,p_invocation,p_revision,p_kind,'unavailable','unverified',(p_usage->>'totalTokenCount')::numeric,p_error,'mapping-unverified',p_usage,v_mapping,'provider-reported-unverified',v_digest)
 ON CONFLICT(project_id,invocation_id,kind,revision) DO NOTHING;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 SELECT o.observation_id,o.content_digest INTO v_id,v_existing FROM telemetry.observations o
 WHERE o.project_id=p_project AND o.invocation_id=p_invocation AND o.kind=p_kind AND o.revision=p_revision;
 IF v_existing IS DISTINCT FROM v_digest THEN
  -- Return conflict instead of raising: the marker must survive transaction commit.
  -- Preserve the first receipt; reconciliation must exclude a conflicted invocation.
  INSERT INTO telemetry.quality_events(project_id,invocation_id,category,conflict_digest)
  VALUES(p_project,p_invocation,'conflicting-observation',v_digest) ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT v_id,'conflict'::text;
 ELSE
  RETURN QUERY SELECT v_id,CASE WHEN v_count=1 THEN 'recorded' ELSE 'duplicate' END;
 END IF;
END $$;
ALTER FUNCTION telemetry.append_unverified_usage(UUID,UUID,TEXT,BIGINT,JSONB,TEXT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.append_unverified_usage(UUID,UUID,TEXT,BIGINT,JSONB,TEXT) FROM PUBLIC,app_runtime,telemetry_reporter,telemetry_operator;
GRANT EXECUTE ON FUNCTION telemetry.append_unverified_usage(UUID,UUID,TEXT,BIGINT,JSONB,TEXT) TO telemetry_ingestor;
COMMIT;
