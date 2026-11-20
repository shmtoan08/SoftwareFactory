\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.expect_error(command TEXT, expected TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual TEXT;
BEGIN
 BEGIN EXECUTE command;
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE;
  IF actual=expected THEN RETURN; END IF; RAISE;
 END;
 RAISE EXCEPTION 'Expected SQLSTATE %, command succeeded',expected;
END $$;
INSERT INTO public.projects(project_id,slug,name,repo_bare_path) VALUES
 ('10000000-0000-0000-0000-000000000241','telemetry-c2-a','A','/unused'),
 ('10000000-0000-0000-0000-000000000242','telemetry-c2-b','B','/unused');
INSERT INTO public.tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash) VALUES
 ('20000000-0000-0000-0000-000000000241','10000000-0000-0000-0000-000000000241','ready','{}','Ready',repeat('a',40)),
 ('20000000-0000-0000-0000-000000000242','10000000-0000-0000-0000-000000000241','started','{}','Leased',repeat('a',40)),
 ('20000000-0000-0000-0000-000000000243','10000000-0000-0000-0000-000000000242','foreign','{}','Ready',repeat('a',40));
CREATE ROLE sf_telemetry_c2_operator LOGIN NOINHERIT;
GRANT telemetry_operator TO sf_telemetry_c2_operator;
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000241','operator'
 FROM pg_roles WHERE rolname='sf_telemetry_c2_operator';

-- Direct tables remain unavailable; only typed operator functions open access.
SET SESSION AUTHORIZATION sf_telemetry_c2_operator;
SET ROLE telemetry_operator;
SELECT pg_temp.expect_error($q$SELECT 1 FROM telemetry.lifecycles$q$,'42501');
SELECT pg_temp.expect_error($q$INSERT INTO telemetry.lifecycle_events DEFAULT VALUES$q$,'42501');
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.open_lifecycle(
 '10000000-0000-0000-0000-000000000242','20000000-0000-0000-0000-000000000243',gen_random_uuid(),gen_random_uuid(),
 repeat('a',64),'1','S',1,1,false,false,false,false,false,repeat('b',40),'1')$q$,'42501');
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.open_lifecycle(
 '10000000-0000-0000-0000-000000000241','20000000-0000-0000-0000-000000000242',gen_random_uuid(),gen_random_uuid(),
 repeat('a',64),'1','S',1,1,false,false,false,false,false,repeat('b',40),'1')$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.open_lifecycle(
 '10000000-0000-0000-0000-000000000241','20000000-0000-0000-0000-000000000241',gen_random_uuid(),gen_random_uuid(),
 NULL,'1','S',1,1,false,false,false,false,false,repeat('b',40),'1')$q$,'22023');
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.open_lifecycle(
 '10000000-0000-0000-0000-000000000241','20000000-0000-0000-0000-000000000241',gen_random_uuid(),gen_random_uuid(),
 repeat('a',64),'1',NULL,1,1,false,false,false,false,false,repeat('b',40),'1')$q$,'22023');
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.open_lifecycle(
 '10000000-0000-0000-0000-000000000241','20000000-0000-0000-0000-000000000241',gen_random_uuid(),gen_random_uuid(),
 repeat('a',64),'1','S',1,1,false,false,false,false,false,NULL,'1')$q$,'22023');

SELECT * FROM telemetry.open_lifecycle(
 '10000000-0000-0000-0000-000000000241','20000000-0000-0000-0000-000000000241',
 '30000000-0000-0000-0000-000000000241','40000000-0000-0000-0000-000000000241',
 repeat('a',64),'key-1','S',1,1,false,true,false,false,false,repeat('b',40),'manifest-1');
-- Exact replay is idempotent; changed immutable input conflicts.
SELECT * FROM telemetry.open_lifecycle(
 '10000000-0000-0000-0000-000000000241','20000000-0000-0000-0000-000000000241',
 '30000000-0000-0000-0000-000000000241','40000000-0000-0000-0000-000000000241',
 repeat('a',64),'key-1','S',1,1,false,true,false,false,false,repeat('b',40),'manifest-1');
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.open_lifecycle(
 '10000000-0000-0000-0000-000000000241','20000000-0000-0000-0000-000000000241',
 '30000000-0000-0000-0000-000000000241','40000000-0000-0000-0000-000000000241',
 repeat('c',64),'key-1','S',1,1,false,true,false,false,false,repeat('b',40),'manifest-1')$q$,'23505');

SELECT * FROM telemetry.append_lifecycle_event('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241','50000000-0000-0000-0000-000000000241','AMEND',NULL);
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.append_lifecycle_event('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241','50000000-0000-0000-0000-000000000241','REOPEN',NULL)$q$,'23505');
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.append_lifecycle_event('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241',gen_random_uuid(),'CENSOR','2000-01-01T00:00:00Z')$q$,'22023');
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.append_lifecycle_event('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241',gen_random_uuid(),'CENSOR',clock_timestamp()+interval '1 hour')$q$,'22023');
SELECT * FROM telemetry.append_lifecycle_event('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241','50000000-0000-0000-0000-000000000241','AMEND',NULL);
SELECT * FROM telemetry.append_lifecycle_event('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241','50000000-0000-0000-0000-000000000242','CENSOR',clock_timestamp());
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.append_lifecycle_event('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241',gen_random_uuid(),'REOPEN',NULL)$q$,'23514');
-- Absence of observed calls cannot prove complete coverage, for any outcome.
SELECT pg_temp.expect_error($q$SELECT telemetry.close_lifecycle('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241','success')$q$,'23514');
SELECT pg_temp.expect_error($q$SELECT telemetry.close_lifecycle('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241',NULL)$q$,'22023');
DO $$ DECLARE outcome TEXT; BEGIN
 FOREACH outcome IN ARRAY ARRAY['failed','abandoned','cancelled'] LOOP
  BEGIN PERFORM telemetry.close_lifecycle('10000000-0000-0000-0000-000000000241',
   '40000000-0000-0000-0000-000000000241',outcome);
   RAISE EXCEPTION 'Close unexpectedly allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
 END LOOP;
END $$;

RESET SESSION AUTHORIZATION;
-- Administrative fixture represents an already accepted historical CLOSE; operator may only reopen it.
INSERT INTO telemetry.lifecycle_events(event_id,project_id,lifecycle_id,sequence,kind,outcome,service_actor_ref,
 observed_at,prior_sequence,prior_event_digest,event_digest)
SELECT '50000000-0000-0000-0000-000000000243',project_id,lifecycle_id,4,'CLOSE','cancelled','fixture-admin',
 clock_timestamp(),sequence,event_digest,repeat('d',64) FROM telemetry.lifecycle_events
WHERE project_id='10000000-0000-0000-0000-000000000241' AND lifecycle_id='40000000-0000-0000-0000-000000000241' AND sequence=3;
SET SESSION AUTHORIZATION sf_telemetry_c2_operator;
SET ROLE telemetry_operator;
SELECT * FROM telemetry.append_lifecycle_event('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241','50000000-0000-0000-0000-000000000244','REOPEN',NULL);
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.append_lifecycle_event('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241',gen_random_uuid(),'REOPEN',NULL)$q$,'23514');
RESET SESSION AUTHORIZATION;

DO $$ DECLARE n INTEGER; operator_events INTEGER; BEGIN
 SELECT count(*),count(*) FILTER(WHERE service_actor_ref='sf_telemetry_c2_operator') INTO n,operator_events FROM telemetry.lifecycle_events
  WHERE project_id='10000000-0000-0000-0000-000000000241' AND lifecycle_id='40000000-0000-0000-0000-000000000241';
 IF n<>5 OR operator_events<>4 THEN RAISE EXCEPTION 'Incorrect event chain/actor'; END IF;
 IF EXISTS(SELECT 1 FROM telemetry.lifecycle_events e LEFT JOIN telemetry.lifecycle_events p
  ON p.project_id=e.project_id AND p.lifecycle_id=e.lifecycle_id AND p.sequence=e.prior_sequence AND p.event_digest=e.prior_event_digest
  WHERE e.lifecycle_id='40000000-0000-0000-0000-000000000241' AND e.sequence>1 AND p.event_id IS NULL) THEN
  RAISE EXCEPTION 'Broken event chain';
 END IF;
 IF (SELECT count(*) FROM telemetry.cohort_manifests WHERE manifest_id='30000000-0000-0000-0000-000000000241')<>1 THEN
  RAISE EXCEPTION 'Manifest replay duplicated';
 END IF;
END $$;

-- Membership in app_runtime invalidates service authority even with registry binding.
GRANT app_runtime TO sf_telemetry_c2_operator;
SET SESSION AUTHORIZATION sf_telemetry_c2_operator;
SET ROLE telemetry_operator;
SELECT pg_temp.expect_error($q$SELECT telemetry.close_lifecycle('10000000-0000-0000-0000-000000000241',
 '40000000-0000-0000-0000-000000000241','cancelled')$q$,'42501');
RESET SESSION AUTHORIZATION;
REVOKE app_runtime FROM sf_telemetry_c2_operator;

-- Other runtime groups never receive lifecycle entry points.
DO $$ DECLARE r TEXT; f TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['app_runtime','telemetry_ingestor','telemetry_reporter'] LOOP
  FOREACH f IN ARRAY ARRAY[
   'telemetry.open_lifecycle(uuid,uuid,uuid,uuid,text,text,text,integer,integer,boolean,boolean,boolean,boolean,boolean,text,text)',
   'telemetry.append_lifecycle_event(uuid,uuid,uuid,text,timestamp with time zone)',
   'telemetry.close_lifecycle(uuid,uuid,text)'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected lifecycle privilege: % %',r,f; END IF;
  END LOOP;
 END LOOP;
 IF NOT has_function_privilege('telemetry_operator','telemetry.close_lifecycle(uuid,uuid,text)','EXECUTE') THEN
  RAISE EXCEPTION 'Missing operator close privilege';
 END IF;
END $$;
ROLLBACK;
