import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildPostgresPoolConfigFromEnv, PostgresControlPlaneRepository, PostgresRuntimePool } from "../src/index.ts";

const source = process.env.PGDATABASE;
assert(source);
const database = `sf_cost_reserve_${randomBytes(8).toString("hex")}`;
const args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", database];
const sql = (input) => execFileSync("psql", args, { input, encoding: "utf8", timeout: 15000 }).trim();
const id = (kind, n) => `${kind}0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const project = id(1, 291), task = id(3, 291), lease = id(4, 291), lifecycle = id(6, 291);
const fixtureRole = `sf_cost_guard_${randomBytes(5).toString("hex")}`;
const guard = `SET SESSION AUTHORIZATION ${fixtureRole}; SET ROLE telemetry_cost_guard;`;
const writer = "SET SESSION AUTHORIZATION sf_dispatch_writer_fixture; SET ROLE telemetry_dispatch_writer;";
const reserve = (session, n, input, cost = 0, identity = `'${id(7, n)}'`, attempt = `'${id(8, n)}'`, target = project) =>
  `telemetry.reserve_dispatch_cost('${target}','${id(2, session)}',${identity},${attempt},
    '${id(9, 300)}',${n},'${lease}',1,${input},0,${cost},'fixture','anthropic','fixture','prompt','1',repeat('a',64),repeat('b',64))`;
const admitted = (call) => sql(`${guard}\nSELECT reservation_id FROM ${call};`);
const denied = (call) => sql(`${guard}\nSELECT blocked_call_id FROM ${call};`);
const pauseSnapshot = () => sql(`SELECT (SELECT count(*) FROM public.budget_pause_events WHERE project_id='${project}'),
 (SELECT row_to_json(p) FROM public.projects p WHERE project_id='${project}'),
 (SELECT row_to_json(t) FROM public.tasks t WHERE task_id='${task}'),
 (SELECT count(*) FROM public.budget_denial_intents WHERE project_id='${project}');`);
const expect = (call, condition, setup = guard) => sql(`${setup}
DO $$ BEGIN
 BEGIN PERFORM ${call}; RAISE EXCEPTION 'Expected rejection';
 EXCEPTION WHEN ${condition} THEN NULL;
 END;
END $$;`);

let created = false;
let holder;
let contender;
let pool;
try {
  execFileSync("createdb", ["--maintenance-db", source, "--template", source, database], { timeout: 15000 });
  created = true;
  execFileSync("psql", [...args, "-v", "dispatch_concurrency_seed=1", "-f",
    fileURLToPath(new URL("./telemetry-dispatch-recovery.sql", import.meta.url))], { timeout: 15000 });
  sql(`CREATE ROLE ${fixtureRole} LOGIN NOINHERIT;
    GRANT telemetry_cost_guard TO ${fixtureRole};
    INSERT INTO telemetry.service_projects SELECT oid,rolname,'${project}','dispatch' FROM pg_roles WHERE rolname='${fixtureRole}';
    INSERT INTO public.model_cost_sessions(cost_session_id,project_id,task_id,max_tokens_per_request,max_cost_micro_usd_per_request,
      session_token_budget,session_cost_budget_micro_usd,tokens_used_total,cost_used_micro_usd)
    SELECT key,'${project}','${task}',10,10,10,10,used,used FROM (VALUES
      ('${id(2, 301)}'::uuid,3), ('${id(2, 302)}'::uuid,0), ('${id(2, 303)}'::uuid,0),
      ('${id(2, 304)}'::uuid,0), ('${id(2, 305)}'::uuid,0), ('${id(2, 306)}'::uuid,10)) s(key,used);`);
  const baseline = pauseSnapshot();
  assert.equal(admitted(reserve(301, 301, 4, 4)), id(7, 301));
  assert.equal(admitted(reserve(301, 302, 3, 3)), id(7, 302));
  assert.equal(sql(`SELECT attempt_id,lease_id,lease_epoch,reserved_tokens,reserved_micro_usd,
    expires_at-reserved_at FROM telemetry.dispatch_reservations WHERE reservation_id='${id(7, 302)}';`),
  `${id(8, 302)}|${lease}|1|3|3|00:05:00`);
  assert.equal(sql(`SELECT count(*) FROM telemetry.dispatch_attempts WHERE attempt_id='${id(8, 302)}';`), "0");

  // Business denial commits on the private connection before the outer unit rolls back.
  holder = spawn("psql", args, { stdio: ["pipe", "pipe", "inherit"] });
  const outerClosed = once(holder, "close");
  let outerReady = "";
  holder.stdout.on("data", (chunk) => { outerReady += chunk; });
  holder.stdin.write("BEGIN; SELECT 1;\n\\echo outer_ready\n");
  const outerDeadline = Date.now() + 8000;
  while (!outerReady.includes("outer_ready")) {
    assert(holder.exitCode === null && Date.now() < outerDeadline, "Outer transaction did not start");
    await delay(20);
  }
  const blocked = denied(reserve(301, 303, 1));
  holder.stdin.end("ROLLBACK;\n");
  assert.equal((await outerClosed)[0], 0);
  holder = undefined;
  assert.match(blocked, /^[a-f0-9-]{36}$/);
  assert.equal(sql(`SELECT count(*) FROM public.model_call_ledgers WHERE call_id='${blocked}';`), "1");
  assert.equal(sql(`SELECT count(*) FROM telemetry.dispatch_reservations WHERE attempt_id='${id(8, 303)}';`), "0");
  assert.equal(pauseSnapshot(), baseline);
  expect(reserve(301, 304, 1, 0, "NULL"), "invalid_parameter_value");
  expect(reserve(301, 304, 1, 0, `'${id(7, 304)}'`, "NULL"), "invalid_parameter_value");
  expect(reserve(301, 304, 1, "NULL"), "invalid_parameter_value");
  expect(reserve(301, 304, 1, "9007199254740992"), "invalid_parameter_value");
  expect(reserve(999, 304, 1), "no_data_found");
  expect(reserve(301, 304, 1, 0, undefined, undefined, id(1, 292)), "insufficient_privilege");
  expect(reserve(301, 304, 1), "insufficient_privilege", writer);
  expect(reserve(301, 304, 1), "invalid_parameter_value", `BEGIN ISOLATION LEVEL REPEATABLE READ; ${guard}`);

  assert.equal(sql(`${writer} SELECT telemetry.prepare_dispatch_attempt('${project}','${id(7,302)}',
    '${lifecycle}','${task}','${lease}',1,'anthropic','fixture','prompt','1',repeat('a',64),'1');`), id(8, 302));
  sql(`${writer} SELECT telemetry.start_dispatch_attempt('${project}','${id(8,302)}','${lease}',1);`);
  assert.equal(sql(`SELECT kind FROM telemetry.dispatch_events WHERE attempt_id='${id(8,302)}' AND sequence=2;`), "DISPATCH_STARTED");

  // Compare the whole existing ledger row shape with the actual TypeScript writer.
  const parityBlocked = denied(reserve(306, 309, 1));
  pool = new PostgresRuntimePool(buildPostgresPoolConfigFromEnv({ ...process.env, PGDATABASE: database }));
  const repo = new PostgresControlPlaneRepository(pool);
  const preflight = await repo.preflightCheckCostSession({
    project_id: project, cost_session_id: id(2,306), stage: "fixture", provider: "anthropic", model: "fixture",
    prompt_id: "prompt", prompt_version: "1", prompt_sha256: "a".repeat(64), request_sha256: "b".repeat(64),
    estimated_input_tokens: 1, reserved_output_tokens: 0, estimated_cost_micro_usd: 0,
  });
  assert.equal(preflight.allowed, false);
  assert.equal(preflight.limitScope, "SESSION_TOKEN_BUDGET");
  assert.equal(sql(`SELECT to_jsonb(l)-'call_id'-'created_at' FROM public.model_call_ledgers l WHERE call_id='${parityBlocked}';`),
    sql(`SELECT to_jsonb(l)-'call_id'-'created_at' FROM public.model_call_ledgers l WHERE call_id='${preflight.blockedLedger.call_id}';`));

  assert.ok(denied(reserve(304, 310, 1, 11)));
  sql(`UPDATE public.model_cost_sessions SET cost_used_micro_usd=9 WHERE cost_session_id='${id(2,304)}';`);
  assert.equal(admitted(reserve(304, 311, 0, 1)), id(7,311));
  const costDenial = denied(reserve(304, 312, 0, 1));
  assert.match(sql(`SELECT block_reason FROM public.model_call_ledgers WHERE call_id='${costDenial}';`), /^SESSION_COST_BUDGET: /);

  // Seed expired or released rows, including an expired started attempt without a ledger.
  sql(`INSERT INTO telemetry.dispatch_reservations(project_id,reservation_id,attempt_id,logical_invocation_id,attempt_ordinal,
    cost_session_id,reserved_tokens,reserved_micro_usd,reserved_at,expires_at,lease_id,lease_epoch)
    SELECT '${project}',('70000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
      ('80000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'${id(9,300)}',n,
      CASE WHEN n=325 THEN '${id(2,305)}'::uuid ELSE '${id(2,303)}'::uuid END,10,10,
      clock_timestamp()-interval '2 hours',clock_timestamp()+CASE WHEN n=324 THEN interval '1 hour' ELSE interval '-1 hour' END,
      '${lease}',1 FROM generate_series(323,325) n;
    INSERT INTO telemetry.dispatch_reservation_releases(project_id,reservation_id,actor_ref,released_at)
      VALUES ('${project}','${id(7,324)}','fixture',clock_timestamp());
    INSERT INTO telemetry.dispatch_attempts(project_id,attempt_id,reservation_id,lifecycle_id,task_id,lease_id,lease_epoch,
      execution_ref,generation_ref,route_version,provider,model,prompt_id,prompt_version,prompt_hmac_ref,key_version,binding_digest)
    VALUES ('${project}','${id(8,325)}','${id(7,325)}','${lifecycle}','${task}','${lease}',1,
      '${lease}','1','managed-dispatch-v1','anthropic','fixture','prompt','1',repeat('a',64),'1',repeat('b',64));
    INSERT INTO telemetry.dispatch_events(project_id,attempt_id,sequence,kind,prior_kind,prior_digest,event_digest,actor_ref)
    VALUES ('${project}','${id(8,325)}',1,'PREPARED',NULL,NULL,repeat('a',64),'fixture'),
           ('${project}','${id(8,325)}',2,'DISPATCH_STARTED','PREPARED',repeat('a',64),repeat('b',64),'fixture');`);
  assert.equal(admitted(reserve(303, 326, 10, 10)), id(7,326));
  assert.ok(denied(reserve(305, 327, 1)));

  holder = spawn("psql", args, { stdio: ["pipe", "pipe", "inherit"] });
  let output = "";
  holder.stdout.on("data", (chunk) => { output += chunk; });
  const released = once(holder, "close");
  holder.stdin.write(`${guard}\nBEGIN; SELECT reservation_id FROM ${reserve(302, 330, 6)};\n\\echo reserve_lock_ready\n`);
  const deadline = Date.now() + 8000;
  while (!output.includes("reserve_lock_ready")) {
    assert(holder.exitCode === null && Date.now() < deadline, "First Reserve did not reach the lock barrier");
    await delay(20);
  }
  assert.match(output, new RegExp(id(7,330)));
  contender = spawn("psql", args, { stdio: ["pipe", "pipe", "inherit"] });
  let second = "";
  contender.stdout.on("data", (chunk) => { second += chunk; });
  const secondClosed = once(contender, "close");
  contender.stdin.end(`SET application_name='sf_reserve_contender'; SET statement_timeout='8s';
    ${guard}\nSELECT blocked_call_id FROM ${reserve(302, 331, 6)};`);
  while (sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='sf_reserve_contender' AND wait_event_type='Lock';") !== "1") {
    assert(contender.exitCode === null && Date.now() < deadline, "Competing Reserve did not wait for the session lock");
    await delay(20);
  }
  holder.stdin.end("COMMIT;\n");
  assert.equal((await released)[0], 0);
  assert.equal((await secondClosed)[0], 0);
  assert.match(second.trim(), /^[a-f0-9-]{36}$/);
  assert.equal(sql(`SELECT count(*) FROM telemetry.dispatch_reservations WHERE cost_session_id='${id(2,302)}';`), "1");
  assert.equal(sql(`SELECT count(*) FROM public.model_call_ledgers WHERE call_id='${second.trim()}' AND status='BLOCKED_PREFLIGHT';`), "1");
  console.log("Cost Guard Reserve: budget, parity, independent denial, expiry, prepare/start and concurrent admission passed.");
} finally {
  holder?.kill("SIGTERM");
  contender?.kill("SIGTERM");
  await pool?.close();
  if (created) execFileSync("dropdb", ["--maintenance-db", source, "--force", database], { timeout: 15000 });
  execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", source], {
    input: `DROP ROLE IF EXISTS ${fixtureRole}, sf_dispatch_writer_fixture, sf_dispatch_recovery_fixture;`, timeout: 10000,
  });
}
