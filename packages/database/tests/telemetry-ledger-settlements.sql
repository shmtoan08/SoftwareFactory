\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.expect_error(command TEXT, expected TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual TEXT;
BEGIN
 BEGIN EXECUTE command;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE;
  IF actual=expected THEN RETURN; END IF;
  RAISE;
 END;
 RAISE EXCEPTION 'Expected SQLSTATE %, command succeeded',expected;
END $$;
INSERT INTO public.projects(project_id,slug,name,repo_bare_path) VALUES
 ('10000000-0000-0000-0000-000000000051','telemetry-a5-a','A','/unused'),
 ('10000000-0000-0000-0000-000000000052','telemetry-a5-b','B','/unused');
INSERT INTO public.model_cost_sessions(cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd) VALUES
 ('20000000-0000-0000-0000-000000000051','10000000-0000-0000-0000-000000000051',10,10,100,100),
 ('20000000-0000-0000-0000-000000000052','10000000-0000-0000-0000-000000000052',10,10,100,100),
 ('20000000-0000-0000-0000-000000000053','10000000-0000-0000-0000-000000000051',10,10,100,100);
INSERT INTO public.tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash)
 VALUES('60000000-0000-0000-0000-000000000051','10000000-0000-0000-0000-000000000051','fixture','{}','Ready',repeat('a',40));
INSERT INTO public.product_pipeline_sessions(pipeline_session_id,project_id,title,raw_idea_text,created_by_principal_id)
 VALUES('70000000-0000-0000-0000-000000000051','10000000-0000-0000-0000-000000000051','fixture','fixture','fixture');
CREATE FUNCTION pg_temp.ledger(id UUID, patch JSONB DEFAULT '{}') RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.model_call_ledgers SELECT (jsonb_populate_record(NULL::public.model_call_ledgers,jsonb_build_object(
 'call_id',id,'project_id','10000000-0000-0000-0000-000000000051','cost_session_id','20000000-0000-0000-0000-000000000051',
 'stage','fixture','provider','anthropic','model','fixture','prompt_id','fixture','prompt_version','1',
 'prompt_sha256',repeat('a',64),'request_sha256',repeat('b',64),'estimated_input_tokens',0,'reserved_output_tokens',0,
 'actual_input_tokens',0,'actual_output_tokens',0,'actual_total_tokens',0,'estimated_cost_micro_usd',0,'actual_cost_micro_usd',0,
 'status','ALLOWED','latency_ms',0,'created_at',clock_timestamp(),'usage_estimated',false,'error_message','PRIVATE_LEDGER_CANARY')||patch)).*;
$$;
CREATE TEMP TABLE cases(n INTEGER, patch JSONB);
INSERT INTO cases VALUES
 (1,'{}'),(2,'{"status":"BLOCKED_PREFLIGHT"}'),(3,'{"status":"BLOCKED_POSTCALL"}'),(4,'{"status":"FAILED_VALIDATION"}'),(5,'{"status":"FAILED_PROVIDER"}'),
 (6,'{"provider":"google"}'),(7,'{"model":"other"}'),(8,'{"prompt_id":"other"}'),(9,'{"prompt_version":"2"}'),
 (10,'{"task_id":"60000000-0000-0000-0000-000000000051"}'),(11,'{"pipeline_session_id":"70000000-0000-0000-0000-000000000051"}'),
 (12,'{"cost_session_id":"20000000-0000-0000-0000-000000000053"}'),
 (13,'{"project_id":"10000000-0000-0000-0000-000000000052","cost_session_id":"20000000-0000-0000-0000-000000000052"}'),(14,'{}');
SELECT pg_temp.ledger(('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,patch) FROM cases;
INSERT INTO telemetry.invocations(invocation_id,project_id,cost_session_id,binding_state,binding_reason,provider,model,prompt_id,prompt_version,prompt_hmac_ref,key_version,mapping_id,binding_digest)
 SELECT ('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-0000-0000-000000000051','20000000-0000-0000-0000-000000000051','CALL_ONLY','execution-authority-unavailable','anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED',repeat('b',64) FROM generate_series(1,15) n;
CREATE TEMP TABLE ledger_before AS SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY call_id)::text) digest FROM public.model_call_ledgers l;
CREATE ROLE sf_telemetry_a5_writer LOGIN NOINHERIT;
GRANT telemetry_ingestor TO sf_telemetry_a5_writer;
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000051','ingest' FROM pg_roles WHERE rolname='sf_telemetry_a5_writer';
SET SESSION AUTHORIZATION sf_telemetry_a5_writer;
SET ROLE telemetry_ingestor;
DO $$ DECLARE n INTEGER; r RECORD; first_id UUID; inv UUID; led UUID; BEGIN
 FOR n IN 1..14 LOOP
  inv:=('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  led:=('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  SELECT * INTO r FROM telemetry.link_ledger('10000000-0000-0000-0000-000000000051',inv,led);
  IF r.disposition<>(CASE WHEN n<=5 OR n=14 THEN 'recorded' ELSE 'mismatch' END) THEN RAISE EXCEPTION 'Wrong disposition for case %',n; END IF;
  first_id:=r.settlement_id;
  SELECT * INTO r FROM telemetry.link_ledger('10000000-0000-0000-0000-000000000051',inv,led);
  IF r.disposition<>(CASE WHEN n<=5 OR n=14 THEN 'duplicate' ELSE 'mismatch' END) OR r.settlement_id IS DISTINCT FROM first_id THEN RAISE EXCEPTION 'Retry changed result'; END IF;
 END LOOP;
 -- Neither replacing an invocation link nor assigning an already used ledger is allowed.
 SELECT * INTO r FROM telemetry.link_ledger('10000000-0000-0000-0000-000000000051','30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000014');
 IF r.disposition<>'conflict' OR r.settlement_id IS NOT NULL THEN RAISE EXCEPTION 'Invocation reassigned'; END IF;
 SELECT * INTO r FROM telemetry.link_ledger('10000000-0000-0000-0000-000000000051','30000000-0000-0000-0000-000000000015','40000000-0000-0000-0000-000000000001');
 IF r.disposition<>'conflict' THEN RAISE EXCEPTION 'Ledger reused'; END IF;
 SELECT * INTO r FROM telemetry.link_ledger('10000000-0000-0000-0000-000000000051','30000000-0000-0000-0000-000000000015',gen_random_uuid());
 IF r.disposition<>'mismatch' THEN RAISE EXCEPTION 'Missing ledger accepted'; END IF;
 PERFORM set_config('app.current_project_id','10000000-0000-0000-0000-000000000052',true);
 BEGIN PERFORM telemetry.link_ledger('10000000-0000-0000-0000-000000000052','30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000013'); RAISE EXCEPTION 'Foreign project accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM call_id FROM public.model_call_ledgers; RAISE EXCEPTION 'Service ledger read allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO telemetry.settlements DEFAULT VALUES; RAISE EXCEPTION 'Direct settlement allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
-- Restrictive policy blocks the legacy PUBLIC/GUC policy even for function owner.
SET SESSION AUTHORIZATION telemetry_owner;
DO $$ BEGIN
 PERFORM set_config('app.current_project_id','10000000-0000-0000-0000-000000000051',true);
 IF (SELECT count(call_id) FROM public.model_call_ledgers)<>0 THEN RAISE EXCEPTION 'Legacy GUC bypassed owner guard'; END IF;
 BEGIN PERFORM prompt_sha256 FROM public.model_call_ledgers; RAISE EXCEPTION 'Owner read protected hash'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM error_message FROM public.model_call_ledgers; RAISE EXCEPTION 'Owner read raw error'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION app_runtime;
DO $$ BEGIN
 PERFORM set_config('app.current_project_id','10000000-0000-0000-0000-000000000051',true);
 IF (SELECT count(*) FROM public.model_call_ledgers)<>13 THEN RAISE EXCEPTION 'Legacy scope changed'; END IF;
 BEGIN PERFORM telemetry.link_ledger('10000000-0000-0000-0000-000000000051','30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'Worker linked'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
DO $$ BEGIN
 IF (SELECT count(*) FROM telemetry.settlements WHERE project_id='10000000-0000-0000-0000-000000000051')<>6 THEN RAISE EXCEPTION 'Wrong link count'; END IF;
 IF (SELECT count(*) FROM telemetry.quality_events WHERE project_id='10000000-0000-0000-0000-000000000051')<>11 THEN RAISE EXCEPTION 'Wrong marker count'; END IF;
 IF (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY call_id)::text) FROM public.model_call_ledgers l)<>(SELECT digest FROM ledger_before) THEN RAISE EXCEPTION 'Ledger changed'; END IF;
 IF has_function_privilege('telemetry_reporter','telemetry.link_ledger(uuid,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Reporter can link'; END IF;
END $$;
SELECT pg_temp.expect_error('UPDATE telemetry.settlements SET project_id=project_id','42501');
SELECT pg_temp.expect_error('DELETE FROM telemetry.settlements','42501');
SELECT pg_temp.expect_error('TRUNCATE telemetry.settlements','42501');
DELETE FROM telemetry.service_projects WHERE principal_name='sf_telemetry_a5_writer';
SET SESSION AUTHORIZATION sf_telemetry_a5_writer;
SET ROLE telemetry_ingestor;
DO $$ BEGIN
 BEGIN PERFORM telemetry.link_ledger('10000000-0000-0000-0000-000000000051','30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'Revoked service linked'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
