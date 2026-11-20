\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.expect_error(command TEXT, expected TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual TEXT; BEGIN BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE;
 IF actual=expected THEN RETURN; END IF; RAISE; END; RAISE EXCEPTION 'Expected SQLSTATE %',expected; END $$;
INSERT INTO public.projects(project_id,slug,name,repo_bare_path) VALUES
 ('10000000-0000-0000-0000-000000000261','telemetry-c3-a','A','/unused'),
 ('10000000-0000-0000-0000-000000000262','telemetry-c3-b','B','/unused');
INSERT INTO public.tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash)
 SELECT ('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-0000-0000-000000000261','fixture','{}','Ready',repeat('a',40)
 FROM generate_series(261,264) n;
INSERT INTO telemetry.cohort_manifests(manifest_id,project_id,contract_ref_hmac,key_version,task_size,planned_file_count,planned_package_count,
 schema_migration,auth_rls,security_isolation,recovery_lease,public_contract,operator_principal,approved_at,source_sha,manifest_version) VALUES
 ('30000000-0000-0000-0000-000000000261','10000000-0000-0000-0000-000000000261',repeat('a',64),'1','S',1,1,false,false,false,false,false,'fixture','2026-01-01Z',repeat('b',40),'v1'),
 ('30000000-0000-0000-0000-000000000262','10000000-0000-0000-0000-000000000261',repeat('a',64),'1','S',1,1,false,false,false,false,false,'fixture','2026-01-01Z',repeat('b',40),'v1'),
 ('30000000-0000-0000-0000-000000000263','10000000-0000-0000-0000-000000000261',repeat('a',64),'1','unclassified',NULL,NULL,false,false,false,false,false,'fixture','2026-01-01Z',repeat('b',40),'v1'),
 ('30000000-0000-0000-0000-000000000264','10000000-0000-0000-0000-000000000261',repeat('a',64),'1','S',1,1,false,false,false,false,false,'fixture','2026-01-01Z',repeat('b',40),'v2');
INSERT INTO telemetry.lifecycles(lifecycle_id,project_id,task_id,manifest_id,created_at)
 SELECT ('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-0000-0000-000000000261',
  ('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'2026-01-02Z'
 FROM generate_series(261,264) n;
INSERT INTO telemetry.lifecycle_events(event_id,project_id,lifecycle_id,sequence,kind,service_actor_ref,observed_at,event_digest)
 SELECT gen_random_uuid(),'10000000-0000-0000-0000-000000000261',('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,1,'OPEN','fixture','2026-01-02Z',repeat('a',64)
 FROM generate_series(261,264) n;
INSERT INTO telemetry.lifecycle_events(event_id,project_id,lifecycle_id,sequence,kind,service_actor_ref,observed_at,cutoff_at,prior_sequence,prior_event_digest,event_digest)
 VALUES(gen_random_uuid(),'10000000-0000-0000-0000-000000000261','40000000-0000-0000-0000-000000000262',2,'CENSOR','fixture','2026-01-20Z','2026-01-15Z',1,repeat('a',64),repeat('b',64));
CREATE ROLE sf_telemetry_c3_reporter LOGIN NOINHERIT;
GRANT telemetry_reporter TO sf_telemetry_c3_reporter;
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000261','read' FROM pg_roles WHERE rolname='sf_telemetry_c3_reporter';
SET SESSION AUTHORIZATION sf_telemetry_c3_reporter;
SET ROLE telemetry_reporter;
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.reports$q$,'42501');
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.publish_incomplete_report('10000000-0000-0000-0000-000000000262',gen_random_uuid(),
 '2026-02-01Z','v1',ARRAY['UNVERIFIED'],NULL)$q$,'42501');
SELECT * FROM telemetry.publish_incomplete_report('10000000-0000-0000-0000-000000000261','50000000-0000-0000-0000-000000000261',
 '2026-02-01Z','v1',ARRAY['UNVERIFIED'],NULL);
SELECT * FROM telemetry.publish_incomplete_report('10000000-0000-0000-0000-000000000261','50000000-0000-0000-0000-000000000261',
 '2026-02-01Z','v1',ARRAY['UNVERIFIED'],NULL);
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.publish_incomplete_report('10000000-0000-0000-0000-000000000261','50000000-0000-0000-0000-000000000261',
 '2026-02-02Z','v1',ARRAY['UNVERIFIED'],NULL)$q$,'23505');
SELECT * FROM telemetry.publish_incomplete_report('10000000-0000-0000-0000-000000000261','50000000-0000-0000-0000-000000000262',
 '2026-03-01Z','v1',ARRAY['UNVERIFIED'],'50000000-0000-0000-0000-000000000261');
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.publish_incomplete_report('10000000-0000-0000-0000-000000000261',gen_random_uuid(),
 '2026-01-15Z','v1',ARRAY['UNVERIFIED'],'50000000-0000-0000-0000-000000000262')$q$,'23514');
RESET SESSION AUTHORIZATION;
DO $$ BEGIN
 IF (SELECT aggregate_json FROM telemetry.reports WHERE report_id='50000000-0000-0000-0000-000000000261')<>
  '{"total_roots":"3","complete_roots":"0","incomplete_roots":"3","censored_roots":"1","canonical_total":null}'::jsonb THEN
  RAISE EXCEPTION 'Incorrect aggregate'; END IF;
 IF (SELECT count(*) FROM telemetry.report_members WHERE report_id='50000000-0000-0000-0000-000000000261')<>3 THEN RAISE EXCEPTION 'Incorrect membership'; END IF;
 IF (SELECT count(*) FROM telemetry.report_members WHERE report_id='50000000-0000-0000-0000-000000000261' AND eligibility_reason='censored')<>1 THEN RAISE EXCEPTION 'Incorrect censor count'; END IF;
 IF EXISTS(SELECT 1 FROM telemetry.report_members WHERE report_id='50000000-0000-0000-0000-000000000261' AND eligibility_reason NOT IN ('censored','unclassified','observer-coverage-unproven')) THEN RAISE EXCEPTION 'Unexpected eligibility'; END IF;
 IF (SELECT report_digest FROM telemetry.reports WHERE report_id='50000000-0000-0000-0000-000000000261')=
    (SELECT report_digest FROM telemetry.reports WHERE report_id='50000000-0000-0000-0000-000000000262') THEN RAISE EXCEPTION 'Supersession digest reused'; END IF;
END $$;
GRANT app_runtime TO sf_telemetry_c3_reporter;
SET SESSION AUTHORIZATION sf_telemetry_c3_reporter;
SET ROLE telemetry_reporter;
SELECT pg_temp.expect_error($q$SELECT * FROM telemetry.publish_incomplete_report('10000000-0000-0000-0000-000000000261',gen_random_uuid(),'2026-04-01Z','v1',ARRAY['UNVERIFIED'],NULL)$q$,'42501');
RESET SESSION AUTHORIZATION;
ROLLBACK;
