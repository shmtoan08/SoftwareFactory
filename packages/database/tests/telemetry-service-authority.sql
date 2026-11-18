\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE sf_telemetry_test_writer LOGIN NOINHERIT;
CREATE ROLE sf_telemetry_test_reader LOGIN NOINHERIT;
CREATE ROLE sf_telemetry_test_unbound LOGIN NOINHERIT;
GRANT telemetry_ingestor TO sf_telemetry_test_writer,sf_telemetry_test_unbound;
GRANT telemetry_reporter TO sf_telemetry_test_reader;
INSERT INTO public.projects(project_id,slug,name,repo_bare_path) VALUES
 ('10000000-0000-0000-0000-000000000018','telemetry-a2-a','A','/unused'),
 ('10000000-0000-0000-0000-000000000019','telemetry-a2-b','B','/unused');
INSERT INTO public.model_cost_sessions(cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd) VALUES
 ('20000000-0000-0000-0000-000000000018','10000000-0000-0000-0000-000000000018',10,10,100,100),
 ('20000000-0000-0000-0000-000000000019','10000000-0000-0000-0000-000000000019',10,10,100,100);
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000018','ingest' FROM pg_roles WHERE rolname='sf_telemetry_test_writer';
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000018','read' FROM pg_roles WHERE rolname='sf_telemetry_test_reader';
SET SESSION AUTHORIZATION sf_telemetry_test_writer;
SET ROLE telemetry_ingestor;
SELECT telemetry.register_call('30000000-0000-0000-0000-000000000018','10000000-0000-0000-0000-000000000018','20000000-0000-0000-0000-000000000018',NULL,NULL,'anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED');
-- Identical retry succeeds without another row or a mutation.
SELECT telemetry.register_call('30000000-0000-0000-0000-000000000018','10000000-0000-0000-0000-000000000018','20000000-0000-0000-0000-000000000018',NULL,NULL,'anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED');
DO $$ BEGIN
 BEGIN PERFORM telemetry.register_call('30000000-0000-0000-0000-000000000018','10000000-0000-0000-0000-000000000018','20000000-0000-0000-0000-000000000018',NULL,NULL,'anthropic','conflict','fixture','1',repeat('a',64),'1','UNVERIFIED'); RAISE EXCEPTION 'Conflict accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
 PERFORM set_config('app.current_project_id','10000000-0000-0000-0000-000000000019',true);
 BEGIN PERFORM telemetry.register_call(gen_random_uuid(),'10000000-0000-0000-0000-000000000019','20000000-0000-0000-0000-000000000019',NULL,NULL,'anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED'); RAISE EXCEPTION 'Foreign project accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM telemetry.register_call(gen_random_uuid(),'10000000-0000-0000-0000-000000000018','20000000-0000-0000-0000-000000000019',NULL,NULL,'anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED'); RAISE EXCEPTION 'Foreign FK accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN PERFORM 1 FROM telemetry.invocations; RAISE EXCEPTION 'Direct read allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO telemetry.service_projects VALUES(0,'spoof','10000000-0000-0000-0000-000000000019','ingest'); RAISE EXCEPTION 'Registry write allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM telemetry.read_calls('10000000-0000-0000-0000-000000000018'); RAISE EXCEPTION 'Writer reader permission'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION sf_telemetry_test_unbound;
SET ROLE telemetry_ingestor;
DO $$ BEGIN
 BEGIN PERFORM telemetry.register_call(gen_random_uuid(),'10000000-0000-0000-0000-000000000018','20000000-0000-0000-0000-000000000018',NULL,NULL,'anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED'); RAISE EXCEPTION 'Unbound writer accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION sf_telemetry_test_reader;
SET ROLE telemetry_reporter;
DO $$ BEGIN
 IF (SELECT count(*) FROM telemetry.read_calls('10000000-0000-0000-0000-000000000018'))<>1 THEN RAISE EXCEPTION 'Wrong row count'; END IF;
 BEGIN PERFORM telemetry.read_calls('10000000-0000-0000-0000-000000000019'); RAISE EXCEPTION 'Foreign read accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM telemetry.read_calls('10000000-0000-0000-0000-000000000018',NULL,NULL,101); RAISE EXCEPTION 'Unbounded page'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM telemetry.read_calls('10000000-0000-0000-0000-000000000018',clock_timestamp(),NULL,1); RAISE EXCEPTION 'Partial cursor accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM telemetry.register_call(gen_random_uuid(),'10000000-0000-0000-0000-000000000018','20000000-0000-0000-0000-000000000018',NULL,NULL,'anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED'); RAISE EXCEPTION 'Reader wrote'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
-- A stale principal name cannot authorize an otherwise valid OID/membership.
UPDATE telemetry.service_projects SET principal_name='stale_service' WHERE principal_name='sf_telemetry_test_reader';
SET SESSION AUTHORIZATION sf_telemetry_test_reader;
SET ROLE telemetry_reporter;
DO $$ BEGIN
 BEGIN PERFORM telemetry.read_calls('10000000-0000-0000-0000-000000000018'); RAISE EXCEPTION 'Stale identity accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
UPDATE telemetry.service_projects SET principal_name='sf_telemetry_test_reader' WHERE principal_name='stale_service';
-- A worker credential cannot become a telemetry service through a second grant.
GRANT app_runtime TO sf_telemetry_test_reader;
SET SESSION AUTHORIZATION sf_telemetry_test_reader;
SET ROLE telemetry_reporter;
DO $$ BEGIN
 BEGIN PERFORM telemetry.read_calls('10000000-0000-0000-0000-000000000018'); RAISE EXCEPTION 'Worker identity accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
REVOKE app_runtime FROM sf_telemetry_test_reader;
-- Revocation immediately affects a fresh statement; role membership alone is insufficient.
DELETE FROM telemetry.service_projects WHERE principal_name='sf_telemetry_test_reader';
SET SESSION AUTHORIZATION sf_telemetry_test_reader;
SET ROLE telemetry_reporter;
DO $$ BEGIN
 BEGIN PERFORM telemetry.read_calls('10000000-0000-0000-0000-000000000018'); RAISE EXCEPTION 'Revoked read accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
DO $$ BEGIN
 IF (SELECT count(*) FROM telemetry.invocations WHERE project_id='10000000-0000-0000-0000-000000000018')<>1 THEN RAISE EXCEPTION 'Unexpected write delta'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='telemetry'::regnamespace AND proname IN ('register_call','read_calls') AND (NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'])) THEN RAISE EXCEPTION 'Unsafe function definition'; END IF;
END $$;
ROLLBACK;
