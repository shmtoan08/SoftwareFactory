import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { CoreApiService, CoreApiHttpServer, HttpCoreApiClient, CORE_API_AUTH_HEADER, encodeCoreApiAuthHeader } from "@software-factory/core-api";
import { type ControlPlaneStore, SoftwareFactoryControlPlaneStore, PostgresControlPlaneRepository, PostgresRuntimePool,
  buildPostgresPoolConfigFromEnv, BudgetAutoPausedError } from "@software-factory/database";
import { doGlobPatternsIntersect, doTaskAllowedFilesIntersect, globToRegExp, evaluatePathPolicyPrecedence, type TaskContractSpec } from "@software-factory/task-contract";
import { FactoryTelemetry, InMemoryTelemetryExporter, OtlpHttpJsonExporter, parseTraceparent } from "@software-factory/observability";
import { WebApprovalConsoleController } from "../../../apps/web/src/index.ts";
import { sha256Hex, type MergeCandidateRecord } from "@software-factory/shared-types";

const SHA = "1".repeat(40);
const scope = (projectId: string) => ({ currentProjectId: projectId, currentPrincipalId: "operator", currentRole: "core_api_service" as const });

async function fixture(store: ControlPlaneStore = new SoftwareFactoryControlPlaneStore(), repoPath = "/nonexistent/m6c.git", initialSha = SHA) {
  const projectId = randomUUID();
  await store.withRlsTransaction({ currentRole: "system_admin_role", currentPrincipalId: "bootstrap" }, async () => {
    await store.createProject({ project_id: projectId, slug: `m6c-${projectId}`, name: "M6C test",
      repo_bare_path: repoPath, initial_main_commit_hash: initialSha });
    await store.addProjectMembership({ project_id: projectId, principal_id: "operator", member_role: "ORG_ADMIN" });
    await store.addProjectMembership({ project_id: projectId, principal_id: "developer", member_role: "DEVELOPER" });
  });
  const exporter = new InMemoryTelemetryExporter();
  const telemetry = new FactoryTelemetry({ exporters: [exporter] });
  const core = new CoreApiService(store, { telemetry });
  const auth = core.issueAuthContext({ projectId, principalId: "operator", roles: ["ORG_ADMIN"] });
  const dev = core.issueAuthContext({ projectId, principalId: "developer", roles: ["DEVELOPER"] });
  const task = (path = "src/a.ts", dependencies?: readonly string[]) => core.createTask(projectId, auth, {
    title: path, task_contract: { allowed_files: [path] }, depends_on_task_ids: dependencies });
  return { store, core, auth, dev, projectId, task, exporter, telemetry };
}

async function schedulerChecks(store: ControlPlaneStore) {
  const f = await fixture(store);
  const a = await f.task("src/**/*.ts");
  const b = await f.task("src/auth/*.ts");
  const c = await f.task("lib/*.ts");
  const d = await f.task("other/*.ts", [a.task_id]);
  const deps = await f.core.listTaskDependencies(f.projectId, f.auth);
  assert.equal(deps.length, 1);
  await assert.rejects(f.core.addTaskDependency(f.projectId, f.auth, { task_id: a.task_id, depends_on_task_id: d.task_id }));
  const other = await fixture(store);
  const foreign = await other.task();
  await assert.rejects(f.core.addTaskDependency(f.projectId, f.auth, { task_id: a.task_id, depends_on_task_id: foreign.task_id }));
  await f.core.updateProjectBudget(f.projectId, f.auth, { max_concurrent_tasks: 2 });
  const dispatched = await Promise.all(Array.from({ length: 8 }, () => f.core.scheduleReadyTasks(f.projectId, f.auth, { worker_id: "parallel-worker" })));
  assert.equal(dispatched.reduce((sum, batch) => sum + batch.leases.length, 0), 2);
  const active = (await f.core.listTasks(f.projectId, f.auth)).filter((task) => task.status === "Leased");
  assert.equal(active.length, 2);
  assert.ok(active.some((task) => task.task_id === c.task_id));
  assert.equal(active.some((task) => task.task_id === d.task_id), false);
  assert.equal(active.filter((task) => [a.task_id, b.task_id].includes(task.task_id)).length, 1);
  assert.equal((await other.core.scheduleReadyTasks(other.projectId, other.auth, { worker_id: "other-worker" })).leases.length, 1);
  await assert.rejects(f.core.getBudgetSnapshot(f.projectId, other.auth));
}

async function budgetChecks(store: ControlPlaneStore) {
  const f = await fixture(store);
  const task = await f.task();
  await assert.rejects(f.core.updateProjectBudget(f.projectId, f.dev, { max_project_tokens: 100 }));
  await f.core.updateProjectBudget(f.projectId, f.auth, { max_project_tokens: 100, default_task_max_tokens: 80 });
  const session = await store.withRlsTransaction(scope(f.projectId), () => store.createCostSession({
    project_id: f.projectId, task_id: task.task_id, max_tokens_per_request: 1000, max_cost_micro_usd_per_request: 1000,
    session_token_budget: 10000, session_cost_budget_micro_usd: 10000,
  }));
  const call = { project_id: f.projectId, task_id: task.task_id, cost_session_id: session.cost_session_id,
    stage: "M6C_TEST", provider: "openai" as const, model: "test-model", prompt_id: "m6c.test", prompt_version: "1.0.0",
    prompt_sha256: sha256Hex("prompt"), request_sha256: sha256Hex("request"), estimated_input_tokens: 90,
    reserved_output_tokens: 0, estimated_cost_micro_usd: 1 };
  // Projected spend must persist AUTO_PAUSED + blocked audit even though the caller rolls back.
  await assert.rejects(store.withRlsTransaction(scope(f.projectId), () => store.preflightCheckCostSession(call)), BudgetAutoPausedError);
  const blockedLedgers = await store.withRlsTransaction(scope(f.projectId), () => store.listModelCallLedgers({ cost_session_id: session.cost_session_id }));
  assert.equal(blockedLedgers.filter((ledger) => ledger.status === "BLOCKED_PREFLIGHT").length, 1);
  let snap = await f.core.getBudgetSnapshot(f.projectId, f.auth);
  assert.equal(snap.task_policies[0]?.status, "AUTO_PAUSED");
  assert.equal(snap.events.filter((event) => event.event_type === "AUTO_PAUSED").length, 1);
  await assert.rejects(f.core.resumeTaskBudget(f.projectId, f.dev, { task_id: task.task_id, reason: "unauthorized", max_task_tokens: 200 }));
  await f.core.resumeTaskBudget(f.projectId, f.auth, { task_id: task.task_id, reason: "raise task ceiling", max_task_tokens: 200 });
  await store.withRlsTransaction(scope(f.projectId), () => store.finalizeModelCallLedger({ ...call,
    actual_input_tokens: 100, actual_output_tokens: 0, actual_cost_micro_usd: 20, outcome: "ALLOWED", latency_ms: 1 }));
  snap = await f.core.getBudgetSnapshot(f.projectId, f.auth);
  assert.equal(snap.policy?.status, "AUTO_PAUSED");
  assert.equal(snap.usage.tokens_used, 100);
  assert.equal((await f.core.scheduleReadyTasks(f.projectId, f.auth, { worker_id: "budget-worker" })).leases.length, 0);
  await assert.rejects(f.core.resumeBudget(f.projectId, f.auth, { reason: "still at cap", max_project_tokens: 100 }));
  await assert.rejects(f.core.resumeBudget(f.projectId, f.auth, { reason: "remove cap", max_project_tokens: null }));
  await f.core.resumeBudget(f.projectId, f.auth, { reason: "approved increase", max_project_tokens: 200 });
  assert.equal((await f.core.scheduleReadyTasks(f.projectId, f.auth, { worker_id: "budget-worker" })).leases.length, 1);
  await f.core.updateProjectBudget(f.projectId, f.auth, { max_project_wall_time_ms: 50 });
  await f.core.recordResourceUsageMetric(f.projectId, f.auth, { task_id: task.task_id, lease_epoch: 1,
    phase: "DEVELOPER", wall_time_ms: 50, cpu_usage_usec: 0, peak_memory_bytes: 0,
    sandbox_backend_mode: "test", metrics_source: "wall-clock-only" });
  assert.equal((await f.core.getBudgetSnapshot(f.projectId, f.auth)).policy?.pause_scope, "PROJECT_WALL_TIME");
}

async function concurrentSpendChecks(store: ControlPlaneStore) {
  const f = await fixture(store);
  const tasks = await Promise.all([f.task("src/a.ts"), f.task("src/b.ts")]);
  await f.core.updateProjectBudget(f.projectId, f.auth, { max_project_wall_time_ms: 100, max_project_tokens: 100 });
  const sessions = [];
  for (const task of tasks) sessions.push(await store.withRlsTransaction(scope(f.projectId), () => store.createCostSession({
    project_id: f.projectId, task_id: task.task_id, max_tokens_per_request: 1000, max_cost_micro_usd_per_request: 1000,
    session_token_budget: 10000, session_cost_budget_micro_usd: 10000 })));
  await Promise.all(sessions.map((session) => store.withRlsTransaction(scope(f.projectId), () => store.finalizeModelCallLedger({
    project_id: f.projectId, cost_session_id: session.cost_session_id,
    stage: "M6C_CONCURRENT", provider: "openai", model: "test", prompt_id: "test", prompt_version: "1",
    prompt_sha256: sha256Hex("prompt"), request_sha256: sha256Hex(session.cost_session_id),
    estimated_input_tokens: 50, reserved_output_tokens: 0, actual_input_tokens: 50, actual_output_tokens: 0,
    estimated_cost_micro_usd: 1, actual_cost_micro_usd: 1, outcome: "ALLOWED", latency_ms: 1,
  }))));
  let snapshot = await f.core.getBudgetSnapshot(f.projectId, f.auth);
  assert.equal(snapshot.usage.tokens_used, 100); assert.equal(snapshot.policy?.status, "AUTO_PAUSED");
  await f.core.resumeBudget(f.projectId, f.auth, { reason: "raise token cap", max_project_tokens: 200 });
  await Promise.all(tasks.map((task) => f.core.recordResourceUsageMetric(f.projectId, f.auth, {
    task_id: task.task_id, lease_epoch: 0, phase: "DEVELOPER", wall_time_ms: 50,
    cpu_usage_usec: 0, peak_memory_bytes: 0, sandbox_backend_mode: "test", metrics_source: "wall-clock-only" })));
  snapshot = await f.core.getBudgetSnapshot(f.projectId, f.auth);
  assert.equal(snapshot.usage.wall_time_ms, 100); assert.equal(snapshot.policy?.pause_scope, "PROJECT_WALL_TIME");
  assert.equal(snapshot.events.filter((event) => event.event_type === "AUTO_PAUSED" && event.pause_scope === "PROJECT_WALL_TIME").length, 1);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "M6C", GIT_AUTHOR_EMAIL: "m6c@example.test", GIT_COMMITTER_NAME: "M6C", GIT_COMMITTER_EMAIL: "m6c@example.test" } }).trim();
}

async function queueChecks(store: ControlPlaneStore) {
  const root = mkdtempSync(join(tmpdir(), "sf-m6c-queue-"));
  try {
    git(root, ["init", "-b", "main"]);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/base.ts"), "export const base = 1;\n");
    git(root, ["add", "."]); git(root, ["commit", "-m", "baseline"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    // Use a bare repo for the control-plane CAS target, with a separate authoring worktree.
    const bare = join(root, "target.git");
    git(root, ["clone", "--bare", root, bare]);
    const f = await fixture(store, bare, base);
    const prepare = async (name: string) => {
      git(root, ["checkout", "--detach", base]);
      writeFileSync(join(root, "src", `${name}.ts`), `export const ${name} = 1;\n`);
      git(root, ["add", `src/${name}.ts`]); git(root, ["commit", "-m", name]);
      const agent = git(root, ["rev-parse", "HEAD"]);
      const task = await f.task(`src/${name}.ts`);
      const lease = await f.core.dispatchTaskLease(f.projectId, f.auth, { task_id: task.task_id, worker_id: "queue-worker" });
      const ref = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
      git(root, ["push", bare, `${agent}:${ref}`]);
      const result = await f.core.buildMergeCandidateFromGit(f.projectId, f.auth, {
        task_id: task.task_id, lease_id: lease.lease_id, lease_epoch: lease.lease_epoch,
        staging_ref: ref, agent_commit_hash: agent, repo_path: bare,
      });
      if (!result.ok) throw new Error(result.conflictSummary);
      return result.mergeCandidate;
    };
    const approve = async (candidate: MergeCandidateRecord) => {
      // Queue tests focus on Git/DB crash consistency; existing M3/M4 gates exercise real verifier/reviewer execution.
      const evidence = await f.core.recordVerificationAndIndependentReview(f.projectId, f.auth, {
        task_id: candidate.task_id, merge_candidate_id: candidate.merge_candidate_id,
        merge_candidate_hash: candidate.merge_candidate_hash, verified_tree_hash: candidate.verified_tree_hash,
        verifier_image_digest: "sha256:test", verification_verdict: "PASS", exit_code: 0, duration_ms: 1,
        report_sha256: sha256Hex(candidate.merge_candidate_id), writer_provider: "openai", writer_model: "writer",
        reviewer_provider: "google", reviewer_model: "reviewer", developer_principal_id: "coder", reviewer_principal_id: "reviewer",
        developer_session_id: "coder-session", reviewer_session_id: "reviewer-session", review_verdict: "PASS",
      });
      const approval = await new WebApprovalConsoleController(f.core).approveCandidateWith8FieldBinding({
        auth: f.auth, candidate, ...evidence });
      return f.core.enqueueMerge(f.projectId, f.auth, { task_id: candidate.task_id,
        merge_candidate_id: candidate.merge_candidate_id, approval_id: approval.approval_id });
    };
    const a = await prepare("alpha");
    const b = await prepare("beta");
    const qa = await approve(a); const qb = await approve(b);
    assert.ok(qa.queue_position < qb.queue_position);
    await assert.rejects(f.core.enqueueMerge(f.projectId, f.auth, { task_id: a.task_id, merge_candidate_id: a.merge_candidate_id, approval_id: qa.approval_id }));
    await assert.rejects(f.core.drainMergeQueue(f.projectId, f.auth, { require_real_git: true, simulateCrashAfterGitUpdateRef: true }));
    assert.equal(git(bare, ["rev-parse", "refs/heads/main"]), a.merge_candidate_hash);
    assert.equal((await f.core.listMergeQueue(f.projectId, f.auth))[0]?.status, "QUEUED");
    const recovered = await f.core.drainMergeQueue(f.projectId, f.auth, { require_real_git: true });
    assert.equal(recovered?.status, "MERGED");
    const rebased = await f.core.drainMergeQueue(f.projectId, f.auth, { require_real_git: true });
    assert.equal(rebased?.status, "REBASED_NEEDS_REVERIFY");
    assert.equal((await f.core.getTask(f.projectId, f.auth, b.task_id))?.status, "VerifyingInDocker");
    assert.equal(git(bare, ["rev-parse", "refs/heads/main"]), a.merge_candidate_hash);
    const newCandidate = await store.withRlsTransaction(scope(f.projectId), () => store.getMergeCandidateById(rebased!.rebased_to_candidate_id!));
    assert.ok(newCandidate);
    await assert.rejects(f.core.enqueueMerge(f.projectId, f.auth, { task_id: b.task_id, merge_candidate_id: b.merge_candidate_id, approval_id: qb.approval_id }));
    await approve(newCandidate);
    const drains = await Promise.all([f.core.drainMergeQueue(f.projectId, f.auth, { require_real_git: true }),
      f.core.drainMergeQueue(f.projectId, f.auth, { require_real_git: true })]);
    assert.equal(drains.filter((entry) => entry?.status === "MERGED").length, 1);
    assert.equal(git(bare, ["rev-parse", "refs/heads/main"]), newCandidate.merge_candidate_hash);
    assert.equal(git(bare, ["show", "main:src/alpha.ts"]), "export const alpha = 1;");
    assert.equal(git(bare, ["show", "main:src/beta.ts"]), "export const beta = 1;");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("M6C-1 parallel core, CAS queue, budget and telemetry", () => {
  it("glob intersection detects wildcard collisions and honors protected paths", () => {
    for (const [a, b] of [["src/**/*.ts", "src/auth/*.ts"], ["*.mjs", "**/*.mjs"], ["a?c/*", "a*c/x"]]) {
      const overlap = doGlobPatternsIntersect(a!, b!); assert.equal(overlap.intersects, true); assert.ok(overlap.witnessPath);
    }
    assert.equal(doGlobPatternsIntersect("src/*.ts", "lib/*.ts").intersects, false);
    const contract: TaskContractSpec = { allowed_files: ["src/**"], protected_paths: ["src/auth/**"] };
    assert.equal(doTaskAllowedFilesIntersect(contract, { allowed_files: ["src/auth/**"] }).intersects, false);
    const alternate = doTaskAllowedFilesIntersect({ allowed_files: ["src/*"], protected_paths: ["src/?"] }, { allowed_files: ["src/*"] });
    assert.equal(alternate.intersects, true);
    assert.ok(alternate.details[0]!.witnessPath.split("/")[1]!.length >= 2);
    assert.equal(doTaskAllowedFilesIntersect({ allowed_files: ["src/*.KEY"] }, { allowed_files: ["src/*"] }).intersects, false);
    const patterns = ["*", "**", "?", "a*", "**/a?", "a/*", "a/**", "a?/*", "**/*.ts", "*.ts"];
    const paths = ["a", "b", "aa", "ab", "a/a", "a/b", "a/aa", "aa/a", "a/a.ts", "b.ts", "a/b/c.ts"];
    for (const a of patterns) for (const b of patterns) {
      const overlap = doGlobPatternsIntersect(a, b);
      if (paths.some((path) => globToRegExp(a).test(path) && globToRegExp(b).test(path))) assert.equal(overlap.intersects, true, `${a} vs ${b}`);
      if (overlap.witnessPath) assert.ok(globToRegExp(a).test(overlap.witnessPath) && globToRegExp(b).test(overlap.witnessPath));
      const policyA = { allowed_files: [a], protected_paths: ["?", "a/?"] };
      const policyB = { allowed_files: [b], forbidden_paths: ["**/*.KEY"] };
      const contractOverlap = doTaskAllowedFilesIntersect(policyA, policyB);
      if (paths.some((path) => evaluatePathPolicyPrecedence(path, policyA).allowed && evaluatePathPolicyPrecedence(path, policyB).allowed)) assert.equal(contractOverlap.intersects, true, `excluded ${a} vs ${b}`);
    }
    // A blocked first witness must not hide another permitted intersection.
    assert.equal(doTaskAllowedFilesIntersect({ allowed_files: ["src/*"], forbidden_paths: ["src/a"] }, { allowed_files: ["src/*"] }).intersects, true);
  });
  it("concurrent scheduling prevents overlaps, obeys DAG/capacity and isolates projects", () => schedulerChecks(new SoftwareFactoryControlPlaneStore()));
  it("AC-12c projected and actual spend persist pause; only authorized raised ceilings resume", () => budgetChecks(new SoftwareFactoryControlPlaneStore()));
  it("concurrent model calls and resource metrics enforce the aggregate project ceiling", () => concurrentSpendChecks(new SoftwareFactoryControlPlaneStore()));
  it("real Git FIFO queue recovers post-merge crash and re-verifies rebased candidates", () => queueChecks(new SoftwareFactoryControlPlaneStore()));
  it("HTTP RBAC, tenant binding and trace propagation expose M6C controls", async () => {
    const f = await fixture(); const server = new CoreApiHttpServer({ coreApi: f.core });
    try {
      const { baseUrl } = await server.start();
      const trace = "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01";
      const url = `${baseUrl}/api/v1/projects/${f.projectId}/budget`;
      const headers = { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(f.auth), "content-type": "application/json", traceparent: trace };
      const denied = await fetch(url, { method: "POST", headers: { ...headers, [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(f.dev) }, body: JSON.stringify({ max_project_tokens: 100 }) });
      assert.equal(denied.status, 403);
      const response = await fetch(url, { method: "POST", headers,
        body: JSON.stringify({ max_project_tokens: 100, project_id: randomUUID(), actor_principal_id: "forged" }) });
      assert.equal(response.status, 200);
      assert.equal(parseTraceparent(response.headers.get("traceparent"))?.traceId, "a".repeat(32));
      const policy = await response.json() as { project_id: string }; assert.equal(policy.project_id, f.projectId);
      assert.equal((await fetch(url, { headers })).status, 200);
      const span = f.exporter.getSpansByName("budget.update")[0]!;
      assert.equal(span.traceId, "a".repeat(32)); assert.ok(span.parentSpanId);
      const clientTelemetry = new FactoryTelemetry({ exporters: [f.exporter] });
      const client = new HttpCoreApiClient(baseUrl, clientTelemetry);
      await clientTelemetry.withSpan("operator.workflow", () => client.getBudgetSnapshot(f.projectId, f.auth));
      const caller = f.exporter.getSpansByName("http.client.request")[0]!;
      assert.ok(f.exporter.getSpansByName("http.server.request").some((serverSpan) => serverSpan.parentSpanId === caller.spanId));
      const task = await f.task();
      const dispatch = await fetch(`${baseUrl}/api/v1/projects/${f.projectId}/scheduler/dispatch`, {
        method: "POST", headers, body: JSON.stringify({ worker_id: "http-worker", max_tasks: 1 }) });
      assert.equal(dispatch.status, 200);
      assert.equal((await dispatch.json() as { leases: { task_id: string }[] }).leases[0]?.task_id, task.task_id);
    } finally { await server.stop(); }
  });
  it("OTLP exports secret-redacted trace hierarchy and metrics without blocking on exporter failure", async () => {
    const payloads: Record<string, unknown>[] = [];
    const collector = createServer((req, res) => { let body = ""; req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => { payloads.push(JSON.parse(body)); res.end("{}"); }); });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const address = collector.address(); assert.ok(address && typeof address !== "string");
    const exporter = new InMemoryTelemetryExporter();
    const telemetry = new FactoryTelemetry({ exporters: [exporter, new OtlpHttpJsonExporter({ baseUrl: `http://127.0.0.1:${address.port}` }),
      { exportSpans() { throw new Error("collector unavailable"); } }] });
    try {
      await telemetry.withSpan("parent", async (span) => {
        span.setAttribute("api_key", "private-value");
        span.setAttribute("message", "Bearer abcdefghijklmnop");
        await telemetry.withSpan("child", () => telemetry.recordCounter("scheduler.dispatched"));
        telemetry.recordHistogram("scheduler.duration", 12);
      });
      await telemetry.flush();
      const parent = exporter.getSpansByName("parent")[0]!; const child = exporter.getSpansByName("child")[0]!;
      assert.equal(child.parentSpanId, parent.spanId); assert.equal(child.traceId, parent.traceId);
      assert.equal(parent.attributes.api_key, "[REDACTED]");
      assert.equal(parent.attributes.message, "[REDACTED]");
      assert.ok(payloads.some((body) => body.resourceSpans)); assert.ok(payloads.some((body) => body.resourceMetrics));
      assert.match(JSON.stringify(payloads), /"histogram":/);
      assert.equal(parseTraceparent("00-" + "A".repeat(32) + "-" + "b".repeat(16) + "-01"), null);
      assert.equal(JSON.stringify(payloads).includes("private-value"), false);
    } finally { await telemetry.shutdown(); await new Promise<void>((resolve) => collector.close(() => resolve())); }
  });
  it("PostgreSQL 0009: real concurrent scheduler, durable budgets, Git queue, FORCE RLS and append-only audit", async (t) => {
    const config = buildPostgresPoolConfigFromEnv();
    if (!config) { t.skip("Set PGHOST/DATABASE_URL to run real PostgreSQL M6C gates"); return; }
    const pool = new PostgresRuntimePool(config); const repo = new PostgresControlPlaneRepository(pool);
    try {
      await schedulerChecks(repo); await budgetChecks(repo); await concurrentSpendChecks(repo); await queueChecks(repo);
      const f = await fixture(repo);
      const x = await f.task("x/*.ts"); const y = await f.task("y/*.ts");
      const edges = await Promise.allSettled([
        f.core.addTaskDependency(f.projectId, f.auth, { task_id: x.task_id, depends_on_task_id: y.task_id }),
        f.core.addTaskDependency(f.projectId, f.auth, { task_id: y.task_id, depends_on_task_id: x.task_id }),
      ]);
      assert.equal(edges.filter((edge) => edge.status === "fulfilled").length, 1);
      const persisted = await f.core.listTaskDependencies(f.projectId, f.auth);
      assert.equal(persisted.length, 1);
      await assert.rejects(repo.withRlsTransaction(scope(f.projectId), () => pool.queryInActiveTx(
        "UPDATE tasks SET status = 'Leased' WHERE task_id = $1::uuid;", [persisted[0]!.task_id])));
      const blockedSession = await repo.withRlsTransaction(scope(f.projectId), () => repo.createCostSession({
        project_id: f.projectId, max_tokens_per_request: 100, max_cost_micro_usd_per_request: 100,
        session_token_budget: 1000, session_cost_budget_micro_usd: 1000 }));
      // A policy created in an outer transaction is invisible to autonomous TXs.
      // Denial must fall back without waiting on that transaction's own unique-index/FK locks.
      await assert.rejects(repo.withRlsTransaction(scope(f.projectId), async () => {
        await repo.upsertProjectBudgetPolicy({ project_id: f.projectId, max_project_tokens: 1 });
        await repo.preflightCheckCostSession({ project_id: f.projectId, cost_session_id: blockedSession.cost_session_id,
          provider: "openai", model: "test", stage: "M6C_LOCK_TEST", prompt_id: "test", prompt_version: "1",
          prompt_sha256: sha256Hex("prompt"), request_sha256: sha256Hex("request"), estimated_input_tokens: 2,
          reserved_output_tokens: 0, estimated_cost_micro_usd: 1 });
      }), BudgetAutoPausedError);
      assert.equal((await f.core.getBudgetSnapshot(f.projectId, f.auth)).policy, null);
      await repo.withRlsTransaction(scope(f.projectId), async () => {
        const rows = await pool.queryInActiveTx("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('task_dependencies', 'merge_queue_entries', 'project_budget_policies', 'task_budget_policies', 'budget_pause_events');");
        assert.equal(rows.rows.length, 5); assert.ok(rows.rows.every((row) => row.relforcerowsecurity));
      });
      await assert.rejects(repo.withRlsTransaction(scope(f.projectId), () => pool.queryInActiveTx("DELETE FROM budget_pause_events;")));
      await assert.rejects(repo.withRlsTransaction(scope(f.projectId), () => pool.queryInActiveTx("UPDATE budget_pause_events SET reason = 'tampered';")));
      assert.deepEqual(await repo.listProjectTaskDependencies(), []);
      assert.deepEqual(await repo.listMergeQueueEntries(), []);
    } finally { await pool.close(); }
  });
});
