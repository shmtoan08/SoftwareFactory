\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL READ COMMITTED;
INSERT INTO public.projects(project_id,slug,name,repo_bare_path) VALUES
 ('10000000-0000-0000-0000-000000000291','dispatch-recovery-a','A','/unused'),
 ('10000000-0000-0000-0000-000000000292','dispatch-recovery-b','B','/unused');
INSERT INTO public.model_cost_sessions(cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd)
 VALUES('20000000-0000-0000-0000-000000000291','10000000-0000-0000-0000-000000000291',10,10,100,100);
INSERT INTO public.tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash)
 VALUES('30000000-0000-0000-0000-000000000291','10000000-0000-0000-0000-000000000291','fixture','{}','Ready',repeat('a',40));
INSERT INTO public.task_leases(lease_id,project_id,task_id,attempt_no,lease_epoch,worker_id,status,task_execution_idempotency_key,expires_at)
 VALUES('40000000-0000-0000-0000-000000000291','10000000-0000-0000-0000-000000000291','30000000-0000-0000-0000-000000000291',
  1,1,'fixture','ACTIVE',repeat('a',64),clock_timestamp()+interval '1 hour');
INSERT INTO telemetry.cohort_manifests VALUES
 ('50000000-0000-0000-0000-000000000291','10000000-0000-0000-0000-000000000291',repeat('a',64),'1','S',1,1,
  false,false,false,false,false,'fixture',clock_timestamp(),repeat('a',40),'1');
INSERT INTO telemetry.lifecycles(lifecycle_id,project_id,task_id,manifest_id)
 VALUES('60000000-0000-0000-0000-000000000291','10000000-0000-0000-0000-000000000291',
  '30000000-0000-0000-0000-000000000291','50000000-0000-0000-0000-000000000291');
INSERT INTO telemetry.dispatch_reservations
 SELECT '10000000-0000-0000-0000-000000000291',('70000000-0000-0000-0000-00000000029'||n)::uuid,
  ('80000000-0000-0000-0000-00000000029'||n)::uuid,'90000000-0000-0000-0000-000000000291',n,
  '20000000-0000-0000-0000-000000000291',1,1,clock_timestamp()-interval '2 hours',
  clock_timestamp()+CASE WHEN n=4 THEN interval '1 hour' ELSE interval '-1 hour' END
 FROM generate_series(1,4) n;
INSERT INTO telemetry.dispatch_attempts
 SELECT project_id,attempt_id,reservation_id,'60000000-0000-0000-0000-000000000291',
  '30000000-0000-0000-0000-000000000291','40000000-0000-0000-0000-000000000291',1,
  gen_random_uuid(),'fixture',NULL,'managed-v1','anthropic','fixture','prompt','1',repeat('a',64),'1',repeat('b',64)
 FROM telemetry.dispatch_reservations WHERE attempt_ordinal IN (2,3);
INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,event_digest,actor_ref)
 SELECT project_id,attempt_id,1,'PREPARED',repeat('a',64),'fixture' FROM telemetry.dispatch_attempts;
INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,prior_digest,event_digest,actor_ref)
 SELECT project_id,attempt_id,2,'DISPATCH_STARTED','PREPARED',repeat('a',64),repeat('b',64),'fixture'
 FROM telemetry.dispatch_attempts WHERE attempt_id='80000000-0000-0000-0000-000000000293';

CREATE ROLE sf_dispatch_recovery_fixture LOGIN NOINHERIT;
GRANT telemetry_dispatch_recovery TO sf_dispatch_recovery_fixture;
INSERT INTO telemetry.dispatch_recovery_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000291'
 FROM pg_roles WHERE rolname='sf_dispatch_recovery_fixture';
SET SESSION AUTHORIZATION sf_dispatch_recovery_fixture;
SET ROLE telemetry_dispatch_recovery;
DO $$
DECLARE project UUID:='10000000-0000-0000-0000-000000000291';
BEGIN
 IF telemetry.release_expired_dispatch_reservation(project,'70000000-0000-0000-0000-000000000291')<>'released'
 OR telemetry.release_expired_dispatch_reservation(project,'70000000-0000-0000-0000-000000000292')<>'released'
 OR telemetry.release_expired_dispatch_reservation(project,'70000000-0000-0000-0000-000000000293')<>'held_for_settlement'
 OR telemetry.release_expired_dispatch_reservation(project,'70000000-0000-0000-0000-000000000294')<>'active' THEN
  RAISE EXCEPTION 'Unexpected reservation outcome';
 END IF;
 IF telemetry.release_expired_dispatch_reservation(project,'70000000-0000-0000-0000-000000000291')<>'duplicate' THEN
  RAISE EXCEPTION 'Expiry recovery replay failed';
 END IF;
 IF telemetry.release_expired_dispatch_reservation(project,gen_random_uuid())<>'missing' THEN
  RAISE EXCEPTION 'Missing reservation outcome incorrect';
 END IF;
 BEGIN
  PERFORM telemetry.release_expired_dispatch_reservation('10000000-0000-0000-0000-000000000292',gen_random_uuid());
  RAISE EXCEPTION 'Foreign project authorized';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM 1 FROM telemetry.dispatch_reservations;
  RAISE EXCEPTION 'Direct table access granted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
RESET SESSION AUTHORIZATION;
GRANT app_runtime TO sf_dispatch_recovery_fixture;
SET SESSION AUTHORIZATION sf_dispatch_recovery_fixture;
SET ROLE telemetry_dispatch_recovery;
DO $$ BEGIN
 BEGIN
  PERFORM telemetry.release_expired_dispatch_reservation('10000000-0000-0000-0000-000000000291',
   '70000000-0000-0000-0000-000000000291');
  RAISE EXCEPTION 'Contaminated service membership was accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
RESET SESSION AUTHORIZATION;
REVOKE app_runtime FROM sf_dispatch_recovery_fixture;
DO $$ BEGIN
 IF (SELECT count(*) FROM telemetry.dispatch_reservation_releases)<>2
 OR (SELECT count(*) FROM telemetry.dispatch_events WHERE kind='CONFIRMED_NOT_SENT')<>1 THEN
  RAISE EXCEPTION 'Invalid recovery evidence';
 END IF;
 BEGIN
  INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,prior_digest,event_digest,actor_ref)
   VALUES('10000000-0000-0000-0000-000000000291','80000000-0000-0000-0000-000000000293',
    3,'TERMINAL','DISPATCH_STARTED',repeat('b',64),repeat('c',64),'fixture');
  RAISE EXCEPTION 'TERMINAL accepted without ledger';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
INSERT INTO public.model_cost_sessions(cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd)
 VALUES('20000000-0000-0000-0000-000000000292','10000000-0000-0000-0000-000000000292',10,10,100,100);
INSERT INTO public.model_call_ledgers(call_id,project_id,cost_session_id,stage,provider,model,prompt_id,prompt_version,
 prompt_sha256,request_sha256,estimated_input_tokens,reserved_output_tokens,estimated_cost_micro_usd,status)
 SELECT ('a0000000-0000-0000-0000-00000000029'||n)::uuid,
  ('10000000-0000-0000-0000-00000000029'||n)::uuid,('20000000-0000-0000-0000-00000000029'||n)::uuid,
  'fixture','anthropic','fixture','prompt','1',repeat('a',64),repeat('b',64),1,1,1,'ALLOWED'
 FROM generate_series(1,2) n;
DO $$ BEGIN
 BEGIN
  INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,prior_digest,event_digest,actor_ref,ledger_call_id)
   VALUES('10000000-0000-0000-0000-000000000291','80000000-0000-0000-0000-000000000293',
    3,'TERMINAL','DISPATCH_STARTED',repeat('b',64),repeat('c',64),'fixture','a0000000-0000-0000-0000-000000000292');
  RAISE EXCEPTION 'Foreign ledger accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;
INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,prior_digest,event_digest,actor_ref,ledger_call_id)
 VALUES('10000000-0000-0000-0000-000000000291','80000000-0000-0000-0000-000000000293',
  3,'TERMINAL','DISPATCH_STARTED',repeat('b',64),repeat('c',64),'fixture','a0000000-0000-0000-0000-000000000291');

UPDATE public.tasks SET status='ExecutingInTarget',active_lease_id='40000000-0000-0000-0000-000000000291',active_lease_epoch=1
 WHERE task_id='30000000-0000-0000-0000-000000000291';
UPDATE public.model_cost_sessions SET task_id='30000000-0000-0000-0000-000000000291'
 WHERE cost_session_id='20000000-0000-0000-0000-000000000291';
INSERT INTO telemetry.dispatch_reservations(project_id,reservation_id,attempt_id,logical_invocation_id,attempt_ordinal,
 cost_session_id,reserved_tokens,reserved_micro_usd,expires_at,lease_id,lease_epoch)
 SELECT '10000000-0000-0000-0000-000000000291',('70000000-0000-0000-0000-00000000029'||n)::uuid,
  ('80000000-0000-0000-0000-00000000029'||n)::uuid,'90000000-0000-0000-0000-000000000291',n,
  '20000000-0000-0000-0000-000000000291',1,1,clock_timestamp()+interval '1 hour','40000000-0000-0000-0000-000000000291',1
 FROM generate_series(5,6) n;
CREATE ROLE sf_dispatch_writer_fixture LOGIN NOINHERIT;
GRANT telemetry_dispatch_writer TO sf_dispatch_writer_fixture;
INSERT INTO telemetry.service_projects SELECT oid,rolname,'10000000-0000-0000-0000-000000000291','dispatch'
 FROM pg_roles WHERE rolname='sf_dispatch_writer_fixture';
SET SESSION AUTHORIZATION sf_dispatch_writer_fixture;
SET ROLE telemetry_dispatch_writer;
DO $$
DECLARE project UUID:='10000000-0000-0000-0000-000000000291';
 reservation UUID:='70000000-0000-0000-0000-000000000295';
 attempt UUID:='80000000-0000-0000-0000-000000000295';
 lifecycle UUID:='60000000-0000-0000-0000-000000000291';
 task UUID:='30000000-0000-0000-0000-000000000291';
 lease UUID:='40000000-0000-0000-0000-000000000291';
BEGIN
 FOR i IN 1..2 LOOP
  IF telemetry.prepare_dispatch_attempt(project,reservation,lifecycle,task,lease,1,'anthropic','fixture','prompt','1',repeat('a',64),'1')
   IS DISTINCT FROM attempt THEN RAISE EXCEPTION 'Wrong prepare receipt'; END IF;
 END LOOP;
 BEGIN
  PERFORM telemetry.prepare_dispatch_attempt(project,reservation,lifecycle,task,lease,1,'anthropic','changed','prompt','1',repeat('a',64),'1');
  RAISE EXCEPTION 'Changed binding accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 IF telemetry.start_dispatch_attempt(project,attempt,lease,1)<>'recorded'
 OR telemetry.start_dispatch_attempt(project,attempt,lease,1)<>'duplicate' THEN
  RAISE EXCEPTION 'Start did not distinguish first commit and replay';
 END IF;
 PERFORM telemetry.prepare_dispatch_attempt(project,'70000000-0000-0000-0000-000000000296',
  lifecycle,task,lease,1,'anthropic','fixture','prompt','1',repeat('a',64),'1');
END $$;
RESET SESSION AUTHORIZATION;
-- Concurrency fixture boundary: attempt 296 is prepared, with generation 1 still active.
\if :{?dispatch_concurrency_seed}
COMMIT;
\quit
\endif
UPDATE public.task_leases SET status='REVOKED',revoked_at=clock_timestamp()
 WHERE lease_id='40000000-0000-0000-0000-000000000291';
INSERT INTO public.task_leases(lease_id,project_id,task_id,attempt_no,lease_epoch,worker_id,status,task_execution_idempotency_key,expires_at)
 VALUES('40000000-0000-0000-0000-000000000292','10000000-0000-0000-0000-000000000291','30000000-0000-0000-0000-000000000291',
  2,2,'fixture','ACTIVE',repeat('b',64),clock_timestamp()+interval '1 hour');
UPDATE public.tasks SET active_lease_id='40000000-0000-0000-0000-000000000292',active_lease_epoch=2
 WHERE task_id='30000000-0000-0000-0000-000000000291';
SET SESSION AUTHORIZATION sf_dispatch_writer_fixture;
SET ROLE telemetry_dispatch_writer;
DO $$
DECLARE project UUID:='10000000-0000-0000-0000-000000000291';
BEGIN
 BEGIN
  PERFORM telemetry.start_dispatch_attempt(project,'80000000-0000-0000-0000-000000000296','40000000-0000-0000-0000-000000000291',1);
  RAISE EXCEPTION 'Stale generation started';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  PERFORM telemetry.prepare_dispatch_attempt(project,'70000000-0000-0000-0000-000000000296',
   '60000000-0000-0000-0000-000000000291','30000000-0000-0000-0000-000000000291','40000000-0000-0000-0000-000000000292',
   2,'anthropic','fixture','prompt','1',repeat('a',64),'1');
  RAISE EXCEPTION 'Other generation reused reservation';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
