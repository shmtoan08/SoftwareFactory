import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { PostgresTelemetryDelivery, buildPostgresPoolConfigFromEnv } from "@software-factory/database";
import { CallTelemetryObserver, type CallTelemetryEvent } from "@software-factory/adapter-sdk";

it("T1 B2 real authenticated SQL delivery, commit/rollback visibility, deadlines and fail-closed roles", { timeout: 30000 }, async t => {
  const config = buildPostgresPoolConfigFromEnv();
  if (!config) { t.skip("PostgreSQL connection not configured"); return; }
  const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
  const database = `sf_m6c3_a_delivery_${suffix}`; const role = `sf_ingest_${suffix}`; const writerRole = `sf_writer_${suffix}`;
  const password = randomBytes(24).toString("hex");
  const env = { ...process.env, PGHOST: config.host, PGPORT: String(config.port), PGUSER: config.user, PGPASSWORD: config.password ?? "", PGDATABASE: database };
  const sql = (input: string): string => execFileSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", database], { env, input, encoding: "utf8", timeout: 5000 });
  const project = randomUUID(); const session = randomUUID();
  const transport = new PostgresTelemetryDelivery({ ...config, database, user: role, password }, project);
  const signal = new AbortController().signal;
  const captured: CallTelemetryEvent[] = [];
  const observer = new CallTelemetryObserver({ projectId: project, environment: "fixture", keyVersion: "1", hmacKey: Buffer.alloc(32, 9), deliver: async events => { captured.push(...events); } });
  let created = false;
  const active = new Set<ReturnType<typeof spawn>>();
  try {
    execFileSync("createdb", ["--maintenance-db", config.database, "--template", config.database, database], { env, timeout: 15000 }); created = true;
    sql(`BEGIN; CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'; GRANT telemetry_ingestor TO ${role};
      CREATE ROLE ${writerRole} NOLOGIN; GRANT INSERT ON public.model_call_ledgers TO ${writerRole};
      INSERT INTO public.projects(project_id,slug,name,repo_bare_path) VALUES('${project}','b2-fixture','fixture','/unused');
      INSERT INTO public.model_cost_sessions(cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd) VALUES('${session}','${project}',10,10,100,100);
      INSERT INTO telemetry.service_projects SELECT oid,rolname,'${project}','ingest' FROM pg_roles WHERE rolname='${role}'; COMMIT;`);
    const handle = observer.begin({ projectId: project, costSessionId: session, taskId: null, pipelineSessionId: null, provider: "anthropic", model: "fixture", promptId: "fixture", promptVersion: "1", promptSha256: "a".repeat(64) }); assert(handle);
    observer.usage(handle, { input_tokens: "9007199254740993" });
    const ledger = randomUUID(); observer.ledgerCandidate(handle, ledger);
    for (let n = 0; n < 100 && captured.length !== 3; n++) await delay(5);
    assert.equal(captured.length, 3);
    await transport.deliver(captured, signal); await transport.deliver(captured, signal);
    assert.equal(sql(`SELECT count(*) FROM telemetry.invocations WHERE project_id='${project}';`).trim(), "1");
    assert.equal(sql(`SELECT count(*) FROM telemetry.ledger_candidates WHERE project_id='${project}';`).trim(), "1");
    assert.equal((await transport.reconcile(signal))[0]?.disposition, "pending");
    assert.equal(sql(`SELECT count(*) FROM telemetry.quality_events WHERE project_id='${project}';`).trim(), "0");

    const insertLedger = (id: string) => `INSERT INTO public.model_call_ledgers(call_id,project_id,cost_session_id,stage,provider,model,prompt_id,prompt_version,prompt_sha256,request_sha256,estimated_input_tokens,reserved_output_tokens,estimated_cost_micro_usd,status) VALUES('${id}','${project}','${session}','fixture','anthropic','fixture','fixture','1',repeat('a',64),repeat('b',64),0,0,0,'ALLOWED');`;
    async function holdingLedger(id: string) {
      const child = spawn("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", database], { env, stdio: ["pipe","pipe","pipe"] }); active.add(child);
      let output = ""; child.stdout!.on("data", data => { output += String(data); });
      const done = new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", code => { active.delete(child); code === 0 ? resolve() : reject(new Error("Fixture writer failed")); }); }); done.catch(() => {});
      child.stdin!.write(`BEGIN; ${insertLedger(id)}\n\\echo writer_ready\n`);
      for (let n = 0; n < 200 && !output.includes("writer_ready"); n++) await delay(5);
      assert(output.includes("writer_ready"));
      return { child, done };
    }
    const first = await holdingLedger(ledger);
    assert.equal((await transport.reconcile(signal))[0]?.disposition, "pending");
    first.child.stdin!.end("ROLLBACK;\n"); await first.done;
    assert.equal((await transport.reconcile(signal))[0]?.disposition, "pending");
    assert.equal(sql(`SELECT count(*) FROM telemetry.settlements WHERE project_id='${project}';`).trim(), "0");
    const second = await holdingLedger(ledger);
    assert.equal((await transport.reconcile(signal))[0]?.disposition, "pending");
    second.child.stdin!.end("COMMIT;\n"); await second.done;
    assert.equal((await transport.reconcile(signal))[0]?.disposition, "recorded");
    assert.equal((await transport.reconcile(signal))[0]?.disposition, "duplicate");
    assert.equal(sql(`SELECT count(*) FROM public.model_call_ledgers WHERE project_id='${project}';`).trim(), "1");

    // No raw/unknown fields reach SQL. A getter is rejected without execution.
    let touched = false;
    await assert.rejects(transport.deliver([{ ...captured[0], get raw_prompt() { touched = true; return "PRIVATE_CANARY"; } }], signal), /Invalid telemetry delivery/);
    assert.equal(touched, false);
    await assert.rejects(transport.deliver([{ ...captured[0], projectId: randomUUID() }], signal), /Invalid telemetry delivery/);
    const another = randomUUID();
    await assert.rejects(transport.deliver([
      { ...captured[0], invocationId: another },
      { ...captured[1], invocationId: another, numericUsage: { totalTokenCount: "1" } },
    ], signal), /Telemetry database operation unavailable/);
    assert.equal(sql(`SELECT count(*) FROM telemetry.invocations WHERE project_id='${project}';`).trim(), "1");
    const unavailable = new PostgresTelemetryDelivery({ ...config, database: `missing_${suffix}`, user: role, password }, project);
    await assert.rejects(unavailable.deliver(captured, signal), /Telemetry database operation unavailable/);
    await assert.rejects(transport.reconcile(signal, undefined, 101), /Invalid telemetry delivery/);
    await assert.rejects(transport.deliver(Array.from({ length: 101 }, () => captured[0]), signal), /Invalid telemetry delivery/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(transport.deliver(captured, aborted.signal), /Telemetry database operation unavailable/);
    const adminTransport = new PostgresTelemetryDelivery({ ...config, database }, project);
    await assert.rejects(adminTransport.deliver(captured, signal), /Telemetry database operation unavailable/);
    const foreignProject = randomUUID();
    const foreign = new PostgresTelemetryDelivery({ ...config, database, user: role, password }, foreignProject);
    await assert.rejects(foreign.deliver(captured.map(event => ({ ...event, projectId: foreignProject })), signal), /Telemetry database operation unavailable/);
    sql(`GRANT app_runtime TO ${role};`);
    await assert.rejects(transport.reconcile(signal), /Telemetry database operation unavailable/);
    sql(`REVOKE app_runtime FROM ${role};`);
    const running = transport.deliver(captured, signal);
    await assert.rejects(transport.reconcile(signal), /Invalid telemetry delivery/);
    await running;
    assert.throws(() => execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", database], {
      env: { ...env, PGUSER: role, PGPASSWORD: password }, input: "SELECT * FROM telemetry.ledger_candidates;", stdio: ["pipe","pipe","pipe"], timeout: 5000,
    }));
    sql(`GRANT ${writerRole} TO ${role};`);
    await assert.rejects(transport.reconcile(signal), /Telemetry database operation unavailable/);
    sql(`REVOKE ${writerRole} FROM ${role};`);

    // A blocking DDL lock must fail within lock/connection deadlines and roll back.
    const blocker = spawn("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", database], { env, stdio: ["pipe","pipe","pipe"] }); active.add(blocker);
    let locked = false; blocker.stdout!.on("data", data => { if (String(data).includes("lock_ready")) locked = true; });
    const blockerDone = new Promise<void>(resolve => blocker.on("close", () => { active.delete(blocker); resolve(); }));
    blocker.stdin!.write("BEGIN; LOCK telemetry.invocations IN ACCESS EXCLUSIVE MODE;\n\\echo lock_ready\n");
    for (let n = 0; n < 200 && !locked; n++) await delay(5); assert(locked);
    const started = performance.now();
    await assert.rejects(transport.deliver(captured, signal), /Telemetry database operation unavailable/);
    assert(performance.now() - started < 3000);
    blocker.stdin!.end("ROLLBACK;\n"); await blockerDone;
    assert.equal(sql(`SELECT count(*) FROM telemetry.invocations WHERE project_id='${project}';`).trim(), "1");
    assert.throws(() => sql("UPDATE telemetry.ledger_candidates SET ledger_call_id=ledger_call_id;"));
    assert.throws(() => sql("DELETE FROM telemetry.ledger_candidates;"));
    assert.throws(() => sql("TRUNCATE telemetry.ledger_candidates;"));
    sql(`DELETE FROM telemetry.service_projects WHERE principal_name='${role}';`);
    await assert.rejects(transport.reconcile(signal), /Telemetry database operation unavailable/);
  } finally {
    observer.stop(); for (const child of active) child.kill("SIGTERM");
    if (created) {
      execFileSync("dropdb", ["--maintenance-db", config.database, "--force", database], { env, timeout: 15000 });
      execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", config.database], { env, input: `DROP ROLE IF EXISTS ${role}; DROP ROLE IF EXISTS ${writerRole};`, stdio: ["pipe","pipe","pipe"], timeout: 5000 });
    }
  }
});
