BEGIN;
-- Exact, tenant-scoped ledger identity. No ledger column grants are added.
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_dispatch_ledger_scope
 ON public.model_call_ledgers(project_id,call_id);
ALTER TABLE telemetry.dispatch_events ADD COLUMN IF NOT EXISTS ledger_call_id UUID;
ALTER TABLE telemetry.dispatch_events DROP CONSTRAINT IF EXISTS dispatch_terminal_ledger_required;
ALTER TABLE telemetry.dispatch_events ADD CONSTRAINT dispatch_terminal_ledger_required
 CHECK((kind='TERMINAL')=(ledger_call_id IS NOT NULL));
ALTER TABLE telemetry.dispatch_events DROP CONSTRAINT IF EXISTS dispatch_terminal_ledger_scope;
ALTER TABLE telemetry.dispatch_events ADD CONSTRAINT dispatch_terminal_ledger_scope
 FOREIGN KEY(project_id,ledger_call_id) REFERENCES public.model_call_ledgers(project_id,call_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_dispatch_one_attempt_per_ledger
 ON telemetry.dispatch_events(project_id,ledger_call_id) WHERE ledger_call_id IS NOT NULL;

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='telemetry_dispatch_recovery') THEN
  CREATE ROLE telemetry_dispatch_recovery NOLOGIN NOINHERIT;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='telemetry_dispatch_recovery'
  AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit OR rolreplication))
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member='telemetry_dispatch_recovery'::regrole) THEN
  RAISE EXCEPTION 'Dispatch recovery role collision' USING ERRCODE='42501';
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS telemetry.dispatch_recovery_projects (
 principal_oid OID NOT NULL,
 principal_name NAME NOT NULL,
 project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE RESTRICT,
 PRIMARY KEY(principal_oid,project_id)
);
CREATE TABLE IF NOT EXISTS telemetry.dispatch_reservation_releases (
 project_id UUID NOT NULL,
 reservation_id UUID NOT NULL,
 actor_ref NAME NOT NULL,
 released_at TIMESTAMPTZ NOT NULL CHECK(isfinite(released_at)),
 PRIMARY KEY(project_id,reservation_id),
 FOREIGN KEY(project_id,reservation_id)
  REFERENCES telemetry.dispatch_reservations(project_id,reservation_id) ON DELETE RESTRICT
);

ALTER TABLE telemetry.dispatch_recovery_projects OWNER TO telemetry_owner;
ALTER TABLE telemetry.dispatch_recovery_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.dispatch_recovery_projects FORCE ROW LEVEL SECURITY;
ALTER TABLE telemetry.dispatch_reservation_releases OWNER TO telemetry_owner;
ALTER TABLE telemetry.dispatch_reservation_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.dispatch_reservation_releases FORCE ROW LEVEL SECURITY;
REVOKE ALL ON telemetry.dispatch_recovery_projects,telemetry.dispatch_reservation_releases
 FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator,telemetry_dispatch_recovery;
DROP POLICY IF EXISTS recovery_registry_read ON telemetry.dispatch_recovery_projects;
CREATE POLICY recovery_registry_read ON telemetry.dispatch_recovery_projects FOR SELECT TO telemetry_owner USING(true);
DROP TRIGGER IF EXISTS dispatch_release_immutable ON telemetry.dispatch_reservation_releases;
CREATE TRIGGER dispatch_release_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON telemetry.dispatch_reservation_releases
 FOR EACH STATEMENT EXECUTE FUNCTION telemetry.reject_mutation();

CREATE OR REPLACE FUNCTION telemetry.dispatch_recovery_authorized(p_project UUID) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM pg_catalog.pg_roles r JOIN telemetry.dispatch_recovery_projects p
   ON p.principal_oid=r.oid AND p.principal_name=r.rolname
  WHERE r.rolname=session_user AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole
   AND NOT r.rolcreatedb AND NOT r.rolbypassrls AND NOT r.rolreplication
   AND NOT pg_has_role(r.oid,'app_runtime','MEMBER')
   AND pg_has_role(r.oid,'telemetry_dispatch_recovery','MEMBER') AND p.project_id=p_project);
$$;
ALTER FUNCTION telemetry.dispatch_recovery_authorized(UUID) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.dispatch_recovery_authorized(UUID) FROM PUBLIC;

DROP POLICY IF EXISTS dispatch_recovery_read ON telemetry.dispatch_reservations;
CREATE POLICY dispatch_recovery_read ON telemetry.dispatch_reservations FOR SELECT TO telemetry_owner
 USING(telemetry.dispatch_recovery_authorized(project_id));
DROP POLICY IF EXISTS dispatch_recovery_read ON telemetry.dispatch_events;
CREATE POLICY dispatch_recovery_read ON telemetry.dispatch_events FOR SELECT TO telemetry_owner
 USING(telemetry.dispatch_recovery_authorized(project_id));
DROP POLICY IF EXISTS dispatch_recovery_event_insert ON telemetry.dispatch_events;
CREATE POLICY dispatch_recovery_event_insert ON telemetry.dispatch_events FOR INSERT TO telemetry_owner
 WITH CHECK(kind='CONFIRMED_NOT_SENT' AND telemetry.dispatch_recovery_authorized(project_id));
DROP POLICY IF EXISTS dispatch_recovery_read ON telemetry.dispatch_reservation_releases;
CREATE POLICY dispatch_recovery_read ON telemetry.dispatch_reservation_releases FOR SELECT TO telemetry_owner
 USING(telemetry.dispatch_recovery_authorized(project_id));
DROP POLICY IF EXISTS dispatch_recovery_insert ON telemetry.dispatch_reservation_releases;
CREATE POLICY dispatch_recovery_insert ON telemetry.dispatch_reservation_releases FOR INSERT TO telemetry_owner
 WITH CHECK(telemetry.dispatch_recovery_authorized(project_id));

-- Prepare and start must take this same transaction lock before consulting
-- release evidence. Only READ COMMITTED can see commits made while waiting.
CREATE OR REPLACE FUNCTION telemetry.release_expired_dispatch_reservation(p_project UUID,p_reservation UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE hold telemetry.dispatch_reservations%ROWTYPE; release_time TIMESTAMPTZ; prepared_digest TEXT;
BEGIN
 IF NOT telemetry.dispatch_recovery_authorized(p_project) THEN
  RAISE EXCEPTION 'DISPATCH_AUTHORITY_DENIED' USING ERRCODE='42501';
 END IF;
 IF p_reservation IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'DISPATCH_RESERVATION_INVALID' USING ERRCODE='22023';
 END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(p_project::text||':'||p_reservation::text,2929)) THEN
  RAISE EXCEPTION 'DISPATCH_FENCE_REJECTED' USING ERRCODE='55P03';
 END IF;
 SELECT * INTO hold FROM telemetry.dispatch_reservations
  WHERE project_id=p_project AND reservation_id=p_reservation;
 IF NOT FOUND THEN RETURN 'missing'; END IF;
 IF EXISTS(SELECT 1 FROM telemetry.dispatch_reservation_releases
  WHERE project_id=p_project AND reservation_id=p_reservation) THEN RETURN 'duplicate'; END IF;
 release_time:=clock_timestamp();
 IF hold.expires_at>release_time THEN RETURN 'active'; END IF;
 IF EXISTS(SELECT 1 FROM telemetry.dispatch_events
  WHERE project_id=p_project AND attempt_id=hold.attempt_id AND kind='DISPATCH_STARTED') THEN
  RETURN 'held_for_settlement';
 END IF;
 INSERT INTO telemetry.dispatch_reservation_releases(project_id,reservation_id,actor_ref,released_at)
 VALUES(p_project,p_reservation,session_user,release_time);
 SELECT event_digest INTO prepared_digest FROM telemetry.dispatch_events
  WHERE project_id=p_project AND attempt_id=hold.attempt_id AND kind='PREPARED';
 IF FOUND THEN
  INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,prior_digest,event_digest,actor_ref,recorded_at)
  VALUES(p_project,hold.attempt_id,2,'CONFIRMED_NOT_SENT','PREPARED',prepared_digest,
   encode(public.digest(convert_to(jsonb_build_array('dispatch-expiry-v1',p_project,hold.attempt_id,
    prepared_digest,session_user,extract(epoch FROM release_time))::text,'UTF8'),'sha256'),'hex'),session_user,release_time);
 END IF;
 RETURN 'released';
END $$;
ALTER FUNCTION telemetry.release_expired_dispatch_reservation(UUID,UUID) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.release_expired_dispatch_reservation(UUID,UUID) FROM PUBLIC;
GRANT USAGE ON SCHEMA telemetry TO telemetry_dispatch_recovery;
GRANT EXECUTE ON FUNCTION telemetry.release_expired_dispatch_reservation(UUID,UUID) TO telemetry_dispatch_recovery;
COMMIT;
