\set ON_ERROR_STOP on
BEGIN;
-- Administrative fixture writes only; all changes rolled back.
INSERT INTO public.projects(project_id,slug,name,repo_bare_path) VALUES('10000000-0000-0000-0000-000000000017','telemetry-authority-17','Telemetry authority fixture','/unused');
INSERT INTO public.model_cost_sessions(cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd)
VALUES('20000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000017',10,10,100,100);
INSERT INTO telemetry.invocations(invocation_id,project_id,cost_session_id,binding_state,binding_reason,provider,model,prompt_id,prompt_version,prompt_hmac_ref,key_version,mapping_id,binding_digest)
VALUES('30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000017','20000000-0000-0000-0000-000000000017','CALL_ONLY','execution-authority-unavailable','anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED',repeat('b',64));
DO $$ DECLARE r TEXT; BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='telemetry.invocations'::regclass AND relrowsecurity AND relforcerowsecurity) THEN RAISE EXCEPTION 'Missing FORCE RLS'; END IF;
  IF EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='telemetry.invocations'::regclass) THEN RAISE EXCEPTION 'Unexpected opening policy'; END IF;
  FOREACH r IN ARRAY ARRAY['app_runtime','telemetry_ingestor','telemetry_reporter','telemetry_operator'] LOOP
    EXECUTE format('SET SESSION AUTHORIZATION %I',r);
    PERFORM set_config('app.current_project_id','10000000-0000-0000-0000-000000000017',true);
    PERFORM set_config('app.current_role','system_admin_role',true);
    BEGIN PERFORM 1 FROM telemetry.invocations; RAISE EXCEPTION 'Read was allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN EXECUTE 'INSERT INTO telemetry.invocations DEFAULT VALUES'; RAISE EXCEPTION 'Write was allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN EXECUTE 'SET LOCAL ROLE telemetry_owner'; RAISE EXCEPTION 'Role escalation allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET SESSION AUTHORIZATION;
  END LOOP;
  -- Even table owner is denied by FORCE RLS, with no policy.
  SET LOCAL ROLE telemetry_owner;
  IF EXISTS(SELECT 1 FROM telemetry.invocations) THEN RAISE EXCEPTION 'Owner bypassed FORCE RLS'; END IF;
  RESET ROLE;
  BEGIN UPDATE telemetry.invocations SET model='changed'; RAISE EXCEPTION 'Update allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM telemetry.invocations; RAISE EXCEPTION 'Delete allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN TRUNCATE telemetry.invocations; RAISE EXCEPTION 'Truncate allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO telemetry.invocations SELECT gen_random_uuid(),project_id,task_id,cost_session_id,pipeline_session_id,'TASK_BOUND',binding_reason,provider,model,prompt_id,prompt_version,prompt_hmac_ref,key_version,mapping_id,created_at,binding_digest FROM telemetry.invocations;
    RAISE EXCEPTION 'TASK_BOUND enabled prematurely';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
