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
 ('10000000-0000-0000-0000-000000000061','telemetry-a6-a','A','/unused'),
 ('10000000-0000-0000-0000-000000000062','telemetry-a6-b','B','/unused');
INSERT INTO public.model_cost_sessions(cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd) VALUES
 ('20000000-0000-0000-0000-000000000061','10000000-0000-0000-0000-000000000061',10,10,100,100),
 ('20000000-0000-0000-0000-000000000062','10000000-0000-0000-0000-000000000062',10,10,100,100);
INSERT INTO telemetry.invocations(invocation_id,project_id,cost_session_id,binding_state,binding_reason,provider,model,prompt_id,prompt_version,prompt_hmac_ref,key_version,mapping_id,binding_digest)
 SELECT ('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'CALL_ONLY','execution-authority-unavailable','google','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED',repeat('b',64) FROM generate_series(61,62) n;
CREATE ROLE sf_telemetry_a6_writer LOGIN NOINHERIT;
CREATE ROLE sf_telemetry_a6_reader LOGIN NOINHERIT;
GRANT telemetry_ingestor TO sf_telemetry_a6_writer;
GRANT telemetry_reporter TO sf_telemetry_a6_reader;
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000061','ingest' FROM pg_roles WHERE rolname='sf_telemetry_a6_writer';
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000061','read' FROM pg_roles WHERE rolname='sf_telemetry_a6_reader';
SET SESSION AUTHORIZATION sf_telemetry_a6_writer;
SET ROLE telemetry_ingestor;
SELECT * FROM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061','USAGE',1,'{"totalTokenCount":"9007199254740993"}');
SELECT * FROM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061','PARTIAL',1,'{}');
SELECT * FROM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061','USAGE',2,'{}');
DO $$ BEGIN
 BEGIN PERFORM telemetry.read_observations('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061'); RAISE EXCEPTION 'Writer read permitted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
INSERT INTO public.model_call_ledgers(call_id,project_id,cost_session_id,stage,provider,model,prompt_id,prompt_version,prompt_sha256,request_sha256,estimated_input_tokens,reserved_output_tokens,estimated_cost_micro_usd,status)
 VALUES('40000000-0000-0000-0000-000000000061','10000000-0000-0000-0000-000000000061','20000000-0000-0000-0000-000000000061','fixture','google','fixture','fixture','1',repeat('a',64),repeat('b',64),0,0,0,'ALLOWED');
SET SESSION AUTHORIZATION sf_telemetry_a6_writer;
SET ROLE telemetry_ingestor;
SELECT * FROM telemetry.link_ledger('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061','40000000-0000-0000-0000-000000000061');
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION sf_telemetry_a6_reader;
SET ROLE telemetry_reporter;
DO $$ DECLARE r RECORD; page_count INTEGER; BEGIN
 SELECT * INTO r FROM telemetry.read_observations('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061',NULL,NULL,1);
 IF r.kind<>'PARTIAL' OR r.reported_total IS NOT NULL THEN RAISE EXCEPTION 'Missing usage became zero or incorrect first page'; END IF;
 SELECT * INTO r FROM telemetry.read_observations('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061',r.revision,r.kind,1);
 IF r.kind<>'USAGE' OR r.reported_total<>'9007199254740993' OR r.canonical_status<>'unavailable' THEN RAISE EXCEPTION 'Unsafe numeric/canonical export'; END IF;
 SELECT count(*) INTO page_count FROM telemetry.read_observations('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061',r.revision,r.kind,100);
 IF page_count<>1 THEN RAISE EXCEPTION 'Keyset omitted or duplicated rows'; END IF;
 IF EXISTS(SELECT 1 FROM telemetry.read_observations('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000062')) THEN RAISE EXCEPTION 'Foreign invocation leaked'; END IF;
 IF (SELECT has_quality_flags FROM telemetry.read_settlement('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061')) THEN RAISE EXCEPTION 'Unexpected quality flag'; END IF;
 PERFORM set_config('app.current_project_id','10000000-0000-0000-0000-000000000062',true);
 BEGIN PERFORM telemetry.read_observations('10000000-0000-0000-0000-000000000062','30000000-0000-0000-0000-000000000062'); RAISE EXCEPTION 'Foreign scope allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM telemetry.read_settlement('10000000-0000-0000-0000-000000000062','30000000-0000-0000-0000-000000000062'); RAISE EXCEPTION 'Foreign settlement allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM telemetry.read_observations('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061',1,NULL,10); RAISE EXCEPTION 'Partial cursor accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM telemetry.read_observations('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061',NULL,NULL,101); RAISE EXCEPTION 'Unbounded page'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM 1 FROM telemetry.observations; RAISE EXCEPTION 'Direct read allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO telemetry.reports DEFAULT VALUES; RAISE EXCEPTION 'Reporter published arbitrary aggregate'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
-- A later committed conflict is visible as a flag, never as baseline eligibility.
SET SESSION AUTHORIZATION sf_telemetry_a6_writer;
SET ROLE telemetry_ingestor;
SELECT * FROM telemetry.append_unverified_usage('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061','USAGE',1,'{"totalTokenCount":"1"}');
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION sf_telemetry_a6_reader;
SET ROLE telemetry_reporter;
DO $$ BEGIN
 IF NOT (SELECT has_quality_flags FROM telemetry.read_settlement('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061')) THEN RAISE EXCEPTION 'Conflict flag hidden'; END IF;
 BEGIN PERFORM call_id FROM public.model_call_ledgers; RAISE EXCEPTION 'Reporter ledger access'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
-- Reports remain structural storage only: privileged fixture, no publisher API.
INSERT INTO public.tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash)
 VALUES('50000000-0000-0000-0000-000000000061','10000000-0000-0000-0000-000000000061','fixture','{}','Ready',repeat('a',40));
INSERT INTO telemetry.cohort_manifests VALUES('60000000-0000-0000-0000-000000000061','10000000-0000-0000-0000-000000000061',repeat('a',64),'1','S',1,1,false,false,false,false,false,'fixture',clock_timestamp(),repeat('a',40),'1');
INSERT INTO telemetry.lifecycles(lifecycle_id,project_id,task_id,manifest_id)
 VALUES('70000000-0000-0000-0000-000000000061','10000000-0000-0000-0000-000000000061','50000000-0000-0000-0000-000000000061','60000000-0000-0000-0000-000000000061');
INSERT INTO telemetry.lifecycle_events(event_id,project_id,lifecycle_id,sequence,kind,service_actor_ref,event_digest)
 VALUES(gen_random_uuid(),'10000000-0000-0000-0000-000000000061','70000000-0000-0000-0000-000000000061',1,'OPEN','fixture',repeat('a',64));
INSERT INTO telemetry.reports(report_id,project_id,cutoff_at,manifest_version,mapping_versions,report_digest,aggregate_json)
 VALUES('80000000-0000-0000-0000-000000000061','10000000-0000-0000-0000-000000000061',clock_timestamp(),'1',ARRAY['UNVERIFIED'],repeat('a',64),'{"total_roots":"1","complete_roots":"0","incomplete_roots":"1","censored_roots":"0","canonical_total":null}');
INSERT INTO telemetry.report_members VALUES('10000000-0000-0000-0000-000000000061','80000000-0000-0000-0000-000000000061','70000000-0000-0000-0000-000000000061',1,repeat('a',64),NULL,'observer-coverage-unproven');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.report_members VALUES('10000000-0000-0000-0000-000000000062','80000000-0000-0000-0000-000000000061','70000000-0000-0000-0000-000000000061',1,repeat('a',64),NULL,'censored')$q$,'23503');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.report_members SELECT * FROM telemetry.report_members$q$,'23505');
INSERT INTO telemetry.reports SELECT '80000000-0000-0000-0000-000000000063',project_id,cutoff_at,manifest_version,mapping_versions,report_digest,aggregate_json,report_id,finalized_at FROM telemetry.reports;
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.report_members VALUES('10000000-0000-0000-0000-000000000061','80000000-0000-0000-0000-000000000063','70000000-0000-0000-0000-000000000061',2,repeat('a',64),NULL,'censored')$q$,'23503');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.report_members VALUES('10000000-0000-0000-0000-000000000061','80000000-0000-0000-0000-000000000063','70000000-0000-0000-0000-000000000061',1,repeat('b',64),NULL,'censored')$q$,'23503');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.reports SELECT gen_random_uuid(),project_id,cutoff_at,manifest_version,mapping_versions,report_digest,aggregate_json||'{"censored_roots":"2"}',NULL,finalized_at FROM telemetry.reports$q$,'23514');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.reports SELECT gen_random_uuid(),project_id,cutoff_at,manifest_version,mapping_versions,report_digest,aggregate_json||'{"canonical_total":"0"}',NULL,finalized_at FROM telemetry.reports$q$,'23514');

SELECT pg_temp.expect_error($q$INSERT INTO telemetry.reports SELECT gen_random_uuid(),'10000000-0000-0000-0000-000000000062',cutoff_at,manifest_version,mapping_versions,report_digest,aggregate_json,report_id,finalized_at FROM telemetry.reports$q$,'23503');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.reports SELECT gen_random_uuid(),project_id,cutoff_at,manifest_version,mapping_versions,report_digest,aggregate_json||'{"complete_roots":"1"}',NULL,finalized_at FROM telemetry.reports$q$,'23514');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.reports SELECT gen_random_uuid(),project_id,cutoff_at,manifest_version,mapping_versions,report_digest,aggregate_json||'{"raw_prompt":"REPORT_CANARY"}',NULL,finalized_at FROM telemetry.reports$q$,'23514');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.reports SELECT gen_random_uuid(),project_id,cutoff_at,manifest_version,ARRAY['UNVERIFIED','UNVERIFIED'],report_digest,aggregate_json,NULL,finalized_at FROM telemetry.reports$q$,'23514');
DO $$ DECLARE t TEXT; r TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['reports','report_members'] LOOP
  PERFORM pg_temp.expect_error(format('UPDATE telemetry.%I SET project_id=project_id',t),'42501');
  PERFORM pg_temp.expect_error(format('DELETE FROM telemetry.%I',t),'42501');
  PERFORM pg_temp.expect_error(format('TRUNCATE telemetry.%I CASCADE',t),'42501');
  FOREACH r IN ARRAY ARRAY['app_runtime','telemetry_ingestor','telemetry_reporter','telemetry_operator'] LOOP
   IF has_table_privilege(r,'telemetry.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'Report privilege opened'; END IF;
  END LOOP;
 END LOOP;
END $$;
SET SESSION AUTHORIZATION telemetry_owner;
DO $$ BEGIN
 IF (SELECT count(*) FROM telemetry.reports)<>0 OR (SELECT count(*) FROM telemetry.report_members)<>0 THEN RAISE EXCEPTION 'Report owner bypassed FORCE RLS'; END IF;
END $$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION app_runtime;
DO $$ BEGIN
 BEGIN PERFORM telemetry.read_observations('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061'); RAISE EXCEPTION 'Worker read allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
-- Bounded multi-project index probe for a deep keyset page.
INSERT INTO telemetry.observations(project_id,invocation_id,revision,kind,canonical_status,reasoning_inclusion,missing_reason,numeric_usage,mapping_revision,provenance,content_digest)
 SELECT CASE WHEN n%2=0 THEN '10000000-0000-0000-0000-000000000061'::uuid ELSE '10000000-0000-0000-0000-000000000062'::uuid END,
 CASE WHEN n%2=0 THEN '30000000-0000-0000-0000-000000000061'::uuid ELSE '30000000-0000-0000-0000-000000000062'::uuid END,
 n,'USAGE','unavailable','unverified','mapping-unverified','{}','candidate-google-v1-unverified','provider-reported-unverified',repeat('c',64)
 FROM generate_series(10,4009) n;
ANALYZE telemetry.observations;
DO $$ DECLARE plan JSON; BEGIN
 EXECUTE $q$EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT revision,kind FROM telemetry.observations
 WHERE project_id='10000000-0000-0000-0000-000000000061' AND invocation_id='30000000-0000-0000-0000-000000000061'
 AND (revision,kind)>(3900,'USAGE') ORDER BY revision,kind LIMIT 25$q$ INTO plan;
 IF position('Index Cond' in plan::text)=0 OR position('Seq Scan' in plan::text)>0 OR position('ROW(revision, kind)' in plan::text)=0
 OR (plan->0->'Plan'->>'Actual Rows')::integer<>25 THEN RAISE EXCEPTION 'Unbounded deep page: %',plan; END IF;
 RAISE NOTICE 'A6 deep page plan: %',plan;
END $$;
SET SESSION AUTHORIZATION sf_telemetry_a6_reader;
SET ROLE telemetry_reporter;
DO $$ BEGIN
 IF (SELECT count(*) FROM telemetry.read_observations('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061',3900,'USAGE',25))<>25 THEN RAISE EXCEPTION 'Reader deep page failed'; END IF;
END $$;
RESET SESSION AUTHORIZATION;
DELETE FROM telemetry.service_projects WHERE principal_name='sf_telemetry_a6_reader';
SET SESSION AUTHORIZATION sf_telemetry_a6_reader;
SET ROLE telemetry_reporter;
DO $$ BEGIN
 BEGIN PERFORM telemetry.read_settlement('10000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000061'); RAISE EXCEPTION 'Revoked reader accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
