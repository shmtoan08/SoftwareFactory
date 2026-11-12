import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { CoreApiService, CoreApiHttpServer, CORE_API_AUTH_HEADER, encodeCoreApiAuthHeader } from "@software-factory/core-api";
import { type ControlPlaneStore, SoftwareFactoryControlPlaneStore, PostgresControlPlaneRepository,
  PostgresRuntimePool, buildPostgresPoolConfigFromEnv, BudgetAutoPausedError, PostgresRlsError } from "@software-factory/database";
import { type TaskContractSpec, GlobIntersectionComplexityError, doTaskAllowedFilesIntersect } from "@software-factory/task-contract";
import { FactoryTelemetry, InMemoryTelemetryExporter, OtlpHttpJsonExporter, redactTelemetryAttributes, redactTelemetryMessage } from "@software-factory/observability";
import { sha256Hex, type CostSessionRecord } from "@software-factory/shared-types";

const scope = (projectId: string) => ({ currentProjectId: projectId, currentPrincipalId: "review-operator", currentRole: "core_api_service" as const });
async function fixture(store: ControlPlaneStore) {
  const projectId = randomUUID();
  await store.withRlsTransaction({ currentRole: "system_admin_role" }, async () => {
    await store.createProject({ project_id: projectId, slug: `fix-${projectId}`, name: "M6C fixes", repo_bare_path: "/nonexistent/review.git", initial_main_commit_hash: "1".repeat(40) });
    await store.addProjectMembership({ project_id: projectId, principal_id: "review-operator", member_role: "ORG_ADMIN" });
  });
  const core = new CoreApiService(store);
  const auth = core.issueAuthContext({ projectId, principalId: "review-operator", roles: ["ORG_ADMIN"] });
  const task = (contract: TaskContractSpec) => core.createTask(projectId, auth, { title: "Review regression", task_contract: contract });
  const session = () => store.withRlsTransaction(scope(projectId), () => store.createCostSession({ project_id: projectId,
    max_tokens_per_request: 100, max_cost_micro_usd_per_request: 100, session_token_budget: 1000, session_cost_budget_micro_usd: 1000 }));
  const call = (cs: CostSessionRecord) => ({ project_id: projectId, cost_session_id: cs.cost_session_id,
    provider: "openai" as const, model: "test", stage: "M6C_FIX_04", prompt_id: "review", prompt_version: "1",
    prompt_sha256: sha256Hex("review prompt"), request_sha256: sha256Hex(cs.cost_session_id),
    estimated_input_tokens: 2, reserved_output_tokens: 0, estimated_cost_micro_usd: 1 });
  return { store, core, auth, projectId, task, session, call };
}

async function directDispatchChecks(store: ControlPlaneStore) {
  const f = await fixture(store);
  const a = await f.task({ allowed_files: ["src/**"] });
  const b = await f.task({ allowed_files: ["src/auth/*.ts"] });
  const c = await f.task({ allowed_files: ["lib/**"] });
  const d = await f.task({ allowed_files: ["other/**"] });
  await f.core.updateProjectBudget(f.projectId, f.auth, { max_concurrent_tasks: 2 });
  await f.core.dispatchTaskLease(f.projectId, f.auth, { task_id: a.task_id, worker_id: "first" });
  const server = new CoreApiHttpServer({ coreApi: f.core });
  try {
    const { baseUrl } = await server.start();
    // The public route spreads body fields: clients must not turn the guard off.
    const overlap = await fetch(`${baseUrl}/api/v1/projects/${f.projectId}/tasks/${b.task_id}/dispatch`, {
      method: "POST", headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(f.auth), "content-type": "application/json" },
      body: JSON.stringify({ worker_id: "overlap", reject_overlapping_active_files: false }),
    });
    assert.equal(overlap.status, 422); assert.match(await overlap.text(), /overlap/);
    await f.core.dispatchTaskLease(f.projectId, f.auth, { task_id: c.task_id, worker_id: "disjoint" });
    await assert.rejects(f.core.dispatchTaskLease(f.projectId, f.auth, { task_id: d.task_id, worker_id: "over-cap" }),
      (error: unknown) => error instanceof PostgresRlsError && /concurrency limit/.test(error.message));
    const tasks = await f.core.listTasks(f.projectId, f.auth);
    assert.equal(tasks.filter((task) => task.status === "Leased").length, 2);
    assert.equal(tasks.find((task) => task.task_id === b.task_id)?.status, "Ready");
  } finally { await server.stop(); }
}

async function complexityChecks(store: ControlPlaneStore) {
  const f = await fixture(store);
  const active = await f.task({ allowed_files: ["src/**"], protected_paths: ["src/*a" + "?".repeat(12)] });
  await f.core.dispatchTaskLease(f.projectId, f.auth, { task_id: active.task_id, worker_id: "active" });
  const bad = await f.task({ allowed_files: ["src/" + "?".repeat(15) + "z"] });
  // Both stores sort Ready tasks by creation time. Ensure the healthy task comes
  // after the adversarial task so the test proves the batch keeps progressing.
  await new Promise((resolve) => setTimeout(resolve, 3));
  const good = await f.task({ allowed_files: ["healthy/**"] });
  const batch = await f.core.scheduleReadyTasks(f.projectId, f.auth, { worker_id: "batch" });
  assert.deepEqual(batch.leases.map((lease) => lease.task_id), [good.task_id]);
  assert.ok(batch.blocked.some((entry) => entry.task_id === bad.task_id && /ERR_GLOB_INTERSECTION_COMPLEXITY/.test(entry.reason)));
  assert.equal((await f.core.getTask(f.projectId, f.auth, bad.task_id))?.status, "Ready");
}

async function durableDenialChecks(repo: PostgresControlPlaneRepository, pool: PostgresRuntimePool) {
  const f = await fixture(repo); const cs = await f.session();
  await f.core.updateProjectBudget(f.projectId, f.auth, { max_project_tokens: 1 });
  // The autonomous NOWAIT probe necessarily conflicts with this outer row lock.
  // An exception rolls back the caller; all audit writes must still survive.
  await assert.rejects(repo.withRlsTransaction(scope(f.projectId), async () => {
    await pool.queryInActiveTx("SELECT 1 FROM project_budget_policies WHERE project_id = $1::uuid FOR UPDATE;", [f.projectId]);
    await repo.withRlsTransaction(scope(f.projectId), () => repo.preflightCheckCostSession(f.call(cs)));
  }), BudgetAutoPausedError);
  const snapshot = await f.core.getBudgetSnapshot(f.projectId, f.auth);
  assert.equal(snapshot.policy?.status, "AUTO_PAUSED");
  assert.equal(snapshot.events.filter((event) => event.event_type === "AUTO_PAUSED").length, 1);
  const ledgers = await repo.withRlsTransaction(scope(f.projectId), () => repo.listModelCallLedgers({ cost_session_id: cs.cost_session_id }));
  assert.equal(ledgers.length, 1); assert.equal(ledgers[0]?.status, "BLOCKED_PREFLIGHT");
  assert.equal(ledgers[0]?.request_sha256, f.call(cs).request_sha256);
  const outbox = await repo.withRlsTransaction(scope(f.projectId), () => repo.listOutboxEventsForProject());
  assert.equal(outbox.filter((event) => event.event_type === "budget.auto_paused").length, 1);
  await assert.rejects(f.core.dispatchTaskLease(f.projectId, f.auth, { task_id: (await f.task({ allowed_files: ["safe/**"] })).task_id, worker_id: "paused" }), BudgetAutoPausedError);
  await f.core.resumeBudget(f.projectId, f.auth, { reason: "reviewer approved", max_project_tokens: 10 });
  assert.equal((await f.core.getBudgetSnapshot(f.projectId, f.auth)).policy?.status, "ACTIVE");

  const fresh = await fixture(repo); const freshCs = await fresh.session();
  await assert.rejects(repo.withRlsTransaction(scope(fresh.projectId), async () => {
    await repo.upsertProjectBudgetPolicy({ project_id: fresh.projectId, max_project_tokens: 1 });
    await repo.preflightCheckCostSession(fresh.call(freshCs));
  }), BudgetAutoPausedError);
  const restored = await fresh.core.getBudgetSnapshot(fresh.projectId, fresh.auth);
  assert.equal(restored.policy?.status, "AUTO_PAUSED"); assert.equal(restored.policy?.max_project_tokens, 1);
  assert.equal(restored.events.filter((event) => event.event_type === "AUTO_PAUSED").length, 1);
  assert.equal((await repo.withRlsTransaction(scope(fresh.projectId), () => repo.listModelCallLedgers({ cost_session_id: freshCs.cost_session_id }))).length, 1);

  const transient = await fixture(repo);
  await transient.core.updateProjectBudget(transient.projectId, transient.auth, { max_project_tokens: 1 });
  let transientCs: CostSessionRecord | undefined;
  await assert.rejects(repo.withRlsTransaction(scope(transient.projectId), async () => {
    transientCs = await transient.session();
    await repo.preflightCheckCostSession(transient.call(transientCs));
  }), BudgetAutoPausedError);
  assert.ok(transientCs);
  assert.equal(await repo.withRlsTransaction(scope(transient.projectId), () => repo.getCostSession(transientCs!.cost_session_id)), null);
  const transientSnapshot = await transient.core.getBudgetSnapshot(transient.projectId, transient.auth);
  assert.equal(transientSnapshot.policy?.status, "AUTO_PAUSED");
  assert.equal(transientSnapshot.events.filter((event) => event.event_type === "AUTO_PAUSED").length, 1);

  const committed = await fixture(repo); const committedCs = await committed.session();
  await committed.core.updateProjectBudget(committed.projectId, committed.auth, { max_project_tokens: 1 });
  await repo.withRlsTransaction(scope(committed.projectId), async () => {
    await pool.queryInActiveTx("SELECT 1 FROM project_budget_policies WHERE project_id = $1::uuid FOR UPDATE;", [committed.projectId]);
    await assert.rejects(repo.preflightCheckCostSession(committed.call(committedCs)), BudgetAutoPausedError);
  });
  assert.equal((await committed.core.getBudgetSnapshot(committed.projectId, committed.auth)).policy?.status, "AUTO_PAUSED");
  assert.equal((await repo.withRlsTransaction(scope(committed.projectId), () => repo.listModelCallLedgers({ cost_session_id: committedCs.cost_session_id }))).length, 1);
  // Completion failures cannot masquerade as a durably audited denial.
  await assert.rejects(repo.withRlsTransaction(scope(committed.projectId), async () => {
    pool.afterTransactionEnd(async () => { throw new Error("injected audit failure"); });
    throw new Error("original denial");
  }), (error: unknown) => error instanceof AggregateError && error.errors.length === 2);
  assert.equal(pool.getActiveTxSession(), null);
  assert.deepEqual(await repo.listBudgetPauseEvents(), []);

  const taskBudget = await fixture(repo); const budgetTask = await taskBudget.task({ allowed_files: ["task/**"] });
  const taskCs = await repo.withRlsTransaction(scope(taskBudget.projectId), () => repo.createCostSession({
    project_id: taskBudget.projectId, task_id: budgetTask.task_id, max_tokens_per_request: 100,
    max_cost_micro_usd_per_request: 100, session_token_budget: 1000, session_cost_budget_micro_usd: 1000 }));
  await assert.rejects(repo.withRlsTransaction(scope(taskBudget.projectId), async () => {
    await repo.upsertTaskBudgetPolicy({ project_id: taskBudget.projectId, task_id: budgetTask.task_id, max_task_tokens: 1 });
    await repo.preflightCheckCostSession({ ...taskBudget.call(taskCs), task_id: budgetTask.task_id });
  }), BudgetAutoPausedError);
  const taskSnapshot = await taskBudget.core.getBudgetSnapshot(taskBudget.projectId, taskBudget.auth);
  assert.equal(taskSnapshot.task_policies[0]?.status, "AUTO_PAUSED");
  assert.equal(taskSnapshot.task_policies[0]?.max_task_tokens, 1);
  assert.equal(taskSnapshot.events.find((event) => event.event_type === "AUTO_PAUSED")?.task_id, budgetTask.task_id);
  assert.equal((await repo.withRlsTransaction(scope(taskBudget.projectId), () => repo.listModelCallLedgers({ cost_session_id: taskCs.cost_session_id }))).length, 1);

  const vanished = await fixture(repo); const vanishedCs = await vanished.session(); let vanishedTaskId = "";
  await vanished.core.updateProjectBudget(vanished.projectId, vanished.auth, { default_task_max_tokens: 1 });
  await assert.rejects(repo.withRlsTransaction(scope(vanished.projectId), async () => {
    const task = await vanished.task({ allowed_files: ["transient/**"] }); vanishedTaskId = task.task_id;
    await repo.preflightCheckCostSession({ ...vanished.call(vanishedCs), task_id: task.task_id });
  }), BudgetAutoPausedError);
  assert.equal(await vanished.core.getTask(vanished.projectId, vanished.auth, vanishedTaskId), null);
  const vanishedEvent = (await vanished.core.getBudgetSnapshot(vanished.projectId, vanished.auth)).events.find((event) => event.event_type === "AUTO_PAUSED");
  assert.ok(vanishedEvent); assert.equal(vanishedEvent.task_id, null); assert.match(vanishedEvent.reason, new RegExp(vanishedTaskId));

  // A different connection holding the policy row must get the same durable
  // result once that transaction releases its lock, not just self-contention.
  const config = buildPostgresPoolConfigFromEnv()!;
  const otherPool = new PostgresRuntimePool({ ...config, maxConnections: 1 });
  const external = await fixture(repo); const externalCs = await external.session();
  await external.core.updateProjectBudget(external.projectId, external.auth, { max_project_tokens: 1 });
  let entered!: () => void; let release!: () => void;
  const locked = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const holder = otherPool.withRlsTransaction(scope(external.projectId), async (conn) => {
    await conn.query("SELECT 1 FROM project_budget_policies WHERE project_id = $1::uuid FOR UPDATE;", [external.projectId]);
    entered(); await released;
  });
  try {
    await locked;
    await assert.rejects(repo.withRlsTransaction(scope(external.projectId), async () => {
      try { await repo.preflightCheckCostSession(external.call(externalCs)); }
      catch (error) { release(); await holder; throw error; }
    }), BudgetAutoPausedError);
    const externalSnapshot = await external.core.getBudgetSnapshot(external.projectId, external.auth);
    assert.equal(externalSnapshot.policy?.status, "AUTO_PAUSED");
    assert.equal(externalSnapshot.events.filter((event) => event.event_type === "AUTO_PAUSED").length, 1);
    assert.equal((await repo.withRlsTransaction(scope(external.projectId), () => repo.listModelCallLedgers({ cost_session_id: externalCs.cost_session_id }))).length, 1);
  } finally { release(); await holder; await otherPool.close(); }
}

describe("M6C review fixes 01..05", () => {
  it("FIX-01: public direct dispatch cannot bypass overlap or capacity (memory)", () => directDispatchChecks(new SoftwareFactoryControlPlaneStore()));
  it("FIX-02: a real glob state explosion blocks only its task (memory)", async () => {
    assert.throws(() => doTaskAllowedFilesIntersect({ allowed_files: ["src/**"], protected_paths: ["src/*a" + "?".repeat(12)] },
      { allowed_files: ["src/" + "?".repeat(15) + "z"] }), GlobIntersectionComplexityError);
    await complexityChecks(new SoftwareFactoryControlPlaneStore());
  });
  it("FIX-05: secret matrix is absent from in-memory spans and OTLP trace/metric exports", async () => {
    const keys = ["x-api-key", "api-key", "private-key", "session-id", "auth-header", "refresh_token", "Cookie"];
    const keyValues = Object.fromEntries(keys.map((key, i) => [key, `key-sensitive-${i}`]));
    assert.ok(Object.values(redactTelemetryAttributes(keyValues)).every((value) => value === "[REDACTED]"));
    const pem = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ") + "\nPEM-sensitive-value\n" + ["-----END", "RSA", "PRIVATE", "KEY-----"].join(" ");
    const databaseUrl = new URL("postgresql://example.test/db");
    databaseUrl.username = "db-user"; databaseUrl.password = "db-password";
    const samples = ["token=opaque-token-value", "access_token='opaque token with spaces'", 'cookie="session-cookie-value"',
      "Cookie: session=first-cookie-sensitive; preference=second-cookie-sensitive",
      "refresh-token: refresh-sensitive-value", "private-key=private-sensitive-value", "session-id=session-sensitive-value",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-sensitive", "Basic dXNlcjpzdXBlcnNlY3JldA==",
      "https://url-user:url-password@example.test/private", databaseUrl.toString(), pem];
    const secrets = [...Object.values(keyValues), "opaque-token-value", "opaque token with spaces", "session-cookie-value", "refresh-sensitive-value",
      "private-sensitive-value", "session-sensitive-value", "signature-sensitive", "dXNlcjpzdXBlcnNlY3JldA", "url-user", "url-password", "db-user", "db-password", "PEM-sensitive-value", "first-cookie-sensitive", "second-cookie-sensitive"];
    for (const sample of samples) assert.notEqual(redactTelemetryMessage(sample), sample);
    assert.equal(redactTelemetryMessage("ordinary failure on src/example.ts"), "ordinary failure on src/example.ts");
    const bodies: string[] = [];
    const collector = createServer((req, res) => { let body = ""; req.on("data", (chunk) => { body += String(chunk); }); req.on("end", () => { bodies.push(body); res.end("{}"); }); });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const address = collector.address(); assert.ok(address && typeof address !== "string");
    const memory = new InMemoryTelemetryExporter();
    const telemetry = new FactoryTelemetry({ exporters: [memory, new OtlpHttpJsonExporter({ baseUrl: `http://127.0.0.1:${address.port}` })] });
    try {
      await telemetry.withSpan("redaction-matrix", { attributes: keyValues }, (span) => {
        for (const [i, sample] of samples.entries()) {
          span.setAttribute(`message_${i}`, sample); span.addEvent("sample", { ...keyValues, detail: sample });
          span.recordException(new Error(sample)); telemetry.recordCounter("redaction.counter", 1, { ...keyValues, detail: sample });
          telemetry.recordHistogram("redaction.histogram", 1, { detail: sample });
        }
      });
      await telemetry.flush();
      assert.ok(bodies.some((body) => body.includes("resourceSpans"))); assert.ok(bodies.some((body) => body.includes("resourceMetrics")));
      const exported = JSON.stringify([memory.spans, memory.metrics, bodies]);
      for (const secret of secrets) assert.equal(exported.includes(secret), false, secret);
    } finally { await telemetry.shutdown(); await new Promise<void>((resolve) => collector.close(() => resolve())); }
  });
  it("FIX-01..04 PostgreSQL: guarded dispatch, batch isolation, transaction lock contract and durable rollback audit", async (t) => {
    const config = buildPostgresPoolConfigFromEnv(); if (!config) { t.skip("Configure real PostgreSQL to validate M6C review fixes"); return; }
    // One pooled connection proves completion does not wait for its own outer connection.
    const pool = new PostgresRuntimePool({ ...config, maxConnections: 1 }); const repo = new PostgresControlPlaneRepository(pool);
    try {
      await directDispatchChecks(repo); await complexityChecks(repo);
      const f = await fixture(repo); let called = false;
      await assert.rejects(repo.withProjectMergeQueueLock(f.projectId, async () => { called = true; }),
        (error: unknown) => error instanceof PostgresRlsError && /explicit tenant transaction/.test(error.message));
      assert.equal(called, false);
      await repo.withRlsTransaction(scope(f.projectId), () => repo.withProjectMergeQueueLock(f.projectId, async () => { called = true; }));
      assert.equal(called, true);
      await durableDenialChecks(repo, pool);
    } finally { await pool.close(); }
  });
});
