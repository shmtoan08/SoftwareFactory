\set ON_ERROR_STOP on
BEGIN;
-- Admin-only fixture helpers; never installed in a runtime schema.
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
 ('10000000-0000-0000-0000-000000000031','telemetry-a3-a','A','/unused'),
 ('10000000-0000-0000-0000-000000000032','telemetry-a3-b','B','/unused');
CREATE FUNCTION pg_temp.manifest(size TEXT, files INTEGER, packages INTEGER, project UUID DEFAULT '10000000-0000-0000-0000-000000000031') RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE id UUID:=gen_random_uuid();
BEGIN
 INSERT INTO telemetry.cohort_manifests VALUES(id,project,repeat('a',64),'1',size,files,packages,false,true,false,false,false,'fixture-operator',clock_timestamp(),repeat('b',40),'1');
 RETURN id;
END $$;
-- Exact size boundaries; risk remains independent, including S + auth_rls.
SELECT pg_temp.manifest('S',5,1),pg_temp.manifest('S',0,0),pg_temp.manifest('M',6,1),pg_temp.manifest('M',5,2),pg_temp.manifest('M',20,3),pg_temp.manifest('L',21,3),pg_temp.manifest('L',20,4),pg_temp.manifest('unclassified',NULL,1),pg_temp.manifest('unclassified',5,NULL);
SELECT pg_temp.expect_error($q$SELECT pg_temp.manifest('S',6,1)$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT pg_temp.manifest('M',5,1)$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT pg_temp.manifest('L',20,3)$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT pg_temp.manifest('S',NULL,1)$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT pg_temp.manifest('S',-1,1)$q$,'23514');
INSERT INTO public.tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash) VALUES
 ('20000000-0000-0000-0000-000000000031','10000000-0000-0000-0000-000000000031','fixture','{}','Ready',repeat('a',40)),
 ('20000000-0000-0000-0000-000000000032','10000000-0000-0000-0000-000000000032','fixture','{}','Ready',repeat('a',40));
INSERT INTO telemetry.lifecycles(lifecycle_id,project_id,task_id,manifest_id) VALUES
 ('30000000-0000-0000-0000-000000000031','10000000-0000-0000-0000-000000000031','20000000-0000-0000-0000-000000000031',pg_temp.manifest('S',1,1));
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.lifecycles VALUES(gen_random_uuid(),'10000000-0000-0000-0000-000000000031','20000000-0000-0000-0000-000000000032',pg_temp.manifest('S',1,1),clock_timestamp())$q$,'23503');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.lifecycles VALUES(gen_random_uuid(),'10000000-0000-0000-0000-000000000032','20000000-0000-0000-0000-000000000032',pg_temp.manifest('S',1,1),clock_timestamp())$q$,'23503');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.lifecycles VALUES(gen_random_uuid(),'10000000-0000-0000-0000-000000000031','20000000-0000-0000-0000-000000000031',pg_temp.manifest('S',1,1),clock_timestamp())$q$,'23505');
CREATE FUNCTION pg_temp.event(seq BIGINT, event_kind TEXT, prev BIGINT, prev_digest TEXT, digest TEXT, disposition TEXT DEFAULT NULL, cutoff TIMESTAMPTZ DEFAULT NULL, project UUID DEFAULT '10000000-0000-0000-0000-000000000031') RETURNS void LANGUAGE sql AS $$
 INSERT INTO telemetry.lifecycle_events(event_id,project_id,lifecycle_id,sequence,kind,outcome,service_actor_ref,cutoff_at,prior_sequence,prior_event_digest,event_digest)
 VALUES(gen_random_uuid(),project,'30000000-0000-0000-0000-000000000031',seq,event_kind,disposition,'fixture-operator',cutoff,prev,prev_digest,digest);
$$;
SELECT pg_temp.expect_error($q$SELECT pg_temp.event(1,'AMEND',NULL,NULL,repeat('a',64))$q$,'23514');
SELECT pg_temp.event(1,'OPEN',NULL,NULL,repeat('a',64));
SELECT pg_temp.expect_error($q$SELECT pg_temp.event(2,'OPEN',1,repeat('a',64),repeat('b',64))$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT pg_temp.event(3,'AMEND',2,repeat('a',64),repeat('b',64))$q$,'23503');
SELECT pg_temp.expect_error($q$SELECT pg_temp.event(2,'AMEND',NULL,NULL,repeat('b',64))$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT pg_temp.event(2,'AMEND',1,repeat('f',64),repeat('b',64))$q$,'23503');
SELECT pg_temp.expect_error($q$SELECT pg_temp.event(2,'AMEND',1,repeat('a',64),repeat('b',64),NULL,NULL,'10000000-0000-0000-0000-000000000032')$q$,'23503');
SELECT pg_temp.expect_error($q$SELECT pg_temp.event(2,'CLOSE',1,repeat('a',64),repeat('b',64))$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT pg_temp.event(2,'CENSOR',1,repeat('a',64),repeat('b',64),'success',clock_timestamp())$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT pg_temp.event(2,'CENSOR',1,repeat('a',64),repeat('b',64))$q$,'23514');
SELECT pg_temp.event(2,'CENSOR',1,repeat('a',64),repeat('b',64),NULL,clock_timestamp());
SELECT pg_temp.event(3,'AMEND',2,repeat('b',64),repeat('c',64));
-- Admin fixtures prove storage shape only, not settlement/closure authority.
SELECT pg_temp.event(4,'CLOSE',3,repeat('c',64),repeat('d',64),'cancelled');
SELECT pg_temp.event(5,'REOPEN',4,repeat('d',64),repeat('e',64));
SELECT pg_temp.expect_error($q$SELECT pg_temp.event(5,'REOPEN',4,repeat('d',64),repeat('e',64))$q$,'23505');
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['cohort_manifests','lifecycles','lifecycle_events'] LOOP
  PERFORM pg_temp.expect_error(format('UPDATE telemetry.%I SET project_id=project_id',t),'42501');
  PERFORM pg_temp.expect_error(format('DELETE FROM telemetry.%I',t),'42501');
  PERFORM pg_temp.expect_error(format('TRUNCATE telemetry.%I CASCADE',t),'42501');
 END LOOP;
END $$;
-- Even a provisioned service remains unable to enroll or close lifecycles.
CREATE ROLE sf_telemetry_a3_writer LOGIN NOINHERIT;
GRANT telemetry_ingestor TO sf_telemetry_a3_writer;
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000031','ingest' FROM pg_roles WHERE rolname='sf_telemetry_a3_writer';
SET SESSION AUTHORIZATION sf_telemetry_a3_writer;
SET ROLE telemetry_ingestor;
DO $$ DECLARE t TEXT; BEGIN
 PERFORM set_config('app.current_project_id','10000000-0000-0000-0000-000000000031',true);
 FOREACH t IN ARRAY ARRAY['cohort_manifests','lifecycles','lifecycle_events'] LOOP
  BEGIN EXECUTE format('SELECT 1 FROM telemetry.%I',t); RAISE EXCEPTION 'Service read allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN EXECUTE format('INSERT INTO telemetry.%I DEFAULT VALUES',t); RAISE EXCEPTION 'Service enrollment allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 -- A2 review: values rejected uniformly before insertion/FK evaluation.
 BEGIN PERFORM telemetry.register_call(gen_random_uuid(),'10000000-0000-0000-0000-000000000031',gen_random_uuid(),NULL,NULL,'unknown','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED'); RAISE EXCEPTION 'Invalid provider accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM telemetry.register_call(gen_random_uuid(),'10000000-0000-0000-0000-000000000031',gen_random_uuid(),NULL,NULL,'anthropic','fixture','fixture','1',repeat('z',64),'1','UNVERIFIED'); RAISE EXCEPTION 'Invalid HMAC accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION telemetry_owner;
DO $$ DECLARE t TEXT; n BIGINT; BEGIN
 FOREACH t IN ARRAY ARRAY['cohort_manifests','lifecycles','lifecycle_events'] LOOP
  EXECUTE format('SELECT count(*) FROM telemetry.%I',t) INTO n;
  IF n<>0 THEN RAISE EXCEPTION 'Owner bypassed FORCE RLS'; END IF;
  BEGIN EXECUTE format('INSERT INTO telemetry.%I DEFAULT VALUES',t); RAISE EXCEPTION 'Owner insert allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
END $$;
RESET SESSION AUTHORIZATION;
DO $$ DECLARE t TEXT; r TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['cohort_manifests','lifecycles','lifecycle_events'] LOOP
  FOREACH r IN ARRAY ARRAY['app_runtime','telemetry_ingestor','telemetry_reporter','telemetry_operator'] LOOP
   IF has_table_privilege(r,'telemetry.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'Unexpected privilege'; END IF;
  END LOOP;
 END LOOP;
END $$;
-- Multi-project, bounded index probe; synthetic storage evidence, not live workload latency.
CREATE TEMP TABLE scale_roots AS
 SELECT gen_random_uuid() AS task_id, gen_random_uuid() AS manifest_id, gen_random_uuid() AS lifecycle_id,
 CASE WHEN n%2=0 THEN '10000000-0000-0000-0000-000000000031'::uuid ELSE '10000000-0000-0000-0000-000000000032'::uuid END AS project_id
 FROM generate_series(1,4000) n;
INSERT INTO telemetry.cohort_manifests
 SELECT manifest_id,project_id,repeat('a',64),'1','S',1,1,false,false,false,false,false,'fixture-operator',clock_timestamp(),repeat('a',40),'1' FROM scale_roots;
INSERT INTO public.tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash)
 SELECT task_id,project_id,'scale fixture','{}','Ready',repeat('a',40) FROM scale_roots;
INSERT INTO telemetry.lifecycles(lifecycle_id,project_id,task_id,manifest_id)
 SELECT lifecycle_id,project_id,task_id,manifest_id FROM scale_roots;
INSERT INTO telemetry.lifecycle_events(event_id,project_id,lifecycle_id,sequence,kind,service_actor_ref,event_digest)
 SELECT gen_random_uuid(),project_id,lifecycle_id,1,'OPEN','fixture-operator',repeat('a',64) FROM scale_roots;
ANALYZE telemetry.lifecycle_events;
DO $$ DECLARE plan JSON; BEGIN
 EXECUTE $q$EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
 SELECT sequence,kind FROM telemetry.lifecycle_events
 WHERE project_id='10000000-0000-0000-0000-000000000031'
 AND lifecycle_id='30000000-0000-0000-0000-000000000031' AND sequence>1
 ORDER BY sequence LIMIT 100$q$ INTO plan;
 IF position('Index Cond' in plan::text)=0 OR position('Seq Scan' in plan::text)>0
 OR (plan->0->'Plan'->>'Actual Rows')::integer<>4 THEN RAISE EXCEPTION 'Unbounded or incorrect event lookup: %',plan; END IF;
 RAISE NOTICE 'A3 bounded event index plan: %',plan;
END $$;
SET SESSION AUTHORIZATION app_runtime;
DO $$ BEGIN
 PERFORM set_config('app.current_project_id','10000000-0000-0000-0000-000000000031',true);
 PERFORM set_config('app.current_role','core_api_service',true);
 BEGIN PERFORM 1 FROM telemetry.lifecycle_events; RAISE EXCEPTION 'Worker read allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO telemetry.lifecycles DEFAULT VALUES; RAISE EXCEPTION 'Worker enrollment allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN EXECUTE 'SET ROLE telemetry_owner'; RAISE EXCEPTION 'Worker escalation allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
