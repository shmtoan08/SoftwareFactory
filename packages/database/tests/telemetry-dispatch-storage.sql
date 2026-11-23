\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.expect_error(command TEXT, expected TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
  EXECUTE command;
 EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE=expected THEN RETURN; END IF;
  RAISE;
 END;
 RAISE EXCEPTION 'Expected SQLSTATE %, command succeeded',expected;
END $$;

DO $$
DECLARE
 project UUID:=gen_random_uuid();
 foreign_project UUID:=gen_random_uuid();
 task UUID:=gen_random_uuid();
 other_task UUID:=gen_random_uuid();
 cost_session UUID:=gen_random_uuid();
 lifecycle UUID:=gen_random_uuid();
 manifest UUID:=gen_random_uuid();
 lease UUID:=gen_random_uuid();
 reservation UUID:=gen_random_uuid();
 attempt UUID:=gen_random_uuid();
 invocation UUID:=gen_random_uuid();
 digest TEXT:=repeat('a',64);
BEGIN
 INSERT INTO public.projects(project_id,slug,name,repo_bare_path) VALUES
  (project,'dispatch-e1-a','E1 A','/unused'),(foreign_project,'dispatch-e1-b','E1 B','/unused');
 INSERT INTO public.tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash) VALUES
  (task,project,'fixture','{}','Ready',repeat('b',40)),
  (other_task,project,'fixture','{}','Ready',repeat('b',40));
 INSERT INTO public.task_leases(lease_id,project_id,task_id,attempt_no,lease_epoch,worker_id,status,task_execution_idempotency_key,expires_at)
 VALUES(lease,project,task,1,1,'fixture','ACTIVE',digest,clock_timestamp()+interval '1 hour');
 INSERT INTO public.model_cost_sessions(cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd)
 VALUES(cost_session,project,10,10,100,100);
 INSERT INTO telemetry.cohort_manifests VALUES
  (manifest,project,digest,'1','S',1,1,false,false,false,false,false,'fixture',clock_timestamp(),repeat('b',40),'1');
 INSERT INTO telemetry.lifecycles(lifecycle_id,project_id,task_id,manifest_id)
 VALUES(lifecycle,project,task,manifest);
 INSERT INTO telemetry.dispatch_reservations(project_id,reservation_id,attempt_id,logical_invocation_id,attempt_ordinal,
  cost_session_id,reserved_tokens,reserved_micro_usd,expires_at)
 VALUES(project,reservation,attempt,invocation,1,cost_session,1,1,clock_timestamp()+interval '1 hour');
 BEGIN
  INSERT INTO telemetry.dispatch_reservations
  SELECT project_id,gen_random_uuid(),gen_random_uuid(),logical_invocation_id,attempt_ordinal,
   cost_session_id,reserved_tokens,reserved_micro_usd,reserved_at,expires_at
  FROM telemetry.dispatch_reservations WHERE reservation_id=reservation;
  RAISE EXCEPTION 'Duplicate invocation ordinal was allowed';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO telemetry.dispatch_reservations
  SELECT foreign_project,gen_random_uuid(),gen_random_uuid(),logical_invocation_id,attempt_ordinal,
   cost_session_id,reserved_tokens,reserved_micro_usd,reserved_at,expires_at
  FROM telemetry.dispatch_reservations WHERE reservation_id=reservation;
  RAISE EXCEPTION 'Cross-project cost session was allowed';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 INSERT INTO telemetry.dispatch_attempts(project_id,attempt_id,reservation_id,lifecycle_id,task_id,lease_id,lease_epoch,
  execution_ref,generation_ref,route_version,provider,model,prompt_id,prompt_version,prompt_hmac_ref,key_version,binding_digest)
 VALUES(project,attempt,reservation,lifecycle,task,lease,1,gen_random_uuid(),'fixture','managed-v1','anthropic','fixture','prompt','1',digest,'1',digest);
 BEGIN
  INSERT INTO telemetry.dispatch_reservations
  SELECT project_id,gen_random_uuid(),gen_random_uuid(),logical_invocation_id,2,
   cost_session_id,reserved_tokens,reserved_micro_usd,reserved_at,expires_at
  FROM telemetry.dispatch_reservations WHERE reservation_id=reservation;
  INSERT INTO telemetry.dispatch_attempts
  SELECT a.project_id,r.attempt_id,r.reservation_id,a.lifecycle_id,other_task,a.lease_id,a.lease_epoch,
   a.execution_ref,a.generation_ref,a.pipeline_session_id,a.route_version,a.provider,a.model,a.prompt_id,a.prompt_version,
   a.prompt_hmac_ref,a.key_version,a.binding_digest
  FROM telemetry.dispatch_attempts a JOIN telemetry.dispatch_reservations r USING(project_id)
  WHERE a.attempt_id=attempt AND r.attempt_ordinal=2;
  RAISE EXCEPTION 'Cross-task attempt was allowed';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,event_digest,actor_ref)
 VALUES(project,attempt,1,'PREPARED',digest,'fixture');
 PERFORM pg_temp.expect_error(format(
  'INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,prior_digest,event_digest,actor_ref)
   VALUES(%L,%L,3,%L,%L,%L,%L,%L)',project,attempt,'TERMINAL','DISPATCH_STARTED',digest,digest,'fixture'),'23503');
 PERFORM pg_temp.expect_error(format(
  'INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,event_digest,actor_ref)
   VALUES(%L,%L,2,%L,%L,%L,%L)',project,attempt,'DISPATCH_STARTED','PREPARED',digest,'fixture'),'23514');
 INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,prior_digest,event_digest,actor_ref)
 VALUES(project,attempt,2,'DISPATCH_STARTED','PREPARED',digest,repeat('b',64),'fixture');
 PERFORM pg_temp.expect_error(format(
  'INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,prior_digest,event_digest,actor_ref)
   VALUES(%L,%L,2,%L,%L,%L,%L,%L)',project,attempt,'CONFIRMED_NOT_SENT','PREPARED',digest,digest,'fixture'),'23505');
END $$;

DO $$
DECLARE role_name TEXT; relation_name TEXT; visible_rows BIGINT;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['dispatch_reservations','dispatch_attempts','dispatch_events'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=format('telemetry.%I',relation_name)::regclass
    AND relrowsecurity AND relforcerowsecurity AND relowner='telemetry_owner'::regrole)
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=format('telemetry.%I',relation_name)::regclass) THEN
   RAISE EXCEPTION 'Missing deny-all RLS on %',relation_name;
  END IF;
  FOREACH role_name IN ARRAY ARRAY['app_runtime','telemetry_ingestor','telemetry_reporter','telemetry_operator'] LOOP
   EXECUTE format('SET SESSION AUTHORIZATION %I',role_name);
   PERFORM set_config('app.current_role','system_admin_role',true);
   PERFORM set_config('app.current_project_id',gen_random_uuid()::text,true);
   PERFORM pg_temp.expect_error(format('SELECT 1 FROM telemetry.%I',relation_name),'42501');
   PERFORM pg_temp.expect_error(format('INSERT INTO telemetry.%I DEFAULT VALUES',relation_name),'42501');
   RESET SESSION AUTHORIZATION;
  END LOOP;
  SET LOCAL ROLE telemetry_owner;
  EXECUTE format('SELECT count(*) FROM telemetry.%I',relation_name) INTO visible_rows;
  IF visible_rows<>0 THEN RAISE EXCEPTION 'Owner bypassed FORCE RLS'; END IF;
  PERFORM pg_temp.expect_error(format('INSERT INTO telemetry.%I DEFAULT VALUES',relation_name),'42501');
  RESET ROLE;
  PERFORM pg_temp.expect_error(format('UPDATE telemetry.%I SET project_id=project_id',relation_name),'42501');
  PERFORM pg_temp.expect_error(format('DELETE FROM telemetry.%I',relation_name),'42501');
 END LOOP;
 PERFORM pg_temp.expect_error(
  'TRUNCATE telemetry.dispatch_reservations,telemetry.dispatch_attempts,telemetry.dispatch_events','42501');
END $$;
ROLLBACK;
