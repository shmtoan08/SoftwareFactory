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
 ('10000000-0000-0000-0000-000000000041','telemetry-a4-a','A','/unused'),
 ('10000000-0000-0000-0000-000000000042','telemetry-a4-b','B','/unused');
INSERT INTO public.model_cost_sessions(cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd) VALUES
 ('20000000-0000-0000-0000-000000000041','10000000-0000-0000-0000-000000000041',10,10,100,100),
 ('20000000-0000-0000-0000-000000000042','10000000-0000-0000-0000-000000000042',10,10,100,100);
INSERT INTO telemetry.invocations(invocation_id,project_id,cost_session_id,binding_state,binding_reason,provider,model,prompt_id,prompt_version,prompt_hmac_ref,key_version,mapping_id,binding_digest) VALUES
 ('30000000-0000-0000-0000-000000000041','10000000-0000-0000-0000-000000000041','20000000-0000-0000-0000-000000000041','CALL_ONLY','execution-authority-unavailable','anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED',repeat('b',64)),
 ('30000000-0000-0000-0000-000000000042','10000000-0000-0000-0000-000000000041','20000000-0000-0000-0000-000000000041','CALL_ONLY','execution-authority-unavailable','google','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED',repeat('b',64)),
 ('30000000-0000-0000-0000-000000000043','10000000-0000-0000-0000-000000000042','20000000-0000-0000-0000-000000000042','CALL_ONLY','execution-authority-unavailable','anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED',repeat('b',64));
CREATE ROLE sf_telemetry_a4_writer LOGIN NOINHERIT;
CREATE ROLE sf_telemetry_a4_reader LOGIN NOINHERIT;
GRANT telemetry_ingestor TO sf_telemetry_a4_writer;
GRANT telemetry_reporter TO sf_telemetry_a4_reader;
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000041','ingest' FROM pg_roles WHERE rolname='sf_telemetry_a4_writer';
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000041','read' FROM pg_roles WHERE rolname='sf_telemetry_a4_reader';
-- Identity/role checks run with real session authorization.
SET SESSION AUTHORIZATION sf_telemetry_a4_writer;
SET ROLE telemetry_ingestor;
DO $$ DECLARE first_id UUID; result RECORD; invalid JSONB; BEGIN
 SELECT * INTO result FROM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','USAGE',1,'{"input_tokens":"9007199254740993","output_tokens":"0"}');
 IF result.disposition<>'recorded' THEN RAISE EXCEPTION 'Initial receipt not recorded'; END IF;
 first_id:=result.observation_id;
 SELECT * INTO result FROM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','USAGE',1,'{"output_tokens":"0","input_tokens":"9007199254740993"}');
 IF result.disposition<>'duplicate' OR result.observation_id<>first_id THEN RAISE EXCEPTION 'Retry not idempotent'; END IF;
 SELECT * INTO result FROM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','USAGE',1,'{"input_tokens":"7"}');
 IF result.disposition<>'conflict' OR result.observation_id<>first_id THEN RAISE EXCEPTION 'Conflict not quarantined'; END IF;
 PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','USAGE',1,'{"input_tokens":"7"}');
 PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','PARTIAL',1,'{"input_tokens":"2"}');
 PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','FAILURE',1,'{}','provider-timeout');
 PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000042','USAGE',1,'{"totalTokenCount":"999999999999999999999999999999"}');
 FOREACH invalid IN ARRAY ARRAY['{"input_tokens":9007199254740993}'::jsonb,'{"input_tokens":"1.5"}','{"input_tokens":"-1"}','{"input_tokens":"01"}','{"input_tokens":"NaN"}','{"input_tokens":null}','{"input_tokens":"1000000000000000000000000000000"}','{"input_tokens":{}}','{"totalTokenCount":"1"}','{"raw_prompt":"PRIVATE_CANARY_A4"}','[]','null',NULL] LOOP
  BEGIN PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','USAGE',2,invalid); RAISE EXCEPTION 'Unsafe usage accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 END LOOP;
 BEGIN PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','USAGE',2,jsonb_build_object('input_tokens',repeat('1',8193))); RAISE EXCEPTION 'Oversized usage accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','FAILURE',2,'{}','PRIVATE_CANARY_A4'); RAISE EXCEPTION 'Raw error accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','FAILURE',2,'{}'); RAISE EXCEPTION 'Failure without category'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 PERFORM set_config('app.current_project_id','10000000-0000-0000-0000-000000000042',true);
 BEGIN PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000042','30000000-0000-0000-0000-000000000043','USAGE',1,'{}'); RAISE EXCEPTION 'Foreign project accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000043','USAGE',1,'{}'); RAISE EXCEPTION 'Foreign invocation accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM 1 FROM telemetry.observations; RAISE EXCEPTION 'Direct read allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO telemetry.quality_events DEFAULT VALUES; RAISE EXCEPTION 'Direct marker allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION sf_telemetry_a4_reader;
SET ROLE telemetry_reporter;
DO $$ BEGIN
 BEGIN PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','USAGE',2,'{}'); RAISE EXCEPTION 'Reader wrote'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION app_runtime;
DO $$ BEGIN
 BEGIN PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','USAGE',2,'{}'); RAISE EXCEPTION 'Worker wrote'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
DO $$ BEGIN
 IF (SELECT count(*) FROM telemetry.observations WHERE project_id='10000000-0000-0000-0000-000000000041')<>4 THEN RAISE EXCEPTION 'Wrong observation count'; END IF;
 IF (SELECT count(*) FROM telemetry.quality_events WHERE project_id='10000000-0000-0000-0000-000000000041')<>1 THEN RAISE EXCEPTION 'Conflict marker lost or duplicated'; END IF;
 IF NOT EXISTS(SELECT 1 FROM telemetry.observations WHERE invocation_id='30000000-0000-0000-0000-000000000041' AND kind='USAGE' AND numeric_usage->>'input_tokens'='9007199254740993') THEN RAISE EXCEPTION 'Exact counter changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM telemetry.observations WHERE reported_total=999999999999999999999999999999::numeric AND canonical_total IS NULL) THEN RAISE EXCEPTION 'Reported total rounded or made canonical'; END IF;
 IF EXISTS(SELECT 1 FROM telemetry.observations WHERE canonical_status<>'unavailable' OR canonical_total IS NOT NULL OR numeric_usage::text LIKE '%PRIVATE_CANARY_A4%') THEN RAISE EXCEPTION 'Unsafe canonical/privacy state'; END IF;
END $$;
-- Structural checks also hold for privileged fixture inserts.
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.observations SELECT (jsonb_populate_record(NULL::telemetry.observations,to_jsonb(o)||jsonb_build_object('observation_id',gen_random_uuid(),'project_id','10000000-0000-0000-0000-000000000042'))).* FROM telemetry.observations o LIMIT 1$q$,'23503');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.observations SELECT (jsonb_populate_record(NULL::telemetry.observations,to_jsonb(o)||jsonb_build_object('observation_id',gen_random_uuid(),'revision',9,'canonical_status','available','canonical_total',1))).* FROM telemetry.observations o LIMIT 1$q$,'23514');
-- Domain rejects fractions before rounding, including privileged writes.
SELECT pg_temp.expect_error('SELECT 1.5::telemetry.counter','23514');
SELECT pg_temp.expect_error('SELECT (-1)::telemetry.counter','23514');
SELECT pg_temp.expect_error('SELECT 1000000000000000000000000000000::telemetry.counter','23514');
SELECT pg_temp.expect_error($q$SELECT 'NaN'::telemetry.counter$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT 'Infinity'::telemetry.counter$q$,'23514');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.quality_events(project_id,invocation_id,category) VALUES('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000043','usage-missing')$q$,'23503');
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['observations','quality_events'] LOOP
  PERFORM pg_temp.expect_error(format('UPDATE telemetry.%I SET project_id=project_id',t),'42501');
  PERFORM pg_temp.expect_error(format('DELETE FROM telemetry.%I',t),'42501');
  PERFORM pg_temp.expect_error(format('TRUNCATE telemetry.%I',t),'42501');
 END LOOP;
END $$;
DELETE FROM telemetry.service_projects WHERE principal_name='sf_telemetry_a4_writer';
SET SESSION AUTHORIZATION sf_telemetry_a4_writer;
SET ROLE telemetry_ingestor;
DO $$ BEGIN
 BEGIN PERFORM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000041','30000000-0000-0000-0000-000000000041','USAGE',2,'{}'); RAISE EXCEPTION 'Revoked writer accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
