BEGIN;
ALTER TABLE public.production_deployments ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_deployment_reconciliation_scope ON public.production_deployments(deployment_id,project_id,approval_id);
CREATE TABLE IF NOT EXISTS public.production_reconciliation_approvals (
  reconciliation_approval_id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  deployment_id UUID NOT NULL,
  original_approval_id UUID NOT NULL,
  deployment_binding_sha256 TEXT NOT NULL CHECK(deployment_binding_sha256 ~ '^[a-f0-9]{64}$'),
  expected_status TEXT NOT NULL CHECK(expected_status IN ('RUNNING','UNKNOWN')),
  evidence JSONB NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  approver_principal_id TEXT NOT NULL CHECK(btrim(approver_principal_id)<>''),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '15 minutes'),
  token_sha256 TEXT NOT NULL CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CONSUMED','REVOKED')),
  UNIQUE(reconciliation_approval_id,project_id,deployment_id,original_approval_id),
  FOREIGN KEY(deployment_id,project_id,original_approval_id) REFERENCES public.production_deployments(deployment_id,project_id,approval_id)
);
CREATE TABLE IF NOT EXISTS public.production_deployment_reconciliations (
  reconciliation_id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  deployment_id UUID NOT NULL UNIQUE,
  original_approval_id UUID NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('SUCCEEDED','NOT_DEPLOYED')),
  evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  approver_principal_id TEXT NOT NULL,
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(reconciliation_id,project_id,deployment_id,original_approval_id)
    REFERENCES public.production_reconciliation_approvals(reconciliation_approval_id,project_id,deployment_id,original_approval_id)
);
CREATE OR REPLACE FUNCTION public.sf_deployment_binding_sha256(a public.production_deployment_approvals,d public.production_deployments)
RETURNS TEXT LANGUAGE SQL STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  SELECT encode(public.digest(public.sf_canonical_json(jsonb_build_object(
    'deployment_id',d.deployment_id,'project_id',d.project_id,'original_approval_id',a.approval_id,
    'release_id',a.release_id,'release_package_sha256',a.release_package_sha256,'commit_hash',a.commit_hash,
    'artifact_sha256',a.artifact_sha256,'target_key',a.target_key,
    'started_at',to_char(d.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )),'sha256'),'hex');
$$;
CREATE OR REPLACE FUNCTION public.fn_reconciliation_approval_guard() RETURNS trigger AS $$
DECLARE d public.production_deployments%ROWTYPE; a public.production_deployment_approvals%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR OLD.status<>'ACTIVE' OR NEW.status NOT IN ('CONSUMED','REVOKED') OR NEW.approver_principal_id IS DISTINCT FROM public.current_app_principal_id() THEN
      RAISE EXCEPTION 'Reconciliation approval is immutable except consumption' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO d FROM public.production_deployments WHERE deployment_id=NEW.deployment_id AND project_id=NEW.project_id FOR UPDATE;
  SELECT * INTO a FROM public.production_deployment_approvals WHERE approval_id=d.approval_id AND project_id=NEW.project_id;
  IF NOT COALESCE(d.approval_id=NEW.original_approval_id AND d.status=NEW.expected_status AND d.status IN ('RUNNING','UNKNOWN')
    AND d.reconciled_at IS NULL AND NEW.status='ACTIVE' AND NEW.issued_at<=clock_timestamp() AND NEW.expires_at>clock_timestamp()
    AND NEW.deployment_binding_sha256=public.sf_deployment_binding_sha256(a,d)
    AND NEW.approver_principal_id=public.current_app_principal_id()
    AND EXISTS(SELECT 1 FROM public.project_memberships WHERE project_id=NEW.project_id AND principal_id=NEW.approver_principal_id AND member_role IN ('PROJECT_APPROVER','ORG_ADMIN'))
    AND (SELECT count(*) FROM jsonb_object_keys(NEW.evidence))=5
    AND NEW.evidence ?& ARRAY['outcome','terminal_fence','provider_operation_id','artifact_sha256','evidence_sha256']
    AND NEW.evidence->'terminal_fence'='true'::jsonb
    AND jsonb_typeof(NEW.evidence->'provider_operation_id')='string'
    AND length(NEW.evidence->>'provider_operation_id') BETWEEN 1 AND 256
    AND NEW.evidence->>'provider_operation_id' ~ '^[A-Za-z0-9._:/-]+$'
    AND jsonb_typeof(NEW.evidence->'evidence_sha256')='string'
    AND NEW.evidence->>'evidence_sha256' ~ '^[a-f0-9]{64}$'
    AND ((NEW.evidence->>'outcome'='SUCCEEDED' AND jsonb_typeof(NEW.evidence->'artifact_sha256')='string' AND NEW.evidence->>'artifact_sha256'=a.artifact_sha256)
      OR (NEW.evidence->>'outcome'='NOT_DEPLOYED' AND NEW.evidence->'artifact_sha256'='null'::jsonb)),false) THEN
    RAISE EXCEPTION 'Reconciliation requires exact unresolved snapshot, authenticated approver and terminal-fence evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_reconciliation_approval_guard ON public.production_reconciliation_approvals;
CREATE TRIGGER trg_reconciliation_approval_guard BEFORE INSERT OR UPDATE ON public.production_reconciliation_approvals FOR EACH ROW EXECUTE FUNCTION public.fn_reconciliation_approval_guard();
CREATE OR REPLACE FUNCTION public.fn_reconciliation_guard() RETURNS trigger AS $$
DECLARE r public.production_reconciliation_approvals%ROWTYPE; d public.production_deployments%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.production_reconciliation_approvals WHERE reconciliation_approval_id=NEW.reconciliation_id AND project_id=NEW.project_id FOR UPDATE;
  SELECT * INTO d FROM public.production_deployments WHERE deployment_id=r.deployment_id AND project_id=NEW.project_id FOR UPDATE;
  IF NOT COALESCE(r.status='ACTIVE' AND r.expires_at>clock_timestamp() AND d.reconciled_at IS NULL AND d.status=r.expected_status
    AND NEW.deployment_id=d.deployment_id AND NEW.original_approval_id=r.original_approval_id
    AND NEW.outcome=r.evidence->>'outcome' AND NEW.evidence_sha256=r.evidence->>'evidence_sha256'
    AND NEW.approver_principal_id=r.approver_principal_id AND r.approver_principal_id=public.current_app_principal_id()
    AND EXISTS(SELECT 1 FROM public.project_memberships WHERE project_id=NEW.project_id AND principal_id=r.approver_principal_id AND member_role IN ('PROJECT_APPROVER','ORG_ADMIN')),false) THEN
    RAISE EXCEPTION 'Reconciliation requires a live approval bound to the unchanged deployment' USING ERRCODE='23514';
  END IF;
  NEW.reconciled_at=clock_timestamp();
  UPDATE public.production_reconciliation_approvals SET status='CONSUMED' WHERE reconciliation_approval_id=r.reconciliation_approval_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_reconciliation_guard ON public.production_deployment_reconciliations;
CREATE TRIGGER trg_reconciliation_guard BEFORE INSERT ON public.production_deployment_reconciliations FOR EACH ROW EXECUTE FUNCTION public.fn_reconciliation_guard();
-- Only an append of authorized reconciliation evidence can update this column.
-- The owner remains subject to FORCE RLS; fixed SQL and search_path are intentional.
CREATE OR REPLACE FUNCTION public.fn_apply_deployment_reconciliation() RETURNS trigger AS $$
BEGIN
  IF public.current_app_role()<>'core_api_service' OR public.current_app_project_id() IS DISTINCT FROM NEW.project_id
    OR public.current_app_principal_id() IS DISTINCT FROM NEW.approver_principal_id THEN
    RAISE EXCEPTION 'Invalid reconciliation execution scope' USING ERRCODE='42501';
  END IF;
  UPDATE public.production_deployments SET reconciled_at=NEW.reconciled_at
    WHERE deployment_id=NEW.deployment_id AND project_id=NEW.project_id AND reconciled_at IS NULL AND status IN ('RUNNING','UNKNOWN');
  IF NOT FOUND THEN RAISE EXCEPTION 'Deployment is no longer unresolved' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public;
ALTER FUNCTION public.fn_apply_deployment_reconciliation() OWNER TO db_migrator;
REVOKE ALL ON FUNCTION public.fn_apply_deployment_reconciliation() FROM PUBLIC,app_runtime;
DROP TRIGGER IF EXISTS trg_apply_deployment_reconciliation ON public.production_deployment_reconciliations;
CREATE TRIGGER trg_apply_deployment_reconciliation AFTER INSERT ON public.production_deployment_reconciliations FOR EACH ROW EXECUTE FUNCTION public.fn_apply_deployment_reconciliation();
CREATE OR REPLACE FUNCTION public.fn_production_deployment_guard() RETURNS trigger AS $$
DECLARE a public.production_deployment_approvals%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO a FROM public.production_deployment_approvals WHERE approval_id=NEW.approval_id AND project_id=NEW.project_id FOR UPDATE;
    IF NOT FOUND OR NEW.target_key<>a.target_key OR a.status<>'ACTIVE' OR a.expires_at<=clock_timestamp() OR NEW.status<>'RUNNING' OR NEW.completed_at IS NOT NULL OR NEW.receipt_sha256 IS NOT NULL OR NEW.reconciled_at IS NOT NULL THEN
      RAISE EXCEPTION 'Production deployment requires a live unused approval' USING ERRCODE='23514';
    END IF;
    IF NEW.requested_by_principal_id IS DISTINCT FROM public.current_app_principal_id() THEN RAISE EXCEPTION 'Deployment requester must match authenticated session' USING ERRCODE='42501'; END IF;
    UPDATE public.production_deployment_approvals SET status='CONSUMED' WHERE approval_id=a.approval_id;
  ELSIF NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at THEN
    IF pg_trigger_depth()<>2 OR OLD.reconciled_at IS NOT NULL OR NEW.reconciled_at IS NULL OR OLD.status NOT IN ('RUNNING','UNKNOWN')
      OR (to_jsonb(NEW)-'reconciled_at') IS DISTINCT FROM (to_jsonb(OLD)-'reconciled_at')
      OR NOT EXISTS(SELECT 1 FROM public.production_deployment_reconciliations WHERE deployment_id=NEW.deployment_id AND project_id=NEW.project_id AND reconciled_at=NEW.reconciled_at) THEN
      RAISE EXCEPTION 'Only reconciliation evidence may release a deployment hold' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.reconciled_at IS NOT NULL OR (to_jsonb(NEW)-ARRAY['status','completed_at','receipt_sha256']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','completed_at','receipt_sha256'])
    OR OLD.status<>'RUNNING' OR NEW.status NOT IN ('SUCCEEDED','UNKNOWN') OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Production deployment permits only terminal completion before reconciliation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP INDEX IF EXISTS public.uq_production_target_unresolved;
CREATE UNIQUE INDEX uq_production_target_unresolved ON public.production_deployments(project_id,target_key) WHERE status IN ('RUNNING','UNKNOWN') AND reconciled_at IS NULL;
DO $$ DECLARE tbl TEXT; BEGIN
  FOREACH tbl IN ARRAY ARRAY['production_reconciliation_approvals','production_deployment_reconciliations'] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO db_migrator',tbl);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,app_runtime',tbl);
    EXECUTE format('GRANT SELECT,INSERT ON public.%I TO app_runtime',tbl);
    EXECUTE format('DROP POLICY IF EXISTS reconciliation_scope ON public.%I',tbl);
    EXECUTE format('CREATE POLICY reconciliation_scope ON public.%I USING(project_id=public.current_app_project_id() AND public.current_app_role()=''core_api_service'') WITH CHECK(project_id=public.current_app_project_id() AND public.current_app_role()=''core_api_service'')',tbl);
  END LOOP;
END $$;
GRANT UPDATE(status) ON public.production_reconciliation_approvals TO app_runtime;
COMMIT;
