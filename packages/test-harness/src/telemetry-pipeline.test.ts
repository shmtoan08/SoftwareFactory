import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { buildPostgresPoolConfigFromEnv, createControlPlaneStoreFromEnv, PostgresTelemetryDelivery } from "@software-factory/database";
import { CallTelemetryObserver, LiveModelProviderClient, ManagedModelProviderExecutor, type ModelCompletionResponse } from "@software-factory/adapter-sdk";
import { ProductPipelineService } from "@software-factory/product-pipeline";

it("T1 B3 real pipeline TX2 visibility, rollback compensation and telemetry noninterference", { timeout: 60000 }, async t => {
  const config = buildPostgresPoolConfigFromEnv();
  if (!config) { t.skip("PostgreSQL connection not configured"); return; }
  const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
  const database = `sf_m6c3_a_pipeline_${suffix}`, role = `sf_ingest_${suffix}`, password = randomBytes(24).toString("hex");
  const env = { ...process.env, PGHOST: config.host, PGPORT: String(config.port), PGUSER: config.user, PGPASSWORD: config.password ?? "", PGDATABASE: database };
  const sql = (input: string) => execFileSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", database], { env, input, encoding: "utf8", timeout: 5000 }).trim();
  let created = false;
  let runtime: ReturnType<typeof createControlPlaneStoreFromEnv> | undefined;
  const observers: CallTelemetryObserver[] = [];
  async function drained(observer: CallTelemetryObserver) {
    for (let n = 0; n < 600 && observer.stats().pending; n++) await delay(5);
    assert.equal(observer.stats().pending, 0);
  }
  try {
    execFileSync("createdb", ["--maintenance-db", config.database, "--template", config.database, database], { env, timeout: 15000 }); created = true;
    sql(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'; GRANT telemetry_ingestor TO ${role};`);
    runtime = createControlPlaneStoreFromEnv({ poolConfig: { ...config, database }, requirePostgres: true });
    const store = runtime.store;
    const project = await store.withRlsTransaction({ currentRole: "system_admin_role", currentPrincipalId: "fixture-admin" }, () => store.createProject({ slug: `b3-${suffix}`, name: "B3 fixture", repo_bare_path: "/unused", initial_main_commit_hash: "a".repeat(40), initial_main_tree_hash: "b".repeat(40) }));
    const projectId = project.project_id;
    sql(`INSERT INTO telemetry.service_projects SELECT oid,rolname,'${projectId}','ingest' FROM pg_roles WHERE rolname='${role}';`);
    const transport = new PostgresTelemetryDelivery({ ...config, database, user: role, password }, projectId);
    const signal = new AbortController().signal;
    const results = new Map<string, unknown>();
    for (const rollback of [false, true]) {
      for (const mode of ["off", "sql", "unavailable", "late"] as const) {
        let calls = 0;
        class FixtureClient extends LiveModelProviderClient {
          override async complete(): Promise<ModelCompletionResponse> {
            calls++;
            // Test barrier: persist registration while the provider call is outside TX2.
            if (observer && mode !== "late") await drained(observer);
            return { provider: "anthropic", model: this.config.model, endpoint: "fixture", requestSha256: "b".repeat(64), contentText: JSON.stringify({ summary: "Fixture discovery", facts: [], assumptions: [], recommendations: [] }), rawUsage: { input_tokens: 1, output_tokens: 2 }, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
          }
        }
        const unavailable: PostgresTelemetryDelivery = new PostgresTelemetryDelivery({ ...config, database: `missing_${suffix}`, user: role, password }, projectId);
        const observer: CallTelemetryObserver | undefined = mode === "off" ? undefined : new CallTelemetryObserver({ projectId, environment: "fixture", keyVersion: "1", hmacKey: Buffer.alloc(32, 9), deliver: mode === "late" ? async (events, signal) => {
          for (let n = 0; n < 600 && !entered; n++) await delay(5);
          await transport.deliver(events, signal);
        } : mode === "sql" ? transport.deliver : unavailable.deliver });
        if (observer) observers.push(observer);
        const pipeline = new ProductPipelineService({ store });
        const executor = new ManagedModelProviderExecutor({ client: new FixtureClient({ provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "fixture" }), promptRegistry: pipeline.promptRegistry, costGuard: store, telemetryObserver: observer });
        const session = await pipeline.createSession({ project_id: projectId, created_by_principal_id: "fixture-user", title: "B3", raw_idea_text: "Fixture idea", cost_budget: { max_tokens_per_request: 8000, max_cost_micro_usd_per_request: 2_000_000, session_token_budget: 80_000, session_cost_budget_micro_usd: 15_000_000 } });
        const sessionId = session.session.pipeline_session_id;
        const costId = session.costSession!.cost_session_id;
        const original = store.recordStageArtifact.bind(store);
        // Hold the real business transaction after commitAllowedLedger, before artifact storage.
        let entered = false;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        store.recordStageArtifact = async input => { entered = true; await gate; if (rollback) throw new Error("Fixture TX2 failure"); return original(input); };
        const running = pipeline.intakeAndExtractStage1({ project_id: projectId, pipeline_session_id: sessionId, actor_principal_id: "fixture-user", model_executor: executor, max_tokens: 100 });
        const outcome = running.then(() => "success", () => "failure");
        try {
          for (let n = 0; n < 600 && !entered; n++) await delay(5);
          assert(entered, "pipeline must reach TX2 artifact persistence");
          if (observer) await drained(observer);
          if (mode === "sql") {
            const before = await transport.reconcile(signal);
            const candidates = sql(`SELECT c.candidate_id FROM telemetry.ledger_candidates c JOIN telemetry.invocations i USING(project_id,invocation_id) WHERE i.cost_session_id='${costId}';`).split("\n");
            assert.equal(candidates.length, 1); assert(candidates[0]);
            assert.equal(before.find(row => row.candidateId === candidates[0])?.disposition, "pending");
            assert.equal(sql(`SELECT count(*) FROM public.model_call_ledgers WHERE cost_session_id='${costId}';`), "0");
          }
        } finally { release(); await outcome; store.recordStageArtifact = original; }
        assert.equal(await outcome, rollback ? "failure" : "success");
        if (observer) await drained(observer);
        const business = await pipeline.getCostSessionWithLedgers({ project_id: projectId, actor_principal_id: "fixture-user", cost_session_id: costId });
        assert(business); assert.equal(calls, 1); assert.equal(business.ledgers.length, 1);
        assert.equal(business.ledgers[0]!.status, rollback ? "FAILED_VALIDATION" : "ALLOWED");
        const artifacts = sql(`SELECT count(*) FROM public.stage_artifacts WHERE pipeline_session_id='${sessionId}';`);
        assert.equal(artifacts, rollback ? "0" : "1");
        const summary = { calls, artifacts, tokens: business.session.tokens_used_total, cost: business.session.cost_used_micro_usd, ledger: business.ledgers.map(row => ({ status: row.status, cost: row.actual_cost_micro_usd, input: row.actual_input_tokens, output: row.actual_output_tokens })) };
        assert.equal(summary.tokens, 3); assert.equal(summary.cost, business.ledgers[0]!.actual_cost_micro_usd);
        if (mode === "off") results.set(String(rollback), summary); else assert.deepEqual(summary, results.get(String(rollback)));
        if (mode === "sql") {
          await transport.reconcile(signal);
          assert.equal(sql(`SELECT count(*) FROM telemetry.settlements s JOIN telemetry.invocations i USING(project_id,invocation_id) WHERE i.cost_session_id='${costId}';`), "1");
          assert.equal(sql(`SELECT s.ledger_call_id FROM telemetry.settlements s JOIN telemetry.invocations i USING(project_id,invocation_id) WHERE i.cost_session_id='${costId}';`), business.ledgers[0]!.call_id);
          assert.equal(sql(`SELECT count(*) FROM telemetry.ledger_candidates c JOIN telemetry.invocations i USING(project_id,invocation_id) WHERE i.cost_session_id='${costId}';`), rollback ? "2" : "1");
          const again = await transport.reconcile(signal);
          const ownIds = sql(`SELECT c.candidate_id FROM telemetry.ledger_candidates c JOIN telemetry.invocations i USING(project_id,invocation_id) WHERE i.cost_session_id='${costId}';`).split("\n");
          assert.deepEqual(again.filter(row => ownIds.includes(row.candidateId)).map(row => row.disposition).sort(), rollback ? ["duplicate", "pending"] : ["duplicate"]);
          assert.equal(observer!.stats().failures, 0);
        }
        if (mode === "unavailable" || mode === "late") assert(observer!.stats().failures > 0);
        if (mode === "late") {
          assert.equal(sql(`SELECT count(*) FROM telemetry.invocations WHERE cost_session_id='${costId}';`), "0");
          assert.equal(sql(`SELECT count(*) FROM telemetry.settlements s JOIN telemetry.invocations i USING(project_id,invocation_id) WHERE i.cost_session_id='${costId}';`), "0");
        }
        observer?.stop();
      }
    }
    assert.equal(sql(`SELECT count(*) FROM telemetry.quality_events WHERE project_id='${projectId}';`), "0");
  } finally {
    observers.forEach(observer => observer.stop()); await runtime?.close();
    if (created) {
      execFileSync("dropdb", ["--maintenance-db", config.database, "--force", database], { env, timeout: 15000 });
      execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", config.database], { env, input: `DROP ROLE IF EXISTS ${role};`, stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
    }
  }
});
