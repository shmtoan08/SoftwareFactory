-- Review follow-up: normalize cross-project report-id collisions at the typed
-- publication boundary without changing the immutable reports table or 0026.
BEGIN;
CREATE OR REPLACE FUNCTION telemetry.publish_incomplete_report(
 p_project UUID,p_report UUID,p_cutoff TIMESTAMPTZ,p_manifest_version TEXT,p_mapping_versions TEXT[],p_supersedes UUID DEFAULT NULL
) RETURNS TABLE(report_id UUID,total_roots BIGINT,censored_roots BIGINT,disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE now_at TIMESTAMPTZ:=clock_timestamp(); inventory JSONB; total BIGINT; censored BIGINT; digest TEXT; existing RECORD; prior_cutoff TIMESTAMPTZ;
 root RECORD; aggregate JSONB;
BEGIN
 IF NOT telemetry.authorized(p_project,'read') THEN RAISE EXCEPTION 'Telemetry access denied' USING ERRCODE='42501'; END IF;
 IF p_report IS NULL OR p_cutoff IS NULL OR NOT isfinite(p_cutoff) OR p_cutoff>=now_at
  OR p_manifest_version IS NULL OR octet_length(p_manifest_version) NOT BETWEEN 1 AND 128
  OR NOT telemetry.valid_mapping_versions(p_mapping_versions) OR p_supersedes=p_report THEN
  RAISE EXCEPTION 'Invalid telemetry report' USING ERRCODE='22023';
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_project::text||':report',2601));
 IF p_supersedes IS NOT NULL THEN
  SELECT r.cutoff_at INTO prior_cutoff FROM telemetry.reports r WHERE r.project_id=p_project AND r.report_id=p_supersedes;
  IF NOT FOUND OR prior_cutoff>p_cutoff THEN RAISE EXCEPTION 'Invalid report supersession' USING ERRCODE='23514'; END IF;
 END IF;
 -- Lock roots in deterministic order using the same key as lifecycle event writers.
 FOR root IN SELECT l.lifecycle_id FROM telemetry.lifecycles l JOIN telemetry.cohort_manifests m
  ON m.project_id=l.project_id AND m.manifest_id=l.manifest_id
  WHERE l.project_id=p_project AND l.created_at<=p_cutoff AND m.manifest_version=p_manifest_version ORDER BY l.lifecycle_id
 LOOP
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_project::text||':'||root.lifecycle_id::text,2402));
 END LOOP;
 WITH roots AS (
  SELECT l.lifecycle_id,m.task_size,e.sequence,e.event_digest,e.outcome,
   CASE WHEN m.task_size='unclassified' THEN 'unclassified'
    WHEN EXISTS(SELECT 1 FROM telemetry.lifecycle_events c WHERE c.project_id=l.project_id AND c.lifecycle_id=l.lifecycle_id
      AND c.kind='CENSOR' AND c.observed_at<=p_cutoff AND c.cutoff_at<=p_cutoff) THEN 'censored'
    ELSE 'observer-coverage-unproven' END AS reason
  FROM telemetry.lifecycles l JOIN telemetry.cohort_manifests m ON m.project_id=l.project_id AND m.manifest_id=l.manifest_id
  CROSS JOIN LATERAL (SELECT x.sequence,x.event_digest,x.outcome FROM telemetry.lifecycle_events x
    WHERE x.project_id=l.project_id AND x.lifecycle_id=l.lifecycle_id AND x.observed_at<=p_cutoff ORDER BY x.sequence DESC LIMIT 1) e
  WHERE l.project_id=p_project AND l.created_at<=p_cutoff AND m.manifest_version=p_manifest_version
 ) SELECT COALESCE(jsonb_agg(jsonb_build_array(lifecycle_id,sequence,event_digest,outcome,reason) ORDER BY lifecycle_id),'[]'::jsonb),
  count(*),count(*) FILTER(WHERE reason='censored') INTO inventory,total,censored FROM roots;
 aggregate:=jsonb_build_object('total_roots',total::text,'complete_roots','0','incomplete_roots',total::text,
  'censored_roots',censored::text,'canonical_total',NULL);
 digest:=encode(public.digest(convert_to(jsonb_build_array('telemetry-report-v1',p_project,p_report,p_cutoff,
  p_manifest_version,p_mapping_versions,p_supersedes,inventory,aggregate)::text,'UTF8'),'sha256'),'hex');
 SELECT r.report_digest,r.aggregate_json,r.cutoff_at,r.manifest_version,r.mapping_versions,r.supersedes_report_id
  INTO existing FROM telemetry.reports r WHERE r.project_id=p_project AND r.report_id=p_report;
 IF FOUND THEN
  IF existing.report_digest=digest AND existing.aggregate_json=aggregate AND existing.cutoff_at=p_cutoff
   AND existing.manifest_version=p_manifest_version AND existing.mapping_versions=p_mapping_versions
   AND existing.supersedes_report_id IS NOT DISTINCT FROM p_supersedes THEN
   RETURN QUERY SELECT p_report,total,censored,'duplicate'::text; RETURN;
  END IF;
  RAISE EXCEPTION 'Telemetry report conflict' USING ERRCODE='23505';
 END IF;
 BEGIN
  INSERT INTO telemetry.reports(report_id,project_id,cutoff_at,manifest_version,mapping_versions,report_digest,aggregate_json,supersedes_report_id,finalized_at)
  VALUES(p_report,p_project,p_cutoff,p_manifest_version,p_mapping_versions,digest,aggregate,p_supersedes,now_at);
 EXCEPTION WHEN unique_violation THEN
  -- RLS intentionally hides a report owned by another project. Convert the
  -- primary-key collision without revealing that project's report contents.
  RAISE EXCEPTION 'Telemetry report conflict' USING ERRCODE='23505';
 END;
 INSERT INTO telemetry.report_members(project_id,report_id,lifecycle_id,event_sequence,event_digest,outcome,eligibility_reason)
 SELECT p_project,p_report,(item->>0)::uuid,(item->>1)::bigint,item->>2,NULLIF(item->>3,''),item->>4 FROM jsonb_array_elements(inventory) item;
 RETURN QUERY SELECT p_report,total,censored,'recorded'::text;
END $$;
ALTER FUNCTION telemetry.publish_incomplete_report(UUID,UUID,TIMESTAMPTZ,TEXT,TEXT[],UUID) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.publish_incomplete_report(UUID,UUID,TIMESTAMPTZ,TEXT,TEXT[],UUID) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
GRANT EXECUTE ON FUNCTION telemetry.publish_incomplete_report(UUID,UUID,TIMESTAMPTZ,TEXT,TEXT[],UUID) TO telemetry_reporter;
COMMIT;
