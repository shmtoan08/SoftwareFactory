BEGIN;
CREATE TABLE IF NOT EXISTS task_execution_assignments (
  assignment_id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  task_id UUID NOT NULL UNIQUE,
  profile_id UUID NOT NULL,
  profile_snapshot JSONB NOT NULL CHECK(jsonb_typeof(profile_snapshot)='object'),
  profile_sha256 TEXT NOT NULL CHECK(profile_sha256 ~ '^[a-f0-9]{64}$'),
  task_contract_sha256 TEXT NOT NULL CHECK(task_contract_sha256 ~ '^[a-f0-9]{64}$'),
  target_key TEXT NOT NULL CHECK(target_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  worker_id TEXT NOT NULL CHECK(worker_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  public_context TEXT NOT NULL CHECK(octet_length(public_context)<=16384),
  data_classification TEXT NOT NULL CHECK(data_classification='PUBLIC'),
  approved_by_principal_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(assignment_id,project_id,task_id),
  FOREIGN KEY(task_id,project_id) REFERENCES tasks(task_id,project_id),
  FOREIGN KEY(profile_id,project_id) REFERENCES agent_organization_profiles(profile_id,project_id)
);
ALTER TABLE task_leases ADD COLUMN IF NOT EXISTS execution_target_assignment_id UUID NULL;
ALTER TABLE task_leases ADD COLUMN IF NOT EXISTS execution_target_request_id UUID NULL;
ALTER TABLE task_leases DROP CONSTRAINT IF EXISTS fk_lease_execution_assignment;
ALTER TABLE task_leases ADD CONSTRAINT fk_lease_execution_assignment FOREIGN KEY(execution_target_assignment_id,project_id,task_id) REFERENCES task_execution_assignments(assignment_id,project_id,task_id);
ALTER TABLE task_leases DROP CONSTRAINT IF EXISTS chk_lease_target_request;
ALTER TABLE task_leases ADD CONSTRAINT chk_lease_target_request CHECK((execution_target_assignment_id IS NULL)=(execution_target_request_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS uq_lease_target_request ON task_leases(project_id,execution_target_request_id) WHERE execution_target_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lease_target_scope ON task_leases(lease_id,project_id,task_id);
CREATE TABLE IF NOT EXISTS target_dispatches (
  lease_id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  assignment_id UUID NOT NULL,
  execution_request_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','IMPORTED','UNKNOWN','REJECTED')),
  health_sha256 TEXT NULL CHECK(health_sha256 IS NULL OR health_sha256 ~ '^[a-f0-9]{64}$'),
  submission_id UUID NULL REFERENCES code_import_submissions(submission_id),
  error_code TEXT NULL CHECK(error_code IS NULL OR error_code IN ('ERR_TARGET_UNCERTAIN','ERR_TARGET_IMPORT_REJECTED')),
  claimed_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  UNIQUE(project_id,execution_request_id),
  FOREIGN KEY(lease_id,project_id,task_id) REFERENCES task_leases(lease_id,project_id,task_id),
  FOREIGN KEY(assignment_id,project_id,task_id) REFERENCES task_execution_assignments(assignment_id,project_id,task_id)
);
CREATE OR REPLACE FUNCTION sf_execution_profile_snapshot(p agent_organization_profiles) RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
 SELECT jsonb_build_object('profile_id',p.profile_id,'project_id',p.project_id,'profile_key',p.profile_key,'role',p.role,'principal_id',p.principal_id,'provider',p.provider,'model',p.model,
 'execution_target_type',p.execution_target_type,'trust_tier',p.trust_tier,'target_locator',p.target_locator,'capabilities_json',p.capabilities_json,'is_active',p.is_active);
$$;
CREATE OR REPLACE FUNCTION fn_execution_assignment_guard() RETURNS trigger AS $$
DECLARE t tasks%ROWTYPE; p agent_organization_profiles%ROWTYPE; planned UUID;
BEGIN
 SELECT * INTO t FROM tasks WHERE task_id=NEW.task_id AND project_id=NEW.project_id FOR UPDATE;
 SELECT * INTO p FROM agent_organization_profiles WHERE profile_id=NEW.profile_id AND project_id=NEW.project_id;
 SELECT assigned_profile_id INTO planned FROM task_plan_links WHERE task_id=NEW.task_id AND project_id=NEW.project_id;
 IF NOT COALESCE(t.current_attempt_no=0 AND t.status IN ('Ready','ReworkRequired') AND NOT EXISTS(SELECT 1 FROM task_leases WHERE task_id=t.task_id)
   AND p.role='DEVELOPER' AND p.is_active AND p.execution_target_type<>'factory_managed_worker'
   AND (planned IS NULL OR planned=p.profile_id) AND NEW.target_key=p.target_locator
   AND NEW.profile_snapshot=sf_execution_profile_snapshot(p)
   AND NEW.profile_sha256=encode(digest(sf_canonical_json(NEW.profile_snapshot),'sha256'),'hex')
   AND NEW.task_contract_sha256=encode(digest(sf_canonical_json(t.task_contract_json),'sha256'),'hex')
   AND NEW.approved_by_principal_id=current_app_principal_id()
   AND EXISTS(SELECT 1 FROM project_memberships WHERE project_id=NEW.project_id AND principal_id=NEW.approved_by_principal_id AND member_role IN ('PROJECT_APPROVER','ORG_ADMIN')),false) THEN
   RAISE EXCEPTION 'Execution assignment requires exact active profile, unstarted task and project approver' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_execution_assignment_guard ON task_execution_assignments;
CREATE TRIGGER trg_execution_assignment_guard BEFORE INSERT ON task_execution_assignments FOR EACH ROW EXECUTE FUNCTION fn_execution_assignment_guard();
-- Keep the approved path/trusted-policy contract stable across all import paths.
CREATE OR REPLACE FUNCTION fn_assigned_task_contract_guard() RETURNS trigger AS $$
BEGIN
 IF NEW.task_contract_json IS DISTINCT FROM OLD.task_contract_json
   AND EXISTS(SELECT 1 FROM task_execution_assignments WHERE task_id=OLD.task_id AND project_id=OLD.project_id) THEN
   RAISE EXCEPTION 'Approved execution task contract is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_assigned_task_contract_guard ON tasks;
CREATE TRIGGER trg_assigned_task_contract_guard BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION fn_assigned_task_contract_guard();
CREATE OR REPLACE FUNCTION fn_target_lease_guard() RETURNS trigger AS $$
DECLARE a task_execution_assignments%ROWTYPE; p agent_organization_profiles%ROWTYPE; t tasks%ROWTYPE; planned UUID;
BEGIN
 IF TG_OP='UPDATE' THEN
   IF NEW.execution_target_assignment_id IS DISTINCT FROM OLD.execution_target_assignment_id OR NEW.execution_target_request_id IS DISTINCT FROM OLD.execution_target_request_id
     OR (OLD.execution_target_assignment_id IS NOT NULL AND (NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch)) THEN
     RAISE EXCEPTION 'Lease execution target binding is immutable' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 SELECT * INTO t FROM tasks WHERE task_id=NEW.task_id AND project_id=NEW.project_id FOR UPDATE;
 SELECT * INTO a FROM task_execution_assignments WHERE task_id=NEW.task_id AND project_id=NEW.project_id;
 SELECT assigned_profile_id INTO planned FROM task_plan_links WHERE task_id=NEW.task_id AND project_id=NEW.project_id;
 IF a.assignment_id IS NULL THEN
   SELECT * INTO p FROM agent_organization_profiles WHERE profile_id=planned AND project_id=NEW.project_id;
   IF NEW.execution_target_assignment_id IS NOT NULL OR NEW.execution_target_request_id IS NOT NULL OR (planned IS NOT NULL AND (NOT p.is_active OR p.role<>'DEVELOPER' OR p.execution_target_type<>'factory_managed_worker')) THEN
     RAISE EXCEPTION 'External target dispatch requires an approved execution assignment' USING ERRCODE='23514';
   END IF;
 ELSE
   SELECT * INTO p FROM agent_organization_profiles WHERE profile_id=a.profile_id AND project_id=NEW.project_id;
   IF NOT COALESCE(NEW.execution_target_assignment_id=a.assignment_id AND NEW.execution_target_request_id IS NOT NULL AND NEW.worker_id=a.worker_id
     AND p.is_active AND (planned IS NULL OR planned=p.profile_id)
     AND a.profile_sha256=encode(digest(sf_canonical_json(sf_execution_profile_snapshot(p)),'sha256'),'hex')
     AND a.task_contract_sha256=encode(digest(sf_canonical_json(t.task_contract_json),'sha256'),'hex'),false) THEN
     RAISE EXCEPTION 'Target dispatch binding or approved profile/contract changed' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_target_lease_guard ON task_leases;
CREATE TRIGGER trg_target_lease_guard BEFORE INSERT OR UPDATE ON task_leases FOR EACH ROW EXECUTE FUNCTION fn_target_lease_guard();
CREATE OR REPLACE FUNCTION fn_create_target_dispatch() RETURNS trigger AS $$
BEGIN
 IF NEW.execution_target_assignment_id IS NOT NULL THEN
   INSERT INTO target_dispatches(lease_id,project_id,task_id,assignment_id,execution_request_id) VALUES(NEW.lease_id,NEW.project_id,NEW.task_id,NEW.execution_target_assignment_id,NEW.execution_target_request_id);
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_create_target_dispatch ON task_leases;
CREATE TRIGGER trg_create_target_dispatch AFTER INSERT ON task_leases FOR EACH ROW EXECUTE FUNCTION fn_create_target_dispatch();
CREATE OR REPLACE FUNCTION fn_target_dispatch_guard() RETURNS trigger AS $$
DECLARE bound_lease task_leases%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' THEN
   SELECT * INTO bound_lease FROM task_leases WHERE lease_id=NEW.lease_id AND project_id=NEW.project_id;
   IF NOT COALESCE(bound_lease.task_id=NEW.task_id AND bound_lease.execution_target_assignment_id=NEW.assignment_id AND bound_lease.execution_target_request_id=NEW.execution_request_id
     AND NEW.status='PENDING' AND NEW.health_sha256 IS NULL AND NEW.submission_id IS NULL AND NEW.error_code IS NULL AND NEW.claimed_at IS NULL AND NEW.completed_at IS NULL,false) THEN
     RAISE EXCEPTION 'Target dispatch must bind an approved lease' USING ERRCODE='23514';
   END IF;
 ELSE
   IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
   IF (to_jsonb(NEW)-ARRAY['status','health_sha256','submission_id','error_code','claimed_at','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','health_sha256','submission_id','error_code','claimed_at','completed_at']) THEN
     RAISE EXCEPTION 'Target dispatch identity is immutable' USING ERRCODE='23514';
   END IF;
   IF OLD.status='PENDING' AND NEW.status='SENDING' THEN
     IF NEW.health_sha256 IS NULL OR NEW.claimed_at IS NULL OR NEW.completed_at IS NOT NULL OR NEW.submission_id IS NOT NULL OR NEW.error_code IS NOT NULL
       OR NOT EXISTS(SELECT 1 FROM task_leases l JOIN tasks t ON t.task_id=l.task_id AND t.project_id=l.project_id JOIN task_execution_assignments a ON a.assignment_id=l.execution_target_assignment_id AND a.project_id=l.project_id JOIN agent_organization_profiles p ON p.profile_id=a.profile_id AND p.project_id=a.project_id WHERE l.lease_id=NEW.lease_id AND l.project_id=NEW.project_id AND l.status='ACTIVE' AND l.expires_at>clock_timestamp() AND t.active_lease_id=l.lease_id AND p.is_active AND a.profile_sha256=encode(digest(sf_canonical_json(sf_execution_profile_snapshot(p)),'sha256'),'hex') AND a.task_contract_sha256=encode(digest(sf_canonical_json(t.task_contract_json),'sha256'),'hex')) THEN
       RAISE EXCEPTION 'Invalid target dispatch claim' USING ERRCODE='23514';
     END IF;
   ELSIF (OLD.status='SENDING' AND NEW.status IN ('IMPORTED','UNKNOWN','REJECTED')) OR (OLD.status='UNKNOWN' AND NEW.status='IMPORTED') THEN
     IF NEW.claimed_at IS DISTINCT FROM OLD.claimed_at OR NEW.health_sha256 IS DISTINCT FROM OLD.health_sha256 OR NEW.completed_at IS NULL THEN
       RAISE EXCEPTION 'Invalid target dispatch completion' USING ERRCODE='23514';
     END IF;
     IF NEW.status='IMPORTED' THEN
       IF NEW.error_code IS NOT NULL OR NOT EXISTS(SELECT 1 FROM code_import_submissions WHERE submission_id=NEW.submission_id AND lease_id=NEW.lease_id AND project_id=NEW.project_id AND task_id=NEW.task_id) THEN
         RAISE EXCEPTION 'Target import requires the bound controlled receipt' USING ERRCODE='23514';
       END IF;
     ELSIF NEW.submission_id IS NOT NULL OR NEW.error_code IS NULL THEN RAISE EXCEPTION 'Invalid target failure evidence' USING ERRCODE='23514'; END IF;
   ELSE RAISE EXCEPTION 'Invalid target dispatch state transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_target_dispatch_guard ON target_dispatches;
CREATE TRIGGER trg_target_dispatch_guard BEFORE INSERT OR UPDATE ON target_dispatches FOR EACH ROW EXECUTE FUNCTION fn_target_dispatch_guard();
CREATE OR REPLACE FUNCTION fn_target_verification_guard() RETURNS trigger AS $$
DECLARE a UUID; assignment UUID; planned UUID; kind TEXT;
BEGIN
 SELECT l.execution_target_assignment_id INTO a FROM merge_candidates mc JOIN verified_code_imports v ON v.import_id=mc.import_id AND v.project_id=mc.project_id JOIN task_leases l ON l.lease_id=v.lease_id AND l.project_id=v.project_id WHERE mc.merge_candidate_id=NEW.merge_candidate_id AND mc.project_id=NEW.project_id;
 SELECT assignment_id INTO assignment FROM task_execution_assignments WHERE project_id=NEW.project_id AND task_id=NEW.task_id;
 SELECT p.execution_target_type INTO kind FROM task_plan_links tpl JOIN agent_organization_profiles p ON p.profile_id=tpl.assigned_profile_id AND p.project_id=tpl.project_id WHERE tpl.project_id=NEW.project_id AND tpl.task_id=NEW.task_id;
 IF a IS NOT NULL THEN
   IF assignment IS DISTINCT FROM a OR NOT COALESCE(NEW.isolation_runtime='runsc' AND NEW.execution_backend='docker' AND NEW.is_docker_isolated AND NEW.hermetic_network_disabled AND NEW.verifier_image_digest ~ '^sha256:[a-f0-9]{64}$',false) THEN
     RAISE EXCEPTION 'External target verification requires approved lease provenance and network-disabled runsc' USING ERRCODE='23514';
   END IF;
 ELSIF assignment IS NOT NULL OR (kind IS NOT NULL AND kind<>'factory_managed_worker') THEN
   RAISE EXCEPTION 'External target verification is missing approved lease provenance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_target_verification_guard ON verification_runs;
CREATE TRIGGER trg_target_verification_guard BEFORE INSERT ON verification_runs FOR EACH ROW EXECUTE FUNCTION fn_target_verification_guard();
DO $$ DECLARE tbl TEXT; BEGIN
 FOREACH tbl IN ARRAY ARRAY['task_execution_assignments','target_dispatches'] LOOP
   EXECUTE format('ALTER TABLE %I OWNER TO db_migrator',tbl);
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
   EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,app_runtime',tbl);EXECUTE format('GRANT SELECT,INSERT ON %I TO app_runtime',tbl);
   EXECUTE format('DROP POLICY IF EXISTS target_scope ON %I',tbl);
   EXECUTE format('CREATE POLICY target_scope ON %I USING(project_id=current_app_project_id() AND current_app_role()=''core_api_service'') WITH CHECK(project_id=current_app_project_id() AND current_app_role()=''core_api_service'')',tbl);
 END LOOP;
END $$;
-- Lease/import/verification triggers also execute in gateway scope. They must see
-- the same immutable assignment to reject an unbound alternate import path.
DROP POLICY IF EXISTS target_scope ON task_execution_assignments;
DROP POLICY IF EXISTS target_assignment_read ON task_execution_assignments;
DROP POLICY IF EXISTS target_assignment_insert ON task_execution_assignments;
CREATE POLICY target_assignment_read ON task_execution_assignments FOR SELECT USING(project_id=current_app_project_id());
CREATE POLICY target_assignment_insert ON task_execution_assignments FOR INSERT WITH CHECK(project_id=current_app_project_id() AND current_app_role()='core_api_service');
GRANT UPDATE(status,health_sha256,submission_id,error_code,claimed_at,completed_at) ON target_dispatches TO app_runtime;
COMMIT;
