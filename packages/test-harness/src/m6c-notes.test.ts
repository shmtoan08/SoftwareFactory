import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { CoreApiService } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore, PostgresControlPlaneRepository, PostgresRuntimePool, buildPostgresPoolConfigFromEnv, BudgetAutoPausedError, type ControlPlaneStore } from "@software-factory/database";
import { canonicalizeJson, sha256Hex } from "@software-factory/shared-types";
import { WebApprovalConsoleController } from "../../../apps/web/src/index.ts";
import { CodexCliAdapter, loadAgentRuntimeAdapterFromEnv, type AgentTaskContext } from "@software-factory/adapter-sdk";
import { compileAcceptanceAssertions } from "../../product-pipeline/src/acceptance-assertions.ts";
import { acquireBootstrapLock } from "../../product-pipeline/src/bootstrap-lock.ts";
import { pruneStalePendingBootstrapRefs } from "@software-factory/product-pipeline";

const SHA = "1".repeat(40);
const scope = (projectId: string) => ({ currentProjectId: projectId, currentPrincipalId: "notes", currentRole: "core_api_service" as const });
async function fixture(store: ControlPlaneStore) {
  const projectId = randomUUID();
  await store.withRlsTransaction({ currentRole: "system_admin_role" }, async () => {
    await store.createProject({ project_id: projectId, slug: `notes-${projectId}`, name: "Notes", repo_bare_path: "/nonexistent/notes.git", initial_main_commit_hash: SHA });
    await store.addProjectMembership({ project_id: projectId, principal_id: "notes", member_role: "ORG_ADMIN" });
  });
  const core = new CoreApiService(store); const auth = core.issueAuthContext({ projectId, principalId: "notes", roles: ["ORG_ADMIN"] });
  return { store, core, auth, projectId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function candidate(f: Fixture, path: string) {
  const contract = { allowed_files: [path] }; const agent = sha256Hex(path).slice(0, 40); const tree = sha256Hex(`tree:${path}`).slice(0, 40);
  const task = await f.core.createTask(f.projectId, f.auth, { title: path, task_contract: contract });
  const lease = await f.core.dispatchTaskLease(f.projectId, f.auth, { task_id: task.task_id, worker_id: "notes" });
  const built = await f.core.importAndBuildCandidate(f.projectId, f.auth, { task_id: task.task_id, lease_id: lease.lease_id, lease_epoch: lease.lease_epoch,
    staging_ref: `refs/factory/Verify/${task.task_id}/1`, base_main_commit_hash: SHA, merge_candidate_hash: sha256Hex(`merge:${path}`).slice(0, 40),
    candidate_input: { contract, agent_commit_hash: agent, verified_tree_hash: tree, expected_base_main_commit_hash: SHA, parent_commit_hashes: [SHA],
      changes: [{ path, mode: "100644", size_bytes: 1, is_binary: false, added_lines: 1, deleted_lines: 0, blob_sha: sha256Hex("blob").slice(0, 40) }] } });
  const evidence = await f.core.recordVerificationAndIndependentReview(f.projectId, f.auth, { task_id: task.task_id,
    merge_candidate_id: built.mergeCandidate.merge_candidate_id, merge_candidate_hash: built.mergeCandidate.merge_candidate_hash, verified_tree_hash: tree,
    verifier_image_digest: "sha256:test", verification_verdict: "PASS", exit_code: 0, duration_ms: 1, report_sha256: sha256Hex("report"),
    writer_provider: "openai", writer_model: "writer", reviewer_provider: "google", reviewer_model: "reviewer",
    developer_principal_id: "coder", reviewer_principal_id: "reviewer", developer_session_id: "coder-session", reviewer_session_id: "reviewer-session", review_verdict: "PASS" });
  const approval = await new WebApprovalConsoleController(f.core).approveCandidateWith8FieldBinding({ auth: f.auth, candidate: built.mergeCandidate, ...evidence });
  return { task, candidate: built.mergeCandidate, approval };
}
async function parityChecks(store: ControlPlaneStore) {
  const f = await fixture(store); const a = await candidate(f, "src/a.ts"); const b = await candidate(f, "src/b.ts");
  for (const item of [a, b]) await f.core.enqueueMerge(f.projectId, f.auth, { task_id: item.task.task_id, merge_candidate_id: item.candidate.merge_candidate_id, approval_id: item.approval.approval_id });
  await assert.rejects(f.core.executeCasMerge(f.projectId, f.auth, { task_id: b.task.task_id, merge_candidate_id: b.candidate.merge_candidate_id, approval_id: b.approval.approval_id }), /FIFO/);
  const original = store.completeMergeQueueEntry.bind(store);
  store.completeMergeQueueEntry = (input) => original({ ...input, merged_commit_hash: input.merged_commit_hash?.toUpperCase() });
  try {
    assert.equal((await f.core.executeCasMerge(f.projectId, f.auth, { task_id: a.task.task_id, merge_candidate_id: a.candidate.merge_candidate_id, approval_id: a.approval.approval_id })).status, "MERGED_BY_CAS");
    assert.equal((await f.core.listMergeQueue(f.projectId, f.auth))[0]!.merged_commit_hash, a.candidate.merge_candidate_hash);
  } finally { store.completeMergeQueueEntry = original; }
  const budget = await fixture(store);
  const task = await budget.core.createTask(budget.projectId, budget.auth, { title: "budget", task_contract: { allowed_files: ["src/**"] } });
  await budget.core.updateProjectBudget(budget.projectId, budget.auth, { max_project_wall_time_ms: 1, default_task_max_wall_time_ms: 1 });
  await budget.core.recordResourceUsageMetric(budget.projectId, budget.auth, { task_id: task.task_id, lease_epoch: 0, phase: "DEVELOPER", wall_time_ms: 1, cpu_usage_usec: 0, peak_memory_bytes: 0, sandbox_backend_mode: "test", metrics_source: "wall-clock-only" });
  const snap = await budget.core.getBudgetSnapshot(budget.projectId, budget.auth);
  assert.equal(snap.policy?.status, "AUTO_PAUSED"); assert.equal(snap.task_policies[0]?.status, "AUTO_PAUSED");
  assert.equal(snap.events.filter((e) => e.event_type === "AUTO_PAUSED").length, 2);
  assert.deepEqual(snap.events.map((e) => e.event_id), [...snap.events].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.event_id.localeCompare(a.event_id)).map((e) => e.event_id));
}

describe("M6C remaining review notes", () => {
  it("AST assertions invoke only declared exports, immutable bindings and safe expressions", () => {
    const valid = compileAcceptanceAssertions("AC", ['const entry = mod.createEntry(3, "USD");', 'assert.equal(entry.amount, 3);', 'assert.equal(Array.isArray(mod.implementedAcIds) && mod.implementedAcIds.includes("AC"), true);'], "createEntry");
    assert.equal(valid.length, 3);
    for (const line of ['const entry = mod.deleteEverything();', 'const entry = mod.createEntry.constructor("return process")();', 'const assert = mod.createEntry();', 'assert.equal((mod.value = 1), 1);', 'const x = (() => 1)();', 'assert.equal(mod["constructor"], 1);', 'assert.equal(1,1); process.exit(1)']) assert.throws(() => compileAcceptanceAssertions("AC", [line], "createEntry"));
  });
  it("Codex production cannot run; parse redacts transformed/clipped credentials and respects provider selection", async () => {
    const ctx: AgentTaskContext = { projectId: randomUUID(), taskId: randomUUID(), leaseId: randomUUID(), leaseEpoch: 1, worktreePath: "/nonexistent", baseMainCommitHash: SHA, taskTitle: "notes", taskContract: { allowed_files: ["**"] } };
    assert.throws(() => loadAgentRuntimeAdapterFromEnv({ SF_AGENT_RUNTIME: "codex-cli", SF_AGENT_MODEL: "test" }), /ERR_UNMETERED_CODEX_DISABLED/);
    await assert.rejects(new CodexCliAdapter({ writerModel: "test", binaryPath: "codex", apiKey: "live-key-disallowed" }).prepareInvocation(ctx), /ERR_UNMETERED_CODEX_DISABLED/);
    await assert.rejects(new CodexCliAdapter({ writerModel: "test", binaryPath: "codex", apiKey: "live-key-disallowed", testOnlyEmulator: true }).prepareInvocation(ctx), /ERR_UNMETERED_CODEX_DISABLED/);
    const key = "notes-secret-with-plus+slash/marker"; const adapter = new CodexCliAdapter({ writerModel: "test", apiKey: key });
    for (const value of [key, encodeURIComponent(key), Buffer.from(key).toString("base64"), key.slice(-12), key.slice(0, 12)]) assert.equal((await adapter.parseExecutionResult(ctx, 1, value, value)).stdoutTail.includes(value), false);
    const foreign = { ...ctx, modelProviderConfig: { provider: "anthropic" as const, apiKey: "unrelated-provider-key", model: "test" } };
    assert.equal((await new CodexCliAdapter({ writerModel: "test" }).parseExecutionResult(foreign, 1, "unrelated-provider-key", "")).stdoutTail, "unrelated-provider-key");
  });
  it("bootstrap helper spawn failure preserves the original error and exits cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-lock-spawn-failure-"));
    try {
      // A successful compiler whose output has a missing interpreter forces ENOENT
      // at spawn time, after compilation, independently of the host toolchain.
      writeFileSync(join(root, "cc"), `#!/bin/sh
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    [ "$#" -gt 0 ] || exit 2
    output="$1"
  fi
  shift
done
[ -n "$output" ] || exit 2
printf '#!/sf-nonexistent-lock-interpreter\\n' > "$output"
chmod +x "$output"
`, { mode: 0o700 });
      const output = join(root, "probe");
      for (const args of [["-o", output, "-Wall", "source.c"], ["source.c", "-Wall", "-o", output]]) {
        execFileSync(join(root, "cc"), args);
        assert.equal(readFileSync(output, "utf8"), "#!/sf-nonexistent-lock-interpreter\n");
      }
      const module = pathToFileURL(resolve("packages/product-pipeline/src/bootstrap-lock.ts")).href;
      const script = `import assert from "node:assert/strict"; import { acquireBootstrapLock } from ${JSON.stringify(module)}; await assert.rejects(acquireBootstrapLock(${JSON.stringify(join(root, "lock"))}), (error) => error.code === "ENOENT");`;
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, timeout: 20000, stdio: "pipe",
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("kernel bootstrap lock releases on coordinator death and stale ref pruning preserves live owners", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-lock-notes-")); const path = join(root, "trusted.sf-bootstrap.lock");
    const module = pathToFileURL(resolve("packages/product-pipeline/src/bootstrap-lock.ts")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireBootstrapLock } from ${JSON.stringify(module)}; await acquireBootstrapLock(${JSON.stringify(path)}); console.log('READY'); setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((ready, reject) => { const timer = setTimeout(() => reject(new Error("lock child timeout")), 15000); child.stdout.once("data", () => { clearTimeout(timer); ready(); }); child.once("error", reject); child.once("exit", () => reject(new Error("lock child exited early"))); });
      await assert.rejects(acquireBootstrapLock(path), /Concurrent/);
      const exited = new Promise<void>((done) => child.once("close", () => done())); child.kill("SIGKILL"); await exited;
      let recovered: Awaited<ReturnType<typeof acquireBootstrapLock>> | undefined;
      for (let i = 0; i < 30 && !recovered; i++) { try { recovered = await acquireBootstrapLock(path); } catch { await new Promise((r) => setTimeout(r, 20)); } }
      assert.ok(recovered); recovered.assertHeld(); await recovered.release();
      const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "notes", GIT_AUTHOR_EMAIL: "notes@example.test", GIT_COMMITTER_NAME: "notes", GIT_COMMITTER_EMAIL: "notes@example.test" } }).trim();
      git(["init"]); git(["commit", "--allow-empty", "-m", "base"]); const sha = git(["rev-parse", "HEAD"]); const host = hostname().replace(/[^a-zA-Z0-9-]/g, "-");
      const old = Date.now() - 7200000; const stale = `refs/sf/pending-bootstrap/base/${host}/${child.pid}/${old}-dead`; const live = `refs/sf/pending-bootstrap/base/${host}/${process.pid}/${old}-live`;
      git(["update-ref", stale, sha]); git(["update-ref", live, sha]); assert.equal(pruneStalePendingBootstrapRefs(root), 1); assert.equal(git(["rev-parse", live]), sha);
    } finally { child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  });
  it("queue facade, hash normalization and project/task pauses agree in memory", () => parityChecks(new SoftwareFactoryControlPlaneStore()));
  it("PostgreSQL schema guards, canonical hashes, queue transitions, parity and crash journal recovery", async (t) => {
    const config = buildPostgresPoolConfigFromEnv(); if (!config) { t.skip("Real PostgreSQL required"); return; }
    const pool = new PostgresRuntimePool(config); const repo = new PostgresControlPlaneRepository(pool);
    const psql = (sql: string) => execFileSync("psql", ["-h", config.host, "-p", String(config.port), "-U", config.user, "-d", config.database, "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...(config.password ? { PGPASSWORD: config.password } : {}) } });
    try {
      await parityChecks(repo);
      for (const value of [{ a: 1.0, z: [1e-7, 1e-6, 1e21, -0, 1000000000000000100] }, { "\ue000": 1, "𐀀": 2, quote: '"\n\\', text: "Việt Nam" }]) {
        const result = await pool.queryInActiveTx("SELECT sf_canonical_json($1::jsonb) AS value;", [JSON.stringify(value)]); assert.equal(result.rows[0]!.value, canonicalizeJson(value));
      }
      assert.throws(() => psql("BEGIN; ALTER TABLE task_dependencies DROP CONSTRAINT chk_td_no_self_loop; ALTER TABLE task_dependencies ADD CONSTRAINT chk_td_no_self_loop CHECK (true); SELECT sf_verify_m6c_constraint_definitions(); COMMIT;"), /definition mismatch/);
      await pool.queryInActiveTx("SELECT sf_verify_m6c_constraint_definitions();");
      const f = await fixture(repo);
      const session = await repo.withRlsTransaction(scope(f.projectId), () => repo.createProductPipelineSession({ project_id: f.projectId, title: "hash", raw_idea_text: "test", created_by_principal_id: "notes" }));
      const insertArtifact = (hash: string) => repo.withRlsTransaction(scope(f.projectId), () => pool.queryInActiveTx(`INSERT INTO stage_artifacts(project_id,pipeline_session_id,stage,artifact_kind,version,provider,model,prompt_id,prompt_version,prompt_sha256,content_json,artifact_sha256,created_by_principal_id) VALUES($1,$2,'STAGE_1_IDEA_DISCOVERY','STAGE_1_DISCOVERY_BUNDLE',1,'system','test','test','1',$3,'{}',$4,'notes');`, [f.projectId, session.pipeline_session_id, sha256Hex("prompt"), hash]));
      await assert.rejects(insertArtifact("0".repeat(64)), /canonical SHA-256/); await insertArtifact(sha256Hex("{}"));
      const item = await candidate(f, "src/queue.ts");
      const queued = await f.core.enqueueMerge(f.projectId, f.auth, { task_id: item.task.task_id, merge_candidate_id: item.candidate.merge_candidate_id, approval_id: item.approval.approval_id });
      for (const sql of ["status='MERGED'", "project_id='00000000-0000-0000-0000-000000000001'", "attempt_count=10"]) await assert.rejects(repo.withRlsTransaction(scope(f.projectId), () => pool.queryInActiveTx(`UPDATE merge_queue_entries SET ${sql} WHERE queue_entry_id=$1;`, [queued.queue_entry_id])));
      const diagnostic = await candidate(f, "src/diagnostic.ts");
      const seeded = await repo.withRlsTransaction(scope(f.projectId), () => pool.queryInActiveTx(
        "INSERT INTO merge_queue_entries(project_id,task_id,merge_candidate_id,approval_id,last_error) VALUES($1,$2,$3,$4,'preserve diagnostic') RETURNING queue_entry_id;",
        [f.projectId,diagnostic.task.task_id,diagnostic.candidate.merge_candidate_id,diagnostic.approval.approval_id]));
      await repo.withRlsTransaction(scope(f.projectId), () => repo.withProjectMergeQueueLock(f.projectId, async () => {
        const first = await repo.claimNextMergeQueueEntry(f.projectId); assert.ok(first);
        await repo.completeMergeQueueEntry({ project_id: f.projectId, queue_entry_id: first.queue_entry_id, status: "CANCELLED" });
        const second = await repo.claimNextMergeQueueEntry(f.projectId); assert.equal(second?.queue_entry_id, seeded.rows[0]!.queue_entry_id);
        const completed = await repo.completeMergeQueueEntry({ project_id: f.projectId, queue_entry_id: second!.queue_entry_id, status: "CANCELLED" });
        assert.equal(completed.last_error, "preserve diagnostic");
      }));
      assert.match(String((await pool.queryInActiveTx("SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid='idx_code_import_submissions_lease'::regclass;")).rows[0]!.definition), /\(lease_id\)/);
      await assert.rejects(repo.withRlsTransaction(scope(f.projectId), () => repo.recordCodeImportSubmission({ source_type: "invalid" } as never)), /receipt metadata/);
      // Inject persistence drift while using real SQL detection: the new guard
      // must roll the usage transaction back instead of spinning indefinitely.
      const drift = await fixture(repo);
      const driftTask = await drift.core.createTask(drift.projectId, drift.auth, { title: "pause drift", task_contract: { allowed_files: ["src/**"] } });
      await drift.core.updateProjectBudget(drift.projectId, drift.auth, { max_project_wall_time_ms: 1 });
      const internals = repo as unknown as { persistBudgetViolationSql: (...args: unknown[]) => Promise<void> };
      const persist = internals.persistBudgetViolationSql;
      let transitions = 0;
      internals.persistBudgetViolationSql = async () => { transitions++; };
      try {
        await assert.rejects(drift.core.recordResourceUsageMetric(drift.projectId, drift.auth, {
          task_id: driftTask.task_id, lease_epoch: 0, phase: "DEVELOPER", wall_time_ms: 1,
          cpu_usage_usec: 0, peak_memory_bytes: 0, sandbox_backend_mode: "test", metrics_source: "wall-clock-only",
        }), /Budget auto-pause failed to converge/);
        assert.equal(transitions, 2);
      } finally { internals.persistBudgetViolationSql = persist; }
      const rolledBack = await drift.core.getBudgetSnapshot(drift.projectId, drift.auth);
      assert.equal(rolledBack.policy?.status, "ACTIVE");
      assert.equal(rolledBack.events.filter((e) => e.event_type === "AUTO_PAUSED").length, 0);
      const usage = await repo.withRlsTransaction(scope(drift.projectId), () => pool.queryInActiveTx("SELECT count(*) AS n FROM resource_usage_metrics WHERE project_id=$1;", [drift.projectId]));
      assert.equal(Number(usage.rows[0]!.n), 0);
      const naked = await fixture(repo); await naked.core.updateProjectBudget(naked.projectId, naked.auth, { max_project_tokens: 1 });
      const holderPool = new PostgresRuntimePool(config); let entered!: () => void; let release!: () => void;
      const locked = new Promise<void>((r) => { entered = r; }); const released = new Promise<void>((r) => { release = r; });
      const holder = holderPool.withRlsTransaction(scope(naked.projectId), async (conn) => {
        await conn.query("SELECT 1 FROM project_budget_policies WHERE project_id=$1 FOR UPDATE;", [naked.projectId]); entered(); await released;
      });
      try {
        await locked;
        const internal = repo as unknown as { assertBudgetAllowsExecutionSql(input: {project_id:string;projected_tokens:number;projected_cost_micro_usd:number}):Promise<void> };
        await assert.rejects(internal.assertBudgetAllowsExecutionSql({ project_id:naked.projectId,projected_tokens:2,projected_cost_micro_usd:0 }), BudgetAutoPausedError);
      } finally { release(); await holder; await holderPool.close(); }
      assert.equal((await naked.core.getBudgetSnapshot(naked.projectId,naked.auth)).policy?.status,"AUTO_PAUSED");
      const crash = await fixture(repo); await crash.core.updateProjectBudget(crash.projectId, crash.auth, { max_project_tokens: 1 });
      const cs = await repo.withRlsTransaction(scope(crash.projectId), () => repo.createCostSession({ project_id: crash.projectId, max_tokens_per_request: 100, max_cost_micro_usd_per_request: 100, session_token_budget: 1000, session_cost_budget_micro_usd: 1000 }));
      const call = { project_id: crash.projectId, cost_session_id: cs.cost_session_id, stage: "crash", provider: "openai", model: "test", prompt_id: "test", prompt_version: "1", prompt_sha256: sha256Hex("p"), request_sha256: sha256Hex("r"), estimated_input_tokens: 2, reserved_output_tokens: 0, estimated_cost_micro_usd: 1 };
      const dbModule = pathToFileURL(resolve("packages/database/src/index.ts")).href;
      const script = `import {PostgresRuntimePool,PostgresControlPlaneRepository} from ${JSON.stringify(dbModule)}; const pool=new PostgresRuntimePool(JSON.parse(process.env.SF_TEST_PG_CONFIG)); const repo=new PostgresControlPlaneRepository(pool); const schedule=pool.afterTransactionEnd.bind(pool);pool.afterTransactionEnd=()=>schedule(async()=>{process.exit(73)}); await repo.withRlsTransaction(${JSON.stringify(scope(crash.projectId))},async()=>{await pool.queryInActiveTx('SELECT 1 FROM project_budget_policies WHERE project_id=$1 FOR UPDATE',[${JSON.stringify(crash.projectId)}]);await repo.preflightCheckCostSession(${JSON.stringify(call)});});`;
      assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env, SF_TEST_PG_CONFIG: JSON.stringify(config) }, timeout: 20000, stdio: "pipe" }), (error: unknown) => (error as {status?: number}).status === 73);
      const pending = await repo.withRlsTransaction(scope(crash.projectId), () => pool.queryInActiveTx("SELECT * FROM budget_denial_intents WHERE project_id=$1;", [crash.projectId])); assert.equal(pending.rows[0]!.status, "PENDING");
      const reopened = new PostgresControlPlaneRepository(pool); const core = new CoreApiService(reopened); const auth = core.issueAuthContext({ projectId: crash.projectId, principalId: "notes", roles: ["ORG_ADMIN"] });
      assert.equal((await core.getBudgetSnapshot(crash.projectId, auth)).policy?.status, "AUTO_PAUSED");
      const ledgers = await reopened.withRlsTransaction(scope(crash.projectId), () => reopened.listModelCallLedgers({ cost_session_id: cs.cost_session_id })); assert.equal(ledgers.length, 1); assert.equal(ledgers[0]!.status, "BLOCKED_PREFLIGHT");
      await core.getBudgetSnapshot(crash.projectId, auth);
      assert.equal((await reopened.withRlsTransaction(scope(crash.projectId), () => reopened.listModelCallLedgers({ cost_session_id: cs.cost_session_id }))).length, 1);
      await assert.rejects(repo.withRlsTransaction(scope(crash.projectId), () => pool.queryInActiveTx("DELETE FROM budget_denial_intents;")));
      // The unscoped read proves isolation; a separate authorized read proves durability.
      assert.equal((await pool.queryInActiveTx("SELECT * FROM budget_denial_intents;")).rowCount, 0);
      const retained = await repo.withRlsTransaction(scope(crash.projectId), () => pool.queryInActiveTx(
        "SELECT intent_id,status,completed_at FROM budget_denial_intents WHERE intent_id=$1;", [pending.rows[0]!.intent_id]));
      assert.equal(retained.rowCount, 1); assert.equal(retained.rows[0]!.status, "COMPLETED");
      assert.ok(retained.rows[0]!.completed_at);
      assert.equal(ledgers[0]!.call_id, retained.rows[0]!.intent_id);
    } finally { await pool.close(); }
  });
});
