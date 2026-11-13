import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CoreApiService, CoreApiHttpServer, CORE_API_AUTH_HEADER, encodeCoreApiAuthHeader } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore, PostgresControlPlaneRepository, PostgresRuntimePool, buildPostgresPoolConfigFromEnv, type ControlPlaneStore } from "@software-factory/database";
import { UserManagedWorkerHttpConnector, ProviderVmHttpConnector, RemoteSessionHttpConnector, signTargetProtocol, type ExternalExecutionTargetType } from "@software-factory/adapter-sdk";
import { Docker3TierVerifier, ImmutableSourceSnapshotStore } from "@software-factory/verifier";
import { sha256Hex, type TargetTrustTier } from "@software-factory/shared-types";
import { deploymentFixture } from "./m6c3-deployment-fixture.ts";
import { createCoreApiRuntime } from "../../../apps/core-api/src/runtime.ts";
const targets = [
    ["user_managed_worker", "TIER_2_USER_MANAGED", UserManagedWorkerHttpConnector],
    ["provider_managed_vm", "TIER_3_PROVIDER_VM", ProviderVmHttpConnector],
    ["remote_agent_session", "TIER_4_REMOTE_SESSION", RemoteSessionHttpConnector],
] as const;
type Fault = "none" | "signature" | "identity" | "capabilities" | "redirect" | "oversize" | "binding" | "protected" | "disconnect";
async function fixture(store: ControlPlaneStore, index = 0) {
    const [kind, tier, Connector] = targets[index]!;
    const secret = randomBytes(32).toString("hex");
    let fault: Fault = "none";
    let calls = 0;
    const wire: string[] = [];
    const server = createServer(async (req, res) => {
        try {
            let raw = "";
            for await (const chunk of req)
                raw += String(chunk);
            wire.push(raw, JSON.stringify(req.headers));
            const body = JSON.parse(raw);
            assert.equal(req.headers["x-sf-target-signature"], signTargetProtocol(secret, "request", req.url!, body.nonce, body));
            if (req.url === "/target/execute")
                calls++;
            if (fault === "disconnect" && req.url === "/target/execute") {
                req.socket.destroy();
                return;
            }
            if (fault === "redirect") {
                res.writeHead(307, { location: "/unexpected" });
                res.end();
                return;
            }
            const result = {
                schema_version: "sf-target-v1", nonce: body.nonce, target_type: kind,
                principal_id: fault === "identity" ? "impostor" : "remote-principal", worker_id: "external-worker", provider: "protocol-emulator", model: "provider-free",
                ...(req.url === "/target/health" ? { capabilities: fault === "capabilities" ? [] : ["code-import-v1", "idempotent-execution", "lease-fenced-results"] } : {
                    execution_id: fault === "binding" ? randomUUID() : body.action.execution_id, lease_epoch: body.action.lease_epoch,
                    submission: { kind: "artifact", files: [{ action: "write", path: fault === "protected" ? "private/credential.txt" : "src/result.ts", content_base64: Buffer.from("export const value = 42;\n").toString("base64") }] },
                }),
            };
            if (req.url === "/target/execute")
                assert.equal(req.headers["idempotency-key"], body.action.execution_id);
            res.writeHead(200, { "content-type": "application/json", "x-sf-target-signature": fault === "signature" ? "0".repeat(64) : signTargetProtocol(secret, "response", req.url!, body.nonce, result) });
            res.end(fault === "oversize" ? " ".repeat(17000) : JSON.stringify(result));
        }
        catch {
            res.writeHead(500);
            res.end();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connector = new Connector({ endpoint: `http://127.0.0.1:${address.port}/target`, signingSecret: secret, principalId: "remote-principal", workerId: "external-worker", provider: "protocol-emulator", model: "provider-free", testOnlyLoopback: true });
    const fx = await deploymentFixture(store, {});
    const repo = fx.git(["rev-parse", "--show-toplevel"]);
    const snapshots = new ImmutableSourceSnapshotStore({ storageDir: join(repo, "..", "snapshots") });
    const core = new CoreApiService(store, { authenticator: fx.core.authenticator, snapshotStore: snapshots, executionTargets: { connectors: { external: connector }, testOnlyEmulator: store instanceof SoftwareFactoryControlPlaneStore, timeoutMs: 3000 } });
    const profileInput = { profile_key: "external-dev", role: "DEVELOPER" as const, principal_id: "remote-principal", provider: "protocol-emulator", model: "provider-free", execution_target_type: kind as ExternalExecutionTargetType, trust_tier: tier as TargetTrustTier, target_locator: "external" };
    const profile = await core.upsertAgentOrganizationProfile(fx.projectId, fx.human, profileInput);
    const task = await core.createTask(fx.projectId, fx.developer, { title: "INTERNAL_TITLE_CANARY", task_contract: { allowed_files: ["src/**"], protected_paths: ["private/**"] } });
    const assignmentInput = { profile_id: profile.profile_id, public_context: "Implement the public example value.", data_classification: "PUBLIC" as const };
    const assign = () => core.assignTaskExecutionTarget(fx.projectId, fx.human, task.task_id, assignmentInput);
    const request = { execution_request_id: randomUUID() };
    const execute = () => core.executeTaskOnTarget(fx.projectId, fx.developer, task.task_id, request);
    return { ...fx, core, store, repo, snapshots, connector, profile, profileInput, task, assignmentInput, request, assign, execute, calls: () => calls, wire, setFault: (f: Fault) => { fault = f; }, close: async () => { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); fx.cleanup(); } };
}
async function success(store: ControlPlaneStore, index: number) {
    const fx = await fixture(store, index);
    try {
        await assert.rejects(fx.core.assignTaskExecutionTarget(fx.projectId, fx.developer, fx.task.task_id, fx.assignmentInput), /Authorization/);
        const assignment = await fx.assign();
        await assert.rejects(fx.assign());
        await assert.rejects(fx.core.dispatchTaskLease(fx.projectId, fx.developer, { task_id: fx.task.task_id, worker_id: "external-worker", execution_target_assignment_id: assignment.assignment_id, execution_target_request_id: randomUUID() } as never), /binding|assignment/);
        await assert.rejects(store.withRlsTransaction({ ...fx.scope, currentRole: "gateway_service" }, () => store.grantTaskLease({ project_id: fx.projectId, task_id: fx.task.task_id, worker_id: "legacy-worker" })), /assignment|binding/);
        const scheduled = await fx.core.scheduleReadyTasks(fx.projectId, fx.developer, { worker_id: "legacy-worker" });
        assert.equal(scheduled.leases.length, 0);
        assert.ok(scheduled.blocked.some((r) => r.task_id === fx.task.task_id));
        const results = await Promise.all(Array.from({ length: 5 }, fx.execute));
        const result = await fx.execute();
        assert.equal(result.status, "IMPORTED");
        assert.equal(fx.calls(), 1);
        assert.equal(new Set(results.map((r) => r.lease_id)).size, 1);
        assert.ok(results.every((r) => ["SENDING", "IMPORTED"].includes(r.status)));
        const lease = await store.withRlsTransaction(fx.scope, () => store.getLeaseById(result.lease_id));
        assert.equal(lease?.execution_target_assignment_id, assignment.assignment_id);
        const receipt = await store.withRlsTransaction(fx.scope, () => store.getCodeImportSubmission(result.lease_id));
        assert.ok(receipt);
        assert.equal(fx.git(["rev-parse", "main"]), fx.release.main_head_commit_hash, "external import never changes main");
        assert.equal(fx.git(["show", `${receipt.agent_commit_hash}:src/result.ts`]), "export const value = 42;");
        const payload = fx.wire.join("\n");
        for (const canary of ["INTERNAL_TITLE_CANARY", "repo_bare_path", "task_contract_json", "currentPrincipalId", "PGPASSWORD", "authorization"])
            assert.equal(payload.includes(canary), false, canary);
        assert.ok(payload.includes(fx.assignmentInput.public_context));
        // Mutable Stage 6 metadata cannot downgrade an already assigned lease's verification.
        await fx.core.upsertAgentOrganizationProfile(fx.projectId, fx.human, { ...fx.profileInput, profile_id: fx.profile.profile_id, execution_target_type: "factory_managed_worker", trust_tier: "TIER_1_FACTORY_MANAGED", target_locator: null });
        const built = await fx.core.buildMergeCandidateFromGit(fx.projectId, fx.developer, { task_id: fx.task.task_id, lease_id: result.lease_id, lease_epoch: lease!.lease_epoch, staging_ref: receipt.staging_ref, agent_commit_hash: receipt.agent_commit_hash, repo_path: fx.repo, snapshot_store: fx.snapshots });
        assert.equal(built.ok, true);
        if (!built.ok)
            throw new Error("candidate failed");
        const verifier = new Docker3TierVerifier({ snapshotStore: fx.snapshots });
        let policyChecked = false;
        verifier.verifyCandidateWithRetries = async (input) => { assert.equal(input.requireKernelIsolation, true); assert.equal(input.networkDisabled, true); policyChecked = true; throw new Error("policy-probe-stop-before-execution"); };
        await assert.rejects(fx.core.verifyMergeCandidate(fx.projectId, fx.developer, { task_id: fx.task.task_id, merge_candidate_id: built.mergeCandidate.merge_candidate_id, verifier, trusted_acceptance_dir: fx.repo, require_kernel_isolation: false, network_disabled: false, tier1_command: { command: "true" }, tier2_command: { command: "true" }, tier3_command: { command: "true" } }), /policy-probe/);
        assert.equal(policyChecked, true);
        const invalidRun = { project_id: fx.projectId, task_id: fx.task.task_id, merge_candidate_id: built.mergeCandidate.merge_candidate_id, merge_candidate_hash: built.mergeCandidate.merge_candidate_hash, verified_tree_hash: built.mergeCandidate.verified_tree_hash, verifier_image_digest: `sha256:${"a".repeat(64)}`, verdict: "PASS" as const, exit_code: 0, duration_ms: 1, report_sha256: sha256Hex("test"), execution_backend: "docker" as const, is_docker_isolated: true, hermetic_network_disabled: true, isolation_runtime: null };
        await assert.rejects(store.withRlsTransaction(fx.scope, () => store.recordVerificationRun(invalidRun)), /External target verification/);
        return { projectId: fx.projectId, scope: fx.scope, assignment, result, lease: lease!, candidate: built.mergeCandidate, invalidRun };
    }
    finally {
        await fx.close();
    }
}
async function failures(store: ControlPlaneStore) {
    for (const fault of ["signature", "identity", "capabilities", "redirect", "oversize"] as const) {
        const fx = await fixture(store);
        try {
            await fx.assign();
            fx.setFault(fault);
            await assert.rejects(fx.execute(), /health/);
            assert.equal(fx.calls(), 0);
            assert.equal((await store.withRlsTransaction(fx.scope, () => store.listTaskLeasesForTask(fx.task.task_id))).length, 0);
        }
        finally {
            await fx.close();
        }
    }
    for (const fault of ["binding", "disconnect", "protected"] as const) {
        const fx = await fixture(store);
        try {
            await fx.assign();
            fx.setFault(fault);
            const result = await fx.execute();
            assert.equal(result.status, fault === "protected" ? "REJECTED" : "UNKNOWN");
            fx.setFault("none");
            assert.equal((await fx.execute()).status, result.status);
            assert.equal(fx.calls(), 1);
            assert.equal(await store.withRlsTransaction(fx.scope, () => store.getCodeImportSubmission(result.lease_id)), null);
            assert.equal(fx.git(["rev-parse", "main"]), fx.release.main_head_commit_hash);
        }
        finally {
            await fx.close();
        }
    }
    const stale = await fixture(store);
    try {
        await stale.assign();
        const remoteExecute = stale.connector.execute.bind(stale.connector);
        stale.connector.execute = async (action, signal) => {
            const submission = await remoteExecute(action, signal);
            await store.withRlsTransaction(stale.scope, () => store.revokeTaskLease({ project_id: stale.projectId, task_id: stale.task.task_id, lease_id: action.execution_id, reason: "revoked during external execution" }));
            return submission;
        };
        const result = await stale.execute();
        assert.notEqual(result.status, "IMPORTED");
        assert.equal(stale.calls(), 1);
        assert.equal(await store.withRlsTransaction(stale.scope, () => store.getCodeImportSubmission(result.lease_id)), null);
        assert.equal(stale.git(["rev-parse", "main"]), stale.release.main_head_commit_hash);
    }
    finally {
        await stale.close();
    }
}
async function recovery(store: ControlPlaneStore) {
    const fx = await fixture(store);
    const finish = store.finishTargetDispatch.bind(store);
    try {
        await fx.assign();
        store.finishTargetDispatch = async () => { throw new Error("DB completion unavailable"); };
        await assert.rejects(fx.execute(), /DB completion/);
        assert.equal(fx.calls(), 1);
        store.finishTargetDispatch = finish;
        assert.equal((await fx.execute()).status, "IMPORTED");
        assert.equal(fx.calls(), 1);
    }
    finally {
        store.finishTargetDispatch = finish;
        await fx.close();
    }
    const fx2 = await fixture(store);
    try {
        await fx2.assign();
        // Simulate a restarted broker observing a committed SENDING intent with no receipt.
        await store.withRlsTransaction(fx2.scope, async () => { const a = await store.getTaskExecutionAssignment(fx2.task.task_id); const lease = await store.grantTaskLease({ project_id: fx2.projectId, task_id: fx2.task.task_id, worker_id: a!.worker_id, execution_target_assignment_id: a!.assignment_id, execution_target_request_id: fx2.request.execution_request_id }); await store.claimTargetDispatch(fx2.projectId, lease.lease_id, sha256Hex("health")); });
        const restarted = new CoreApiService(store, { authenticator: fx2.core.authenticator, executionTargets: { connectors: { external: fx2.connector }, testOnlyEmulator: store instanceof SoftwareFactoryControlPlaneStore } });
        assert.equal((await restarted.executeTaskOnTarget(fx2.projectId, fx2.developer, fx2.task.task_id, fx2.request)).status, "SENDING");
        assert.equal(fx2.calls(), 0);
    }
    finally {
        await fx2.close();
    }
}
describe("M6C-3 approved external execution targets", () => {
    it("Tier 2/3/4 signed HTTP clients import once and preserve mandatory isolation after profile edits", async () => { for (let i = 0; i < targets.length; i++)
        await success(new SoftwareFactoryControlPlaneStore(), i); });
    it("health/authentication/binding/allowlist failures fail closed and uncertain requests never re-dispatch", async () => failures(new SoftwareFactoryControlPlaneStore()));
    it("lost completion and restart recover from durable intent/receipt without a second remote call", async () => recovery(new SoftwareFactoryControlPlaneStore()));
    it("assignment rejects secrets, non-public context, unknown fields, mutable profile drift and unsafe endpoint configuration", async () => {
        const store = new SoftwareFactoryControlPlaneStore();
        const fx = await fixture(store);
        try {
            for (const patch of [{ data_classification: "INTERNAL" }, { endpoint: "https://attacker.test" }, { public_context: `Authorization: Bearer ${"x".repeat(48)}` }])
                await assert.rejects(fx.core.assignTaskExecutionTarget(fx.projectId, fx.human, fx.task.task_id, { ...fx.assignmentInput, ...patch } as never));
            await fx.assign();
            await fx.core.upsertAgentOrganizationProfile(fx.projectId, fx.human, { ...fx.profileInput, profile_id: fx.profile.profile_id, model: "changed" });
            await assert.rejects(fx.execute(), /changed/);
            assert.equal(fx.calls(), 0);
            assert.throws(() => new CoreApiService(store, { executionTargets: { connectors: { external: fx.connector } } }), /durable PostgreSQL/);
            const codex = new CoreApiService(store, { authenticator: fx.core.authenticator, executionTargets: { connectors: { external: { ...fx.connector, targetType: fx.connector.targetType, principalId: fx.connector.principalId, workerId: fx.connector.workerId, provider: "codex", model: "codex", health: fx.connector.health.bind(fx.connector), execute: fx.connector.execute.bind(fx.connector) } }, testOnlyEmulator: true } });
            const codexProfile = await codex.upsertAgentOrganizationProfile(fx.projectId, fx.human, { ...fx.profileInput, profile_id: fx.profile.profile_id, provider: "codex", model: "codex" });
            const fresh = await codex.createTask(fx.projectId, fx.developer, { title: "Unmetered Codex denial", task_contract: { allowed_files: ["src/**"] } });
            await assert.rejects(codex.assignTaskExecutionTarget(fx.projectId, fx.human, fresh.task_id, { ...fx.assignmentInput, profile_id: codexProfile.profile_id }), /ERR_UNMETERED_CODEX_DISABLED/);
            const options = { endpoint: "http://example.test", signingSecret: randomBytes(32).toString("hex"), principalId: "remote-principal", workerId: "worker", provider: "p", model: "m" };
            assert.throws(() => new UserManagedWorkerHttpConnector(options), /HTTPS/);
            assert.throws(() => new UserManagedWorkerHttpConnector({ ...options, endpoint: "https://example.test", model: "codex" }), /ERR_UNMETERED_CODEX_DISABLED/);
            await assert.rejects(createCoreApiRuntime({ env: {}, requirePostgres: false, executionTargets: { connectors: { external: fx.connector } } }), /PostgreSQL runtime is required/);
            assert.throws(() => new UserManagedWorkerHttpConnector({ ...options, endpoint: "https://user:password@example.test" }), /HTTPS/);
        }
        finally {
            await fx.close();
        }
    });
    it("HTTP authorization and strict execution requests reject caller-selected connectors and assignment bypass", async () => {
        const fx = await fixture(new SoftwareFactoryControlPlaneStore());
        const server = new CoreApiHttpServer({ coreApi: fx.core });
        const endpoint = await server.start();
        try {
            const base = `${endpoint.baseUrl}/api/v1/projects/${fx.projectId}/tasks/${fx.task.task_id}`;
            const request = (path: string, body: unknown, auth = fx.human) => fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json", [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(auth) }, body: JSON.stringify(body) });
            assert.equal((await request("execution-target", fx.assignmentInput, fx.developer)).status, 403);
            assert.equal((await request("execution-target", fx.assignmentInput)).status, 201);
            assert.equal((await request("execute-target", { ...fx.request, endpoint: "https://attacker.test" }, fx.developer)).ok, false);
            assert.equal((await request("execute-target", fx.request, fx.developer)).status, 200);
            assert.equal(fx.calls(), 1);
        }
        finally {
            await server.stop();
            await fx.close();
        }
    });
    it("PostgreSQL persists intents and tenant isolation, rejects SQL tampering and verification downgrade", async (t) => {
        const config = buildPostgresPoolConfigFromEnv();
        if (!config) {
            t.skip("Real PostgreSQL required");
            return;
        }
        const pool = new PostgresRuntimePool(config);
        const store = new PostgresControlPlaneRepository(pool);
        try {
            const result = await success(store, 2);
            await failures(store);
            await recovery(store);
            const crashed = await fixture(store);
            try {
                await crashed.assign();
                const source = `import { CoreApiService } from '@software-factory/core-api';
          import { PostgresRuntimePool, PostgresControlPlaneRepository, buildPostgresPoolConfigFromEnv } from '@software-factory/database';
          const store=new PostgresControlPlaneRepository(new PostgresRuntimePool(buildPostgresPoolConfigFromEnv()));
          const connector={targetType:'user_managed_worker',principalId:'remote-principal',workerId:'external-worker',provider:'protocol-emulator',model:'provider-free',health:async()=>({health_sha256:'${sha256Hex("health")}'}),execute:async()=>process.exit(73)};
          const core=new CoreApiService(store,{executionTargets:{connectors:{external:connector}}});
          const projectId=${JSON.stringify(crashed.projectId)};
          const auth=core.issueAuthContext({projectId,principalId:'developer',roles:['DEVELOPER']});
          await core.executeTaskOnTarget(projectId,auth,${JSON.stringify(crashed.task.task_id)},${JSON.stringify(crashed.request)});`;
                const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 15000 });
                assert.equal(child.status, 73, child.stderr);
                assert.equal((await crashed.execute()).status, "SENDING");
                assert.equal(crashed.calls(), 0);
            }
            finally {
                await crashed.close();
            }
            const query = (sql: string, values: unknown[] = []) => store.withRlsTransaction(result.scope, () => pool.queryInActiveTx(sql, values));
            for (const sql of ["UPDATE task_execution_assignments SET public_context='forged';", "DELETE FROM task_execution_assignments;", "DELETE FROM target_dispatches;", "UPDATE target_dispatches SET status='PENDING';"])
                await assert.rejects(query(sql));
            await assert.rejects(store.withRlsTransaction({ ...result.scope, currentRole: "gateway_service" }, () => pool.queryInActiveTx("INSERT INTO task_leases SELECT (jsonb_populate_record(NULL::task_leases,to_jsonb(l)||jsonb_build_object('lease_id',gen_random_uuid(),'lease_epoch',l.lease_epoch+10,'execution_target_assignment_id',NULL,'execution_target_request_id',NULL))).* FROM task_leases l WHERE lease_id=$1;", [result.lease.lease_id])), /binding/);
            for (const currentRole of ["core_api_service", "gateway_service"] as const)
                await assert.rejects(store.withRlsTransaction({ ...result.scope, currentRole }, () => pool.queryInActiveTx("UPDATE tasks SET task_contract_json='{}'::jsonb WHERE task_id=$1;", [result.lease.task_id])), /contract is immutable/);
            await assert.rejects(query("UPDATE task_leases SET worker_id='impostor' WHERE lease_id=$1;", [result.lease.lease_id]), /immutable/);
            await assert.rejects(query("UPDATE task_leases SET execution_target_assignment_id=NULL,execution_target_request_id=NULL WHERE lease_id=$1;", [result.lease.lease_id]), /immutable/);
            await assert.rejects(query("INSERT INTO task_execution_assignments SELECT (jsonb_populate_record(NULL::task_execution_assignments,to_jsonb(a)||jsonb_build_object('assignment_id',gen_random_uuid(),'approved_by_principal_id','developer'))).* FROM task_execution_assignments a WHERE assignment_id=$1;", [result.assignment.assignment_id]), /approver/);
            assert.equal((await pool.queryInActiveTx("SELECT * FROM task_execution_assignments;")).rowCount, 0);
            assert.equal(await store.withRlsTransaction({ ...result.scope, currentProjectId: randomUUID() }, () => store.getTargetDispatchByRequest(result.result.execution_request_id)), null);
            const columns = ["project_id", "task_id", "merge_candidate_id", "merge_candidate_hash", "verified_tree_hash", "verifier_image_digest", "verdict", "exit_code", "duration_ms", "report_sha256", "execution_backend", "is_docker_isolated", "hermetic_network_disabled", "isolation_runtime"] as const;
            await assert.rejects(query(`INSERT INTO verification_runs(${columns.join(",")}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")});`, columns.map((c) => result.invalidRun[c])), /External target verification/);
            const restarted = new PostgresControlPlaneRepository(pool);
            assert.equal((await restarted.withRlsTransaction(result.scope, () => restarted.getTargetDispatchByRequest(result.result.execution_request_id)))?.status, "IMPORTED");
            const tables = await pool.queryInActiveTx("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('task_execution_assignments'::regclass,'target_dispatches'::regclass);");
            assert.equal(tables.rowCount, 2);
            for (const row of tables.rows) {
                assert.equal(row.relrowsecurity, true);
                assert.equal(row.relforcerowsecurity, true);
            }
        }
        finally {
            await pool.close();
        }
    });
});
