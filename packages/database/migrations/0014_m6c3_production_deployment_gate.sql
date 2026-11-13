BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS uq_release_deployment_scope ON release_acceptance_packages(release_id,project_id,pipeline_session_id);
CREATE TABLE IF NOT EXISTS production_deployment_approvals (
  approval_id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  pipeline_session_id UUID NOT NULL,
  release_id UUID NOT NULL,
  release_package_sha256 TEXT NOT NULL CHECK(release_package_sha256 ~ '^[a-f0-9]{64}$'),
  commit_hash TEXT NOT NULL CHECK(commit_hash ~ '^[a-f0-9]{40}$'),
  artifact_sha256 TEXT NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  target_key TEXT NOT NULL CHECK(target_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  approver_principal_id TEXT NOT NULL CHECK(btrim(approver_principal_id)<>''),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '1 hour'),
  token_sha256 TEXT NOT NULL CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CONSUMED','REVOKED')),
  UNIQUE(approval_id,project_id),
  FOREIGN KEY(release_id,project_id,pipeline_session_id) REFERENCES release_acceptance_packages(release_id,project_id,pipeline_session_id)
);
CREATE TABLE IF NOT EXISTS production_deployments (
  deployment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  approval_id UUID NOT NULL UNIQUE,
  target_key TEXT NOT NULL,
  requested_by_principal_id TEXT NOT NULL CHECK(btrim(requested_by_principal_id)<>''),
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','SUCCEEDED','UNKNOWN')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ NULL,
  receipt_sha256 TEXT NULL,
  FOREIGN KEY(approval_id,project_id) REFERENCES production_deployment_approvals(approval_id,project_id),
  CHECK((status='RUNNING' AND completed_at IS NULL AND receipt_sha256 IS NULL)
     OR (status='UNKNOWN' AND completed_at IS NOT NULL AND receipt_sha256 IS NULL)
     OR (status='SUCCEEDED' AND completed_at IS NOT NULL AND receipt_sha256 ~ '^[a-f0-9]{64}$' AND receipt_sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_production_target_unresolved ON production_deployments(project_id,target_key) WHERE status IN ('RUNNING','UNKNOWN');
CREATE OR REPLACE FUNCTION fn_production_approval_guard() RETURNS trigger AS $$
DECLARE r release_acceptance_packages%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO r FROM release_acceptance_packages WHERE release_id=NEW.release_id AND project_id=NEW.project_id;
    IF NOT FOUND OR r.pipeline_session_id<>NEW.pipeline_session_id OR r.package_sha256<>NEW.release_package_sha256
      OR r.main_head_commit_hash<>NEW.commit_hash OR NOT r.is_complete OR r.coverage_percent<>100
      OR NEW.approver_principal_id IS DISTINCT FROM current_app_principal_id()
      OR NOT EXISTS(SELECT 1 FROM project_memberships WHERE project_id=NEW.project_id AND principal_id=NEW.approver_principal_id AND member_role IN ('PROJECT_APPROVER','ORG_ADMIN'))
      OR NEW.status<>'ACTIVE' OR NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Production approval must bind a live accepted release' USING ERRCODE='23514';
    END IF;
  ELSIF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR OLD.status<>'ACTIVE' OR NEW.status NOT IN ('CONSUMED','REVOKED') THEN
    RAISE EXCEPTION 'Production approval is immutable except single consumption/revocation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_production_approval_guard ON production_deployment_approvals;
CREATE TRIGGER trg_production_approval_guard BEFORE INSERT OR UPDATE ON production_deployment_approvals FOR EACH ROW EXECUTE FUNCTION fn_production_approval_guard();
CREATE OR REPLACE FUNCTION fn_production_deployment_guard() RETURNS trigger AS $$
DECLARE a production_deployment_approvals%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO a FROM production_deployment_approvals WHERE approval_id=NEW.approval_id AND project_id=NEW.project_id FOR UPDATE;
    IF NOT FOUND OR NEW.target_key<>a.target_key OR a.status<>'ACTIVE' OR a.expires_at<=clock_timestamp() OR NEW.status<>'RUNNING' OR NEW.completed_at IS NOT NULL OR NEW.receipt_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'Production deployment requires a live unused approval' USING ERRCODE='23514';
    END IF;
    IF NEW.requested_by_principal_id IS DISTINCT FROM current_app_principal_id() THEN
      RAISE EXCEPTION 'Deployment requester must match authenticated session' USING ERRCODE='42501';
    END IF;
    UPDATE production_deployment_approvals SET status='CONSUMED' WHERE approval_id=a.approval_id;
  ELSIF (to_jsonb(NEW)-ARRAY['status','completed_at','receipt_sha256']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','completed_at','receipt_sha256'])
    OR OLD.status<>'RUNNING' OR NEW.status NOT IN ('SUCCEEDED','UNKNOWN') OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Production deployment permits only terminal completion' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_production_deployment_guard ON production_deployments;
CREATE TRIGGER trg_production_deployment_guard BEFORE INSERT OR UPDATE ON production_deployments FOR EACH ROW EXECUTE FUNCTION fn_production_deployment_guard();
DO $$ DECLARE tbl TEXT; BEGIN
  FOREACH tbl IN ARRAY ARRAY['production_deployment_approvals','production_deployments'] LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO db_migrator',tbl);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,app_runtime',tbl);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO app_runtime',tbl);
    EXECUTE format('DROP POLICY IF EXISTS production_scope ON %I',tbl);
    EXECUTE format('CREATE POLICY production_scope ON %I USING(project_id=current_app_project_id() AND current_app_role()=''core_api_service'') WITH CHECK(project_id=current_app_project_id() AND current_app_role()=''core_api_service'')',tbl);
  END LOOP;
END $$;
GRANT UPDATE(status) ON production_deployment_approvals TO app_runtime;
GRANT UPDATE(status,completed_at,receipt_sha256) ON production_deployments TO app_runtime;
COMMIT;
