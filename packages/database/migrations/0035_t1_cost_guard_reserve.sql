BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='telemetry_cost_guard') THEN
  CREATE ROLE telemetry_cost_guard NOLOGIN NOINHERIT;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='telemetry_cost_guard'
  AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit OR rolreplication))
  OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='telemetry_cost_guard'::regrole) THEN
  RAISE EXCEPTION 'Cost Guard role collision' USING ERRCODE='42501';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION telemetry.cost_guard_authorized(p_project UUID) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r JOIN telemetry.service_projects s
   ON s.principal_oid=r.oid AND s.principal_name=r.rolname
  WHERE r.rolname=session_user AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole
   AND NOT r.rolcreatedb AND NOT r.rolbypassrls AND NOT r.rolreplication
   AND NOT pg_has_role(r.oid,'app_runtime','MEMBER')
   AND pg_has_role(r.oid,'telemetry_cost_guard','MEMBER')
   AND s.project_id=p_project AND s.capability='dispatch');
$$;
ALTER FUNCTION telemetry.cost_guard_authorized(UUID) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.cost_guard_authorized(UUID) FROM PUBLIC;
GRANT USAGE ON SCHEMA telemetry TO telemetry_cost_guard;

DO $$
DECLARE rel TEXT;
BEGIN
 FOREACH rel IN ARRAY ARRAY['dispatch_reservations','dispatch_reservation_releases','dispatch_events'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS cost_guard_read ON telemetry.%I',rel);
  EXECUTE format('CREATE POLICY cost_guard_read ON telemetry.%I FOR SELECT TO telemetry_owner
    USING(telemetry.cost_guard_authorized(project_id))',rel);
 END LOOP;
END $$;
DROP POLICY IF EXISTS cost_guard_reserve ON telemetry.dispatch_reservations;
CREATE POLICY cost_guard_reserve ON telemetry.dispatch_reservations FOR INSERT TO telemetry_owner
 WITH CHECK(telemetry.cost_guard_authorized(project_id));

GRANT SELECT(max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd,
 tokens_used_total,cost_used_micro_usd) ON public.model_cost_sessions TO telemetry_owner;
GRANT UPDATE(cost_session_id) ON public.model_cost_sessions TO telemetry_owner;
DROP POLICY IF EXISTS cost_guard_session_read ON public.model_cost_sessions;
CREATE POLICY cost_guard_session_read ON public.model_cost_sessions FOR SELECT TO telemetry_owner
 USING(telemetry.cost_guard_authorized(project_id));
DROP POLICY IF EXISTS cost_guard_session_lock ON public.model_cost_sessions;
CREATE POLICY cost_guard_session_lock ON public.model_cost_sessions FOR UPDATE TO telemetry_owner
 USING(telemetry.cost_guard_authorized(project_id)) WITH CHECK(false);
DROP POLICY IF EXISTS cost_guard_session_no_update ON public.model_cost_sessions;
CREATE POLICY cost_guard_session_no_update ON public.model_cost_sessions AS RESTRICTIVE FOR UPDATE TO telemetry_owner
 USING(telemetry.cost_guard_authorized(project_id)) WITH CHECK(false);

GRANT INSERT(call_id,project_id,cost_session_id,pipeline_session_id,task_id,stage,provider,model,prompt_id,
 prompt_version,prompt_sha256,request_sha256,estimated_input_tokens,reserved_output_tokens,estimated_cost_micro_usd,
 actual_input_tokens,actual_output_tokens,actual_total_tokens,actual_cost_micro_usd,status,usage_estimated,
 block_reason,error_message,latency_ms) ON public.model_call_ledgers TO telemetry_owner;
DROP POLICY IF EXISTS cost_guard_blocked_ledger ON public.model_call_ledgers;
CREATE POLICY cost_guard_blocked_ledger ON public.model_call_ledgers FOR INSERT TO telemetry_owner
 WITH CHECK(telemetry.cost_guard_authorized(project_id) AND status='BLOCKED_PREFLIGHT'
  AND actual_input_tokens=0 AND actual_output_tokens=0 AND actual_total_tokens=0
  AND actual_cost_micro_usd=0 AND NOT usage_estimated AND latency_ms=0);
DROP POLICY IF EXISTS cost_guard_ledger_insert_guard ON public.model_call_ledgers;
CREATE POLICY cost_guard_ledger_insert_guard ON public.model_call_ledgers AS RESTRICTIVE FOR INSERT TO telemetry_owner
 WITH CHECK(telemetry.cost_guard_authorized(project_id) AND status='BLOCKED_PREFLIGHT'
  AND actual_input_tokens=0 AND actual_output_tokens=0 AND actual_total_tokens=0
  AND actual_cost_micro_usd=0 AND NOT usage_estimated AND latency_ms=0);

CREATE INDEX IF NOT EXISTS telemetry_dispatch_reservation_cost_session
 ON telemetry.dispatch_reservations(project_id,cost_session_id);

CREATE OR REPLACE FUNCTION telemetry.reserve_dispatch_cost(
 p_project UUID,p_session UUID,p_reservation UUID,p_attempt UUID,p_invocation UUID,p_ordinal INTEGER,
 p_lease UUID,p_epoch BIGINT,p_input INTEGER,p_output INTEGER,p_cost BIGINT,
 p_stage TEXT,p_provider TEXT,p_model TEXT,p_prompt TEXT,p_version TEXT,p_prompt_hash TEXT,p_request_hash TEXT)
RETURNS TABLE(reservation_id UUID,attempt_id UUID,expires_at TIMESTAMPTZ,blocked_call_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 cost_session RECORD;
 hold RECORD;
 request_tokens BIGINT;
 used_tokens NUMERIC;
 used_cost NUMERIC;
 scope TEXT;
 reason TEXT;
 admitted_at TIMESTAMPTZ;
 expiry TIMESTAMPTZ;
 blocked UUID;
BEGIN
 IF NOT telemetry.cost_guard_authorized(p_project) THEN
  RAISE EXCEPTION 'DISPATCH_AUTHORITY_DENIED' USING ERRCODE='42501';
 END IF;
 IF current_setting('transaction_isolation')<>'read committed'
   OR p_session IS NULL OR p_reservation IS NULL OR p_attempt IS NULL OR p_invocation IS NULL
   OR p_ordinal IS NULL OR p_ordinal<1 OR p_lease IS NULL OR p_epoch IS NULL OR p_epoch<1
   OR p_input IS NULL OR p_input<0 OR p_output IS NULL OR p_output<0 OR p_cost IS NULL OR p_cost NOT BETWEEN 0 AND 9007199254740991
   OR p_stage IS NULL OR btrim(p_stage)='' OR octet_length(p_stage)>128
   OR p_provider IS NULL OR p_provider NOT IN ('anthropic','google','openai')
   OR p_model IS NULL OR btrim(p_model)='' OR octet_length(p_model)>128
   OR p_prompt IS NULL OR btrim(p_prompt)='' OR octet_length(p_prompt)>128
   OR p_version IS NULL OR btrim(p_version)='' OR octet_length(p_version)>128
   OR p_prompt_hash IS NULL OR p_prompt_hash !~ '^[a-f0-9]{64}$'
   OR p_request_hash IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'DISPATCH_RESERVATION_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT s.status,s.task_id,s.pipeline_session_id,s.max_tokens_per_request,s.max_cost_micro_usd_per_request,
  s.session_token_budget,s.session_cost_budget_micro_usd,s.tokens_used_total,s.cost_used_micro_usd
 INTO STRICT cost_session FROM public.model_cost_sessions s
 WHERE s.project_id=p_project AND s.cost_session_id=p_session FOR UPDATE;
 -- Match the existing Cost Guard reader's safe-integer contract.
 IF greatest(cost_session.max_tokens_per_request,cost_session.max_cost_micro_usd_per_request,
   cost_session.session_token_budget,cost_session.session_cost_budget_micro_usd,
   cost_session.tokens_used_total,cost_session.cost_used_micro_usd)>9007199254740991 THEN
  RAISE EXCEPTION 'DISPATCH_RESERVATION_INVALID' USING ERRCODE='22023';
 END IF;

 request_tokens:=p_input::BIGINT+p_output;
 used_tokens:=cost_session.tokens_used_total;
 used_cost:=cost_session.cost_used_micro_usd;
 admitted_at:=clock_timestamp();

 IF cost_session.status<>'ACTIVE' THEN
  scope:='SESSION_EXHAUSTED';
  reason:=format('Cost session %s is %s',p_session,cost_session.status);
 ELSIF request_tokens>cost_session.max_tokens_per_request THEN
  scope:='PER_REQUEST_TOKENS';
  reason:=format('Projected request tokens (%s) exceeds max_tokens_per_request (%s)',request_tokens,cost_session.max_tokens_per_request);
 ELSIF p_cost>cost_session.max_cost_micro_usd_per_request THEN
  scope:='PER_REQUEST_COST';
  reason:=format('Projected request cost (%s micro-USD) exceeds max_cost_micro_usd_per_request (%s micro-USD)',p_cost,cost_session.max_cost_micro_usd_per_request);
 ELSE
  FOR hold IN
   SELECT r.reservation_id,r.attempt_id,r.expires_at,r.reserved_tokens,r.reserved_micro_usd
   FROM telemetry.dispatch_reservations r
   WHERE r.project_id=p_project AND r.cost_session_id=p_session
    AND NOT EXISTS (SELECT 1 FROM telemetry.dispatch_reservation_releases x
                    WHERE x.project_id=p_project AND x.reservation_id=r.reservation_id)
  LOOP
   -- An expired hold is free only after fencing a possible concurrent start.
   IF hold.expires_at<=admitted_at THEN
    IF pg_try_advisory_xact_lock(hashtextextended(p_project::text||':'||hold.reservation_id::text,2929)) THEN
     IF NOT EXISTS (SELECT 1 FROM telemetry.dispatch_events e
                    WHERE e.project_id=p_project AND e.attempt_id=hold.attempt_id AND e.kind='DISPATCH_STARTED') THEN
      CONTINUE;
     END IF;
    END IF;
   END IF;
   used_tokens:=used_tokens+hold.reserved_tokens;
   used_cost:=used_cost+hold.reserved_micro_usd;
  END LOOP;
  IF used_tokens+request_tokens>cost_session.session_token_budget THEN
   scope:='SESSION_TOKEN_BUDGET';
   reason:=format('Session tokens used (%s) + projected (%s) exceeds session_token_budget (%s)',used_tokens,request_tokens,cost_session.session_token_budget);
  ELSIF used_cost+p_cost>cost_session.session_cost_budget_micro_usd THEN
   scope:='SESSION_COST_BUDGET';
   reason:=format('Session cost used (%s micro-USD) + projected (%s micro-USD) exceeds session_cost_budget_micro_usd (%s micro-USD)',used_cost,p_cost,cost_session.session_cost_budget_micro_usd);
  END IF;
 END IF;

 IF scope IS NOT NULL THEN
  blocked:=gen_random_uuid();
  INSERT INTO public.model_call_ledgers(call_id,project_id,cost_session_id,pipeline_session_id,task_id,
   stage,provider,model,prompt_id,prompt_version,prompt_sha256,request_sha256,estimated_input_tokens,reserved_output_tokens,
   estimated_cost_micro_usd,actual_input_tokens,actual_output_tokens,actual_total_tokens,actual_cost_micro_usd,
   status,usage_estimated,block_reason,error_message,latency_ms)
  VALUES(blocked,p_project,p_session,cost_session.pipeline_session_id,cost_session.task_id,
   p_stage,p_provider,p_model,p_prompt,p_version,p_prompt_hash,p_request_hash,p_input,p_output,
   p_cost,0,0,0,0,'BLOCKED_PREFLIGHT',false,scope||': '||reason,reason,0);
  RETURN QUERY SELECT NULL::UUID,NULL::UUID,NULL::TIMESTAMPTZ,blocked;
  RETURN;
 END IF;

 expiry:=admitted_at+interval '5 minutes';
 INSERT INTO telemetry.dispatch_reservations(project_id,reservation_id,attempt_id,logical_invocation_id,
  attempt_ordinal,cost_session_id,reserved_tokens,reserved_micro_usd,reserved_at,expires_at,lease_id,lease_epoch)
 VALUES(p_project,p_reservation,p_attempt,p_invocation,p_ordinal,p_session,request_tokens,p_cost,admitted_at,expiry,p_lease,p_epoch);
 RETURN QUERY SELECT p_reservation,p_attempt,expiry,NULL::UUID;
END $$;
ALTER FUNCTION telemetry.reserve_dispatch_cost(UUID,UUID,UUID,UUID,UUID,INTEGER,UUID,BIGINT,INTEGER,INTEGER,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.reserve_dispatch_cost(UUID,UUID,UUID,UUID,UUID,INTEGER,UUID,BIGINT,INTEGER,INTEGER,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telemetry.reserve_dispatch_cost(UUID,UUID,UUID,UUID,UUID,INTEGER,UUID,BIGINT,INTEGER,INTEGER,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO telemetry_cost_guard;
COMMIT;
