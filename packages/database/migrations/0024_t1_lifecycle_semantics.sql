-- Stage C2: authenticated lifecycle operator semantics. TASK_BOUND and CLOSE
-- remain unavailable until an independent dispatch inventory is approved.
BEGIN;
ALTER TABLE telemetry.service_projects DROP CONSTRAINT IF EXISTS service_projects_capability_check;
ALTER TABLE telemetry.service_projects ADD CONSTRAINT service_projects_capability_check
 CHECK(capability IN ('ingest','read','operator'));

CREATE OR REPLACE FUNCTION telemetry.authorized(p_project UUID,p_capability TEXT) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM pg_catalog.pg_roles r JOIN telemetry.service_projects s
   ON s.principal_oid=r.oid AND s.principal_name=r.rolname
  WHERE r.rolname=session_user AND r.rolcanlogin AND NOT r.rolsuper
   AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolbypassrls
   AND NOT pg_catalog.pg_has_role(r.oid,'app_runtime','MEMBER')
   AND pg_catalog.pg_has_role(r.oid,CASE p_capability
     WHEN 'ingest' THEN 'telemetry_ingestor' WHEN 'read' THEN 'telemetry_reporter'
     WHEN 'operator' THEN 'telemetry_operator' ELSE NULL END,'MEMBER')
   AND s.project_id=p_project AND s.capability=p_capability
   AND p_capability IN ('ingest','read','operator'));
$$;
ALTER FUNCTION telemetry.authorized(UUID,TEXT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.authorized(UUID,TEXT) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;

GRANT USAGE ON SCHEMA telemetry TO telemetry_operator;
GRANT SELECT(task_id,project_id,status,active_lease_epoch) ON public.tasks TO telemetry_owner;
DROP POLICY IF EXISTS telemetry_task_operator_select ON public.tasks;
CREATE POLICY telemetry_task_operator_select ON public.tasks FOR SELECT TO telemetry_owner
 USING(telemetry.authorized(project_id,'operator'));

DROP POLICY IF EXISTS telemetry_manifest_operator_select ON telemetry.cohort_manifests;
CREATE POLICY telemetry_manifest_operator_select ON telemetry.cohort_manifests FOR SELECT TO telemetry_owner
 USING(telemetry.authorized(project_id,'operator'));
DROP POLICY IF EXISTS telemetry_manifest_operator_insert ON telemetry.cohort_manifests;
CREATE POLICY telemetry_manifest_operator_insert ON telemetry.cohort_manifests FOR INSERT TO telemetry_owner
 WITH CHECK(telemetry.authorized(project_id,'operator'));
DROP POLICY IF EXISTS telemetry_lifecycle_operator_select ON telemetry.lifecycles;
CREATE POLICY telemetry_lifecycle_operator_select ON telemetry.lifecycles FOR SELECT TO telemetry_owner
 USING(telemetry.authorized(project_id,'operator'));
DROP POLICY IF EXISTS telemetry_lifecycle_operator_insert ON telemetry.lifecycles;
CREATE POLICY telemetry_lifecycle_operator_insert ON telemetry.lifecycles FOR INSERT TO telemetry_owner
 WITH CHECK(telemetry.authorized(project_id,'operator'));
DROP POLICY IF EXISTS telemetry_event_operator_select ON telemetry.lifecycle_events;
CREATE POLICY telemetry_event_operator_select ON telemetry.lifecycle_events FOR SELECT TO telemetry_owner
 USING(telemetry.authorized(project_id,'operator'));
DROP POLICY IF EXISTS telemetry_event_operator_insert ON telemetry.lifecycle_events;
CREATE POLICY telemetry_event_operator_insert ON telemetry.lifecycle_events FOR INSERT TO telemetry_owner
 WITH CHECK(telemetry.authorized(project_id,'operator'));

CREATE OR REPLACE FUNCTION telemetry.assert_operator(p_project UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT telemetry.authorized(p_project,'operator') THEN
  RAISE EXCEPTION 'Telemetry access denied' USING ERRCODE='42501';
 END IF;
END $$;
ALTER FUNCTION telemetry.assert_operator(UUID) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.assert_operator(UUID) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter;
GRANT EXECUTE ON FUNCTION telemetry.assert_operator(UUID) TO telemetry_operator;

CREATE OR REPLACE FUNCTION telemetry.open_lifecycle(
 p_project UUID,p_task UUID,p_manifest UUID,p_lifecycle UUID,p_contract_hmac TEXT,p_key_version TEXT,
 p_task_size TEXT,p_files INTEGER,p_packages INTEGER,p_schema_migration BOOLEAN,p_auth_rls BOOLEAN,
 p_security_isolation BOOLEAN,p_recovery_lease BOOLEAN,p_public_contract BOOLEAN,p_source_sha TEXT,p_manifest_version TEXT
) RETURNS TABLE(lifecycle_id UUID,disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE task_status TEXT; task_epoch BIGINT; existing RECORD; digest TEXT; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 PERFORM telemetry.assert_operator(p_project);
 IF p_task IS NULL OR p_manifest IS NULL OR p_lifecycle IS NULL OR p_contract_hmac !~ '^[a-f0-9]{64}$'
  OR p_key_version IS NULL OR octet_length(p_key_version) NOT BETWEEN 1 AND 128
  OR p_task_size NOT IN ('S','M','L','unclassified') OR p_files<0 OR p_packages<0
  OR p_schema_migration IS NULL OR p_auth_rls IS NULL OR p_security_isolation IS NULL
  OR p_recovery_lease IS NULL OR p_public_contract IS NULL OR p_source_sha !~ '^[a-f0-9]{40}$'
  OR p_manifest_version IS NULL OR octet_length(p_manifest_version) NOT BETWEEN 1 AND 128 THEN
  RAISE EXCEPTION 'Invalid lifecycle manifest' USING ERRCODE='22023';
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_project::text||':'||p_task::text,2401));
 SELECT t.status,t.active_lease_epoch INTO task_status,task_epoch FROM public.tasks t
  WHERE t.project_id=p_project AND t.task_id=p_task;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid lifecycle task' USING ERRCODE='22023'; END IF;
 SELECT l.lifecycle_id,m.* INTO existing FROM telemetry.lifecycles l JOIN telemetry.cohort_manifests m
  ON m.project_id=l.project_id AND m.manifest_id=l.manifest_id
  WHERE l.project_id=p_project AND l.task_id=p_task;
 IF FOUND THEN
  IF existing.lifecycle_id=p_lifecycle AND existing.manifest_id=p_manifest
   AND existing.contract_ref_hmac=p_contract_hmac AND existing.key_version=p_key_version
   AND existing.task_size=p_task_size AND existing.planned_file_count IS NOT DISTINCT FROM p_files
   AND existing.planned_package_count IS NOT DISTINCT FROM p_packages
   AND existing.schema_migration=p_schema_migration AND existing.auth_rls=p_auth_rls
   AND existing.security_isolation=p_security_isolation AND existing.recovery_lease=p_recovery_lease
   AND existing.public_contract=p_public_contract AND existing.source_sha=p_source_sha
   AND existing.manifest_version=p_manifest_version AND existing.operator_principal=session_user THEN
   RETURN QUERY SELECT p_lifecycle,'duplicate'::text; RETURN;
  END IF;
  RAISE EXCEPTION 'Lifecycle enrollment conflict' USING ERRCODE='23505';
 END IF;
 IF task_status<>'Ready' OR task_epoch<>0 THEN
  RAISE EXCEPTION 'Lifecycle must open before execution' USING ERRCODE='23514';
 END IF;
 INSERT INTO telemetry.cohort_manifests(manifest_id,project_id,contract_ref_hmac,key_version,task_size,
  planned_file_count,planned_package_count,schema_migration,auth_rls,security_isolation,recovery_lease,
  public_contract,operator_principal,approved_at,source_sha,manifest_version)
 VALUES(p_manifest,p_project,p_contract_hmac,p_key_version,p_task_size,p_files,p_packages,p_schema_migration,
  p_auth_rls,p_security_isolation,p_recovery_lease,p_public_contract,session_user,now_at,p_source_sha,p_manifest_version);
 INSERT INTO telemetry.lifecycles(lifecycle_id,project_id,task_id,manifest_id,created_at)
 VALUES(p_lifecycle,p_project,p_task,p_manifest,now_at);
 digest:=encode(public.digest(convert_to(jsonb_build_array('telemetry-lifecycle-event-v1',p_project,p_lifecycle,1,
  'OPEN',NULL,session_user,now_at,NULL,NULL)::text,'UTF8'),'sha256'),'hex');
 INSERT INTO telemetry.lifecycle_events(event_id,project_id,lifecycle_id,sequence,kind,outcome,service_actor_ref,
  observed_at,cutoff_at,prior_sequence,prior_event_digest,event_digest)
 VALUES(gen_random_uuid(),p_project,p_lifecycle,1,'OPEN',NULL,session_user,now_at,NULL,NULL,NULL,digest);
 RETURN QUERY SELECT p_lifecycle,'recorded'::text;
END $$;
ALTER FUNCTION telemetry.open_lifecycle(UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,INTEGER,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,TEXT,TEXT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.open_lifecycle(UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,INTEGER,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,TEXT,TEXT) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter;
GRANT EXECUTE ON FUNCTION telemetry.open_lifecycle(UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,INTEGER,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,TEXT,TEXT) TO telemetry_operator;

CREATE OR REPLACE FUNCTION telemetry.append_lifecycle_event(p_project UUID,p_lifecycle UUID,p_event UUID,p_kind TEXT,p_cutoff TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE(sequence BIGINT,event_digest TEXT,disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE root_created TIMESTAMPTZ; prior RECORD; existing RECORD; next_sequence BIGINT; digest TEXT; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 PERFORM telemetry.assert_operator(p_project);
 IF p_lifecycle IS NULL OR p_event IS NULL OR p_kind NOT IN ('AMEND','CENSOR','REOPEN')
  OR (p_kind='CENSOR' AND (p_cutoff IS NULL OR NOT isfinite(p_cutoff)))
  OR (p_kind<>'CENSOR' AND p_cutoff IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid lifecycle event' USING ERRCODE='22023';
 END IF;
 SELECT e.sequence,e.event_digest,e.lifecycle_id,e.kind,e.cutoff_at,e.service_actor_ref INTO existing FROM telemetry.lifecycle_events e
  WHERE e.project_id=p_project AND e.event_id=p_event;
 IF FOUND THEN
  IF existing.lifecycle_id=p_lifecycle AND existing.kind=p_kind
   AND existing.cutoff_at IS NOT DISTINCT FROM p_cutoff AND existing.service_actor_ref=session_user THEN
   RETURN QUERY SELECT existing.sequence,existing.event_digest,'duplicate'::text; RETURN;
  END IF;
  RAISE EXCEPTION 'Lifecycle event conflict' USING ERRCODE='23505';
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_project::text||':'||p_lifecycle::text,2402));
 SELECT l.created_at INTO root_created FROM telemetry.lifecycles l
  WHERE l.project_id=p_project AND l.lifecycle_id=p_lifecycle;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid lifecycle' USING ERRCODE='22023'; END IF;
 SELECT e.sequence,e.kind,e.event_digest INTO prior FROM telemetry.lifecycle_events e
  WHERE e.project_id=p_project AND e.lifecycle_id=p_lifecycle ORDER BY e.sequence DESC LIMIT 1;
 IF p_kind='REOPEN' AND prior.kind<>'CLOSE' THEN RAISE EXCEPTION 'Invalid lifecycle transition' USING ERRCODE='23514'; END IF;
 IF p_kind<>'REOPEN' AND prior.kind='CLOSE' THEN RAISE EXCEPTION 'Invalid lifecycle transition' USING ERRCODE='23514'; END IF;
 IF p_kind='CENSOR' AND (p_cutoff<root_created OR p_cutoff>now_at) THEN
  RAISE EXCEPTION 'Invalid lifecycle cutoff' USING ERRCODE='22023';
 END IF;
 next_sequence:=prior.sequence+1;
 digest:=encode(public.digest(convert_to(jsonb_build_array('telemetry-lifecycle-event-v1',p_project,p_lifecycle,
  next_sequence,p_kind,NULL,session_user,now_at,p_cutoff,prior.event_digest)::text,'UTF8'),'sha256'),'hex');
 INSERT INTO telemetry.lifecycle_events(event_id,project_id,lifecycle_id,sequence,kind,outcome,service_actor_ref,
  observed_at,cutoff_at,prior_sequence,prior_event_digest,event_digest)
 VALUES(p_event,p_project,p_lifecycle,next_sequence,p_kind,NULL,session_user,now_at,p_cutoff,prior.sequence,prior.event_digest,digest);
 RETURN QUERY SELECT next_sequence,digest,'recorded'::text;
END $$;
ALTER FUNCTION telemetry.append_lifecycle_event(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.append_lifecycle_event(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter;
GRANT EXECUTE ON FUNCTION telemetry.append_lifecycle_event(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) TO telemetry_operator;

CREATE OR REPLACE FUNCTION telemetry.close_lifecycle(p_project UUID,p_lifecycle UUID,p_outcome TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ignored UUID;
BEGIN
 PERFORM telemetry.assert_operator(p_project);
 IF p_lifecycle IS NULL OR p_outcome NOT IN ('success','failed','abandoned','cancelled') THEN
  RAISE EXCEPTION 'Invalid lifecycle close' USING ERRCODE='22023';
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_project::text||':'||p_lifecycle::text,2402));
 SELECT l.lifecycle_id INTO ignored FROM telemetry.lifecycles l
  WHERE l.project_id=p_project AND l.lifecycle_id=p_lifecycle;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid lifecycle' USING ERRCODE='22023'; END IF;
 -- Candidate tables cannot prove calls that bypassed observer creation. Until an
 -- approved authoritative dispatch inventory exists, every close is incomplete.
 RAISE EXCEPTION 'Lifecycle coverage authority unavailable' USING ERRCODE='23514';
END $$;
ALTER FUNCTION telemetry.close_lifecycle(UUID,UUID,TEXT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.close_lifecycle(UUID,UUID,TEXT) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter;
GRANT EXECUTE ON FUNCTION telemetry.close_lifecycle(UUID,UUID,TEXT) TO telemetry_operator;
COMMIT;
