BEGIN;
ALTER TABLE telemetry.dispatch_reservations ADD COLUMN IF NOT EXISTS lease_id UUID;
ALTER TABLE telemetry.dispatch_reservations ADD COLUMN IF NOT EXISTS lease_epoch BIGINT;
ALTER TABLE telemetry.dispatch_reservations DROP CONSTRAINT IF EXISTS dispatch_reservation_lease_binding;
ALTER TABLE telemetry.dispatch_reservations ADD CONSTRAINT dispatch_reservation_lease_binding
 CHECK((lease_id IS NULL AND lease_epoch IS NULL) OR (lease_id IS NOT NULL AND lease_epoch IS NOT NULL AND lease_epoch>0));
ALTER TABLE telemetry.dispatch_reservations DROP CONSTRAINT IF EXISTS dispatch_reservation_lease_scope;
ALTER TABLE telemetry.dispatch_reservations ADD CONSTRAINT dispatch_reservation_lease_scope
 FOREIGN KEY(lease_id,project_id) REFERENCES public.task_leases(lease_id,project_id) ON DELETE RESTRICT;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='telemetry_dispatch_writer') THEN
  CREATE ROLE telemetry_dispatch_writer NOLOGIN NOINHERIT;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='telemetry_dispatch_writer'
  AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit OR rolreplication))
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member='telemetry_dispatch_writer'::regrole) THEN
  RAISE EXCEPTION 'Dispatch writer role collision' USING ERRCODE='42501';
 END IF;
END $$;
ALTER TABLE telemetry.service_projects DROP CONSTRAINT IF EXISTS service_projects_capability_check;
ALTER TABLE telemetry.service_projects ADD CONSTRAINT service_projects_capability_check
 CHECK(capability IN ('ingest','read','operator','dispatch'));

CREATE OR REPLACE FUNCTION telemetry.dispatch_writer_authorized(p_project UUID) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM pg_catalog.pg_roles r JOIN telemetry.service_projects s
   ON s.principal_oid=r.oid AND s.principal_name=r.rolname
  WHERE r.rolname=session_user AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole
   AND NOT r.rolcreatedb AND NOT r.rolbypassrls AND NOT r.rolreplication
   AND NOT pg_has_role(r.oid,'app_runtime','MEMBER')
   AND pg_has_role(r.oid,'telemetry_dispatch_writer','MEMBER')
   AND s.project_id=p_project AND s.capability='dispatch');
$$;
ALTER FUNCTION telemetry.dispatch_writer_authorized(UUID) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.dispatch_writer_authorized(UUID) FROM PUBLIC;
GRANT USAGE ON SCHEMA telemetry TO telemetry_dispatch_writer;

DO $$
DECLARE rel TEXT;
BEGIN
 FOREACH rel IN ARRAY ARRAY['dispatch_reservations','dispatch_reservation_releases','dispatch_attempts','dispatch_events','lifecycles'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS dispatch_writer_read ON telemetry.%I',rel);
  EXECUTE format('CREATE POLICY dispatch_writer_read ON telemetry.%I FOR SELECT TO telemetry_owner
   USING(telemetry.dispatch_writer_authorized(project_id))',rel);
 END LOOP;
END $$;
DROP POLICY IF EXISTS dispatch_writer_insert ON telemetry.dispatch_attempts;
CREATE POLICY dispatch_writer_insert ON telemetry.dispatch_attempts FOR INSERT TO telemetry_owner
 WITH CHECK(telemetry.dispatch_writer_authorized(project_id));
DROP POLICY IF EXISTS dispatch_writer_insert ON telemetry.dispatch_events;
CREATE POLICY dispatch_writer_insert ON telemetry.dispatch_events FOR INSERT TO telemetry_owner
 WITH CHECK(kind IN ('PREPARED','DISPATCH_STARTED') AND telemetry.dispatch_writer_authorized(project_id));

-- PostgreSQL requires UPDATE privilege on at least one column for FOR UPDATE.
-- Restrictive UPDATE policies reject every actual row change by the definer.
GRANT SELECT(active_lease_id) ON public.tasks TO telemetry_owner;
GRANT SELECT(project_id,task_id,lease_id,lease_epoch,status,expires_at,revoked_at,execution_target_request_id)
 ON public.task_leases TO telemetry_owner;
GRANT UPDATE(task_id) ON public.tasks TO telemetry_owner;
GRANT UPDATE(lease_id) ON public.task_leases TO telemetry_owner;
GRANT SELECT(project_id,cost_session_id,task_id,pipeline_session_id,status) ON public.model_cost_sessions TO telemetry_owner;
DO $$
DECLARE rel TEXT;
BEGIN
 FOREACH rel IN ARRAY ARRAY['tasks','task_leases','model_cost_sessions'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS dispatch_writer_read ON public.%I',rel);
  EXECUTE format('CREATE POLICY dispatch_writer_read ON public.%I FOR SELECT TO telemetry_owner
   USING(telemetry.dispatch_writer_authorized(project_id))',rel);
 END LOOP;
 FOREACH rel IN ARRAY ARRAY['tasks','task_leases'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS dispatch_writer_row_lock ON public.%I',rel);
  EXECUTE format('CREATE POLICY dispatch_writer_row_lock ON public.%I FOR UPDATE TO telemetry_owner
   USING(telemetry.dispatch_writer_authorized(project_id)) WITH CHECK(false)',rel);
  EXECUTE format('DROP POLICY IF EXISTS dispatch_writer_no_update ON public.%I',rel);
  EXECUTE format('CREATE POLICY dispatch_writer_no_update ON public.%I AS RESTRICTIVE FOR UPDATE TO telemetry_owner
   USING(telemetry.dispatch_writer_authorized(project_id)) WITH CHECK(false)',rel);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION telemetry.lock_dispatch_fence(p_project UUID,p_reservation UUID,p_task UUID,p_lease UUID,p_epoch BIGINT)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT telemetry.dispatch_writer_authorized(p_project) THEN
  RAISE EXCEPTION 'DISPATCH_AUTHORITY_DENIED' USING ERRCODE='42501';
 END IF;
 IF p_reservation IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'DISPATCH_RESERVATION_INVALID' USING ERRCODE='22023';
 END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(p_project::text||':'||p_reservation::text,2929)) THEN
  RAISE EXCEPTION 'DISPATCH_FENCE_REJECTED' USING ERRCODE='55P03';
 END IF;
 -- NOWAIT avoids a lock-order cycle with lease maintenance. Recheck the exact
 -- active generation and lease expiry after obtaining both row locks.
 BEGIN
  PERFORM 1 FROM public.task_leases l JOIN public.tasks t USING(project_id,task_id)
   WHERE l.project_id=p_project AND l.task_id=p_task AND l.lease_id=p_lease
   FOR UPDATE OF l,t NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'DISPATCH_FENCE_REJECTED' USING ERRCODE='23514'; END IF;
 EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'DISPATCH_FENCE_REJECTED' USING ERRCODE='55P03';
 END;
 PERFORM 1 FROM public.task_leases l JOIN public.tasks t USING(project_id,task_id)
  WHERE l.project_id=p_project AND l.task_id=p_task AND l.lease_id=p_lease AND l.lease_epoch=p_epoch
   AND t.active_lease_id=l.lease_id AND t.active_lease_epoch=l.lease_epoch
   AND t.status='ExecutingInTarget' AND l.status='ACTIVE' AND l.revoked_at IS NULL AND l.expires_at>clock_timestamp()
   AND l.execution_target_request_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'DISPATCH_FENCE_REJECTED' USING ERRCODE='23514'; END IF;
END $$;
ALTER FUNCTION telemetry.lock_dispatch_fence(UUID,UUID,UUID,UUID,BIGINT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.lock_dispatch_fence(UUID,UUID,UUID,UUID,BIGINT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION telemetry.prepare_dispatch_attempt(
 p_project UUID,p_reservation UUID,p_lifecycle UUID,p_task UUID,p_lease UUID,p_epoch BIGINT,
 p_provider TEXT,p_model TEXT,p_prompt TEXT,p_version TEXT,p_hmac TEXT,p_key_version TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE hold telemetry.dispatch_reservations%ROWTYPE; previous telemetry.dispatch_attempts%ROWTYPE;
 binding TEXT; pipeline UUID;
BEGIN
 PERFORM telemetry.lock_dispatch_fence(p_project,p_reservation,p_task,p_lease,p_epoch);
 SELECT * INTO hold FROM telemetry.dispatch_reservations WHERE project_id=p_project AND reservation_id=p_reservation;
 IF NOT FOUND THEN RAISE EXCEPTION 'DISPATCH_RESERVATION_INVALID' USING ERRCODE='22023'; END IF;
 IF hold.lease_id IS DISTINCT FROM p_lease OR hold.lease_epoch IS DISTINCT FROM p_epoch THEN
  RAISE EXCEPTION 'DISPATCH_FENCE_REJECTED' USING ERRCODE='23514';
 END IF;
 SELECT s.pipeline_session_id INTO pipeline FROM public.model_cost_sessions s
  WHERE s.project_id=p_project AND s.cost_session_id=hold.cost_session_id AND s.task_id=p_task AND s.status='ACTIVE';
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM telemetry.lifecycles
  WHERE project_id=p_project AND lifecycle_id=p_lifecycle AND task_id=p_task) THEN
  RAISE EXCEPTION 'DISPATCH_AUTHORITY_DENIED' USING ERRCODE='42501';
 END IF;
 binding:=encode(public.digest(convert_to(jsonb_build_array('managed-dispatch-v1',p_project,p_reservation,
  p_lifecycle,p_task,p_lease,p_epoch,p_provider,p_model,p_prompt,p_version,p_hmac,p_key_version,pipeline)::text,'UTF8'),'sha256'),'hex');
 SELECT * INTO previous FROM telemetry.dispatch_attempts WHERE project_id=p_project AND attempt_id=hold.attempt_id;
 IF FOUND THEN
  IF previous.lease_id IS DISTINCT FROM p_lease OR previous.lease_epoch IS DISTINCT FROM p_epoch THEN
   RAISE EXCEPTION 'DISPATCH_FENCE_REJECTED' USING ERRCODE='23514';
  END IF;
  IF previous.binding_digest<>binding THEN RAISE EXCEPTION 'DISPATCH_BINDING_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN hold.attempt_id;
 END IF;
 IF hold.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM telemetry.dispatch_reservation_releases
  WHERE project_id=p_project AND reservation_id=p_reservation) THEN
  RAISE EXCEPTION 'DISPATCH_RESERVATION_INVALID' USING ERRCODE='22023';
 END IF;
 INSERT INTO telemetry.dispatch_attempts(project_id,attempt_id,reservation_id,lifecycle_id,task_id,lease_id,lease_epoch,
  execution_ref,generation_ref,pipeline_session_id,route_version,provider,model,prompt_id,prompt_version,prompt_hmac_ref,key_version,binding_digest)
 VALUES(p_project,hold.attempt_id,p_reservation,p_lifecycle,p_task,p_lease,p_epoch,p_lease,p_epoch::text,
  pipeline,'managed-dispatch-v1',p_provider,p_model,p_prompt,p_version,p_hmac,p_key_version,binding);
 INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,event_digest,actor_ref)
 VALUES(p_project,hold.attempt_id,1,'PREPARED',binding,session_user);
 RETURN hold.attempt_id;
END $$;
ALTER FUNCTION telemetry.prepare_dispatch_attempt(UUID,UUID,UUID,UUID,UUID,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.prepare_dispatch_attempt(UUID,UUID,UUID,UUID,UUID,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telemetry.prepare_dispatch_attempt(UUID,UUID,UUID,UUID,UUID,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO telemetry_dispatch_writer;

CREATE OR REPLACE FUNCTION telemetry.start_dispatch_attempt(p_project UUID,p_attempt UUID,p_lease UUID,p_epoch BIGINT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE attempt telemetry.dispatch_attempts%ROWTYPE; prior_digest TEXT; start_time TIMESTAMPTZ;
BEGIN
 IF NOT telemetry.dispatch_writer_authorized(p_project) THEN
  RAISE EXCEPTION 'DISPATCH_AUTHORITY_DENIED' USING ERRCODE='42501';
 END IF;
 SELECT * INTO attempt FROM telemetry.dispatch_attempts WHERE project_id=p_project AND attempt_id=p_attempt;
 IF NOT FOUND OR attempt.lease_id IS DISTINCT FROM p_lease OR attempt.lease_epoch IS DISTINCT FROM p_epoch THEN
  RAISE EXCEPTION 'DISPATCH_FENCE_REJECTED' USING ERRCODE='23514';
 END IF;
 PERFORM telemetry.lock_dispatch_fence(p_project,attempt.reservation_id,attempt.task_id,p_lease,p_epoch);
 IF EXISTS(SELECT 1 FROM telemetry.dispatch_events WHERE project_id=p_project AND attempt_id=p_attempt AND kind='DISPATCH_STARTED') THEN
  RETURN 'duplicate';
 END IF;
 start_time:=clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM telemetry.dispatch_reservations r WHERE r.project_id=p_project
  AND r.reservation_id=attempt.reservation_id AND r.expires_at>start_time
  AND r.lease_id=p_lease AND r.lease_epoch=p_epoch)
  OR EXISTS(SELECT 1 FROM telemetry.dispatch_reservation_releases WHERE project_id=p_project AND reservation_id=attempt.reservation_id) THEN
  RAISE EXCEPTION 'DISPATCH_RESERVATION_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT event_digest INTO prior_digest FROM telemetry.dispatch_events
  WHERE project_id=p_project AND attempt_id=p_attempt AND kind='PREPARED';
 IF NOT FOUND THEN RAISE EXCEPTION 'DISPATCH_RESERVATION_INVALID' USING ERRCODE='22023'; END IF;
 INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,prior_digest,event_digest,actor_ref,recorded_at)
 VALUES(p_project,p_attempt,2,'DISPATCH_STARTED','PREPARED',prior_digest,
  encode(public.digest(convert_to(jsonb_build_array('dispatch-start-v1',p_project,p_attempt,prior_digest,
   session_user,extract(epoch FROM start_time))::text,'UTF8'),'sha256'),'hex'),session_user,start_time);
 RETURN 'recorded';
END $$;
ALTER FUNCTION telemetry.start_dispatch_attempt(UUID,UUID,UUID,BIGINT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.start_dispatch_attempt(UUID,UUID,UUID,BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telemetry.start_dispatch_attempt(UUID,UUID,UUID,BIGINT) TO telemetry_dispatch_writer;
COMMIT;
