import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerEndpointServer, LinuxWorkerEndpointRunner, WorkerExecutionJournal, assertWorkerCleanup, type WorkerEndpointRunner, type WorkerEndpointServerConfig, type SandboxCleanupEvidence } from "@software-factory/wna";
import { UserManagedWorkerHttpConnector, signTargetProtocol, type ExternalTargetAction } from "@software-factory/adapter-sdk";
import { CoreApiService } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore } from "@software-factory/database";
import { deploymentFixture } from "./m6c3-deployment-fixture.ts";

const secret = randomBytes(32).toString("hex");
const submission = { kind: "artifact" as const, files: [{ action: "write" as const, path: "src/result.ts", content_base64: Buffer.from("export const result = 42;\n").toString("base64") }] };
function evidence(action: ExternalTargetAction): SandboxCleanupEvidence { return { taskId: action.execution_id, leaseEpoch: action.lease_epoch, backendMode: "simulated-cgroup-v2", isSimulated: true, realKernelOperationsExecuted: false, realProcessGroupKilled: false, cgroupPath: "", freezeApplied: false, cgroupKillWritten: false, populatedZeroVerified: false, subreaperWaitpidReapedPids: [], remainingProcsCount: 0, cgroupDirRemoved: false, killedPids: [], verifiedAt: new Date().toISOString() }; }
function action(): ExternalTargetAction { return { execution_id: randomUUID(), task_id: randomUUID(), lease_epoch: 1, base_main_commit_hash: "a".repeat(40), deadline: new Date(Date.now() + 30000).toISOString(), allowed_files: ["src/**"], public_context: "Public example task" }; }
function client(endpoint: string) { return new UserManagedWorkerHttpConnector({ endpoint, signingSecret: secret, principalId: "worker-principal", workerId: "worker-1", provider: "emulator", model: "provider-free", testOnlyLoopback: true }); }
async function fixture(options: { config?: Partial<WorkerEndpointServerConfig>; runner?: WorkerEndpointRunner; stateDir?: string } = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "sf-m6c3-a-journal-")); let calls = 0;
  const runner = options.runner ?? { health: async () => {}, execute: async (a: ExternalTargetAction) => { calls++; return { submission, cleanupEvidence: evidence(a) }; } };
  const config: WorkerEndpointServerConfig = { tenantNamespace: "tenant-a", principalId: "worker-principal", workerId: "worker-1", provider: "emulator", model: "provider-free", signingSecret: secret, stateDir, runner, testOnlyEmulator: true, ...options.config };
  const server = createWorkerEndpointServer(config); const address = await server.listen();
  return { server, config, stateDir, endpoint: address.endpoint, connector: client(address.endpoint), calls: () => calls, close: async () => { await server.close(); if (!options.stateDir) rmSync(stateDir, { recursive: true, force: true }); } };
}
async function post(endpoint: string, route: string, a: unknown, patch: Record<string, unknown> = {}, key?: string, badSignature = false) {
  const nonce = randomBytes(24).toString("hex"); const body = { schema_version: "sf-target-v1", nonce, action: a, ...patch };
  return fetch(`${endpoint}/${route}`, { method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json", "x-sf-target-signature": badSignature ? "0".repeat(64) : signTargetProtocol(secret, "request", `/${route}`, nonce, body), ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
}
describe("M6C-3 worker endpoint and durable journal", () => {
  it("real HTTP protocol signs health and terminal replay with fresh nonce, without runner re-execution", async () => {
    const fx = await fixture(); const a = action();
    try {
      await fx.connector.health(AbortSignal.timeout(3000));
      assert.deepEqual(await fx.connector.execute(a, AbortSignal.timeout(3000)), submission);
      assert.deepEqual(await fx.connector.execute(a, AbortSignal.timeout(3000)), submission); assert.equal(fx.calls(), 1);
      const stored = new WorkerExecutionJournal(fx.stateDir, "tenant-a").read(a); assert.equal(stored?.status, "COMPLETED"); assert.equal(stored?.cleanupEvidence?.isSimulated, true);
      assert.equal(new WorkerExecutionJournal(fx.stateDir, "tenant-b").read(a), null);
      await assert.rejects(fx.connector.execute({ ...a, public_context: "changed payload" }, AbortSignal.timeout(3000))); assert.equal(fx.calls(), 1);
    } finally { await fx.close(); }
  });
  it("authentication/schema/action/expiry/size guards reject before execution", async () => {
    const fx = await fixture(); const a = action();
    try {
      assert.equal((await post(fx.endpoint, "execute", a, {}, a.execution_id, true)).status, 401);
      for (const value of [{ ...a, command: "sh" }, { ...a, task_id: "../escape" }, { ...a, allowed_files: ["../escape"] }, { ...a, deadline: new Date(Date.now() - 1000).toISOString() }, { ...a, deadline: new Date(Date.now() + 180000).toISOString() }, { ...a, lease_epoch: 0 }, { ...a, public_context: "x".repeat(16385) }]) assert.equal((await post(fx.endpoint, "execute", value, {}, a.execution_id)).ok, false);
      assert.equal((await post(fx.endpoint, "execute", a, { endpoint: "https://attacker.test" }, a.execution_id)).ok, false);
      assert.equal((await post(fx.endpoint, "execute", a)).ok, false);
      assert.equal((await post(fx.endpoint, "health", { injected: "command" })).ok, false);
      const oversized = await post(fx.endpoint, "health", { padding: "x".repeat(20000) });
      assert.equal(oversized.status, 400); await oversized.text();
      assert.equal(fx.calls(), 0); assert.equal(new WorkerExecutionJournal(fx.stateDir, "tenant-a").read(a), null);
    } finally { await fx.close(); }
  });
  it("two endpoint instances/process-safe journal claims cannot run one execution twice", { timeout: 10000 }, async () => {
    const first = await fixture();
    let unblock!: () => void, markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; }); let calls = 0;
    const runner: WorkerEndpointRunner = { health: async () => {}, execute: async (a) => { calls++; markEntered(); await gate; return { submission, cleanupEvidence: evidence(a) }; } };
    const second = await fixture({ stateDir: first.stateDir, runner }); const third = await fixture({ stateDir: first.stateDir, runner }); const a = action();
    const controller = new AbortController();
    const observed = second.connector.execute(a, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered,
        observed.then((result) => { throw new Error("First worker request settled before runner entry", { cause: result.ok ? undefined : result.error }); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("First worker did not enter the runner within 2000ms")), 2000); }),
      ]);
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      await assert.rejects(third.connector.execute(a, AbortSignal.timeout(2000))); assert.equal(calls, 1);
      unblock(); const result = await observed; if (!result.ok) throw result.error;
      assert.deepEqual(result.value, submission);
      assert.deepEqual(await third.connector.execute(a, AbortSignal.timeout(3000)), submission); assert.equal(calls, 1);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort(); unblock(); await observed;
      await third.close(); await second.close(); await first.close();
    }
  });
  it("failed terminal persistence and aborted execution keep claims held across restart", async () => {
    const fx = await fixture({ config: { testOnlyHooks: { beforeTerminalPersist: () => { throw new Error("private-injected-error"); } } } }); const a = action();
    try {
      const response = await post(fx.endpoint, "execute", a, {}, a.execution_id); assert.equal(response.ok, false); assert.equal((await response.text()).includes("private-injected-error"), false); assert.equal(fx.calls(), 1);
      const restarted = await fixture({ stateDir: fx.stateDir, runner: { health: async () => { throw new Error("Unavailable kernel must not hide durable HOLD"); }, execute: async () => { throw new Error("Must not re-execute claim"); } } });
      try {
        assert.equal((await post(restarted.endpoint, "execute", a, {}, a.execution_id)).status, 409);
        const expired = { ...action(), deadline: new Date(Date.now() - 1000).toISOString() };
        new WorkerExecutionJournal(fx.stateDir, "tenant-a").claim(expired);
        assert.equal((await post(restarted.endpoint, "execute", expired, {}, expired.execution_id)).status, 409);
      } finally { await restarted.close(); }
    } finally { await fx.close(); }
  });
  it("shutdown stops accepting requests, signals cancellation and waits for cleanup before returning", async () => {
    let entered!: () => void, finishCleanup!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { finishCleanup = resolve; }); let cancelled = false;
    const fx = await fixture({ runner: { health: async () => {}, execute: async (a, signal) => {
      entered(); await new Promise<void>((resolve) => { const abort = () => { cancelled = true; resolve(); }; if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); });
      await cleanupGate; return { submission, cleanupEvidence: evidence(a) };
    } } }); const a = action();
    try {
      const execution = fx.connector.execute(a, AbortSignal.timeout(5000)).catch(() => null); await started;
      let closed = false; const shutdown = fx.server.close().then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(cancelled, true); assert.equal(closed, false);
      await assert.rejects(fx.connector.health(AbortSignal.timeout(1000)));
      finishCleanup(); await shutdown; await execution;
      assert.equal(new WorkerExecutionJournal(fx.stateDir, "tenant-a").read(a)?.status, "CLAIMED");
    } finally { finishCleanup(); await fx.close(); }
  });
  it("process death after durable claim and before runner leaves HOLD after actual restart", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "sf-m6c3-a-death-")); const marker = join(stateDir, "spawned");
    const source = `import {createWorkerEndpointServer} from '@software-factory/wna'; import {writeFileSync} from 'node:fs';
      const server=createWorkerEndpointServer({tenantNamespace:'tenant-a',principalId:'worker-principal',workerId:'worker-1',provider:'emulator',model:'provider-free',signingSecret:${JSON.stringify(secret)},stateDir:${JSON.stringify(stateDir)},testOnlyEmulator:true,
      runner:{health:async()=>{},execute:async()=>{writeFileSync(${JSON.stringify(marker)},'unexpected');throw new Error('unexpected');}},testOnlyHooks:{afterJournalClaim:()=>process.exit(74)}});
      console.log((await server.listen()).endpoint);`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }); let stderr = ""; child.stderr.on("data", (s) => { stderr += s; });
    const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      const endpoint = await new Promise<string>((resolve, reject) => { let output = ""; const timer = setTimeout(() => reject(new Error(`Child startup timeout ${stderr}`)), 10000); child.stdout.on("data", (s) => { output += s; if (output.includes("\n")) { clearTimeout(timer); resolve(output.trim()); } }); child.once("error", reject); });
      const a = action(); await assert.rejects(client(endpoint).execute(a, AbortSignal.timeout(3000))); assert.equal(await exit, 74, stderr); assert.equal(existsSync(marker), false);
      const restarted = await fixture({ stateDir });
      try { assert.equal((await post(restarted.endpoint, "execute", a, {}, a.execution_id)).status, 409); assert.equal(restarted.calls(), 0); } finally { await restarted.close(); }
    } finally { if (child.exitCode === null) child.kill("SIGKILL"); rmSync(stateDir, { recursive: true, force: true }); }
  });
  it("production endpoint refuses simulated cleanup; strict Linux runner fails closed on unsupported host", async () => {
    const a = action(); assert.throws(() => assertWorkerCleanup(evidence(a), a), /kernel cleanup/);
    const stateDir = mkdtempSync(join(tmpdir(), "sf-m6c3-a-kernel-")); chmodSync(stateDir, 0o700);
    try {
      assert.throws(() => createWorkerEndpointServer({ tenantNamespace: "tenant-a", principalId: "p", workerId: "w", provider: "emulator", model: "provider-free", signingSecret: secret, stateDir, runner: { health: async () => {}, execute: async () => { throw new Error(); } } }), /strict Linux runner/);
      assert.throws(() => createWorkerEndpointServer({ tenantNamespace: "tenant-a", principalId: "p", workerId: "w", provider: "codex", model: "codex", signingSecret: secret, stateDir, runner: { health: async () => {}, execute: async () => { throw new Error(); } } }), /UNMETERED/);
      if (process.platform !== "linux") {
        const runner = new LinuxWorkerEndpointRunner({ tenantNamespace: "tenant-a", stateDir, worktreeBaseDir: join(stateDir, "workspaces"), baselineCommitRegistry: {}, adapter: { runtimeId: "fake-agent-harness", writerProvider: "emulator", writerModel: "provider-free", prepareInvocation: async () => { throw new Error("must not prepare"); }, parseExecutionResult: async () => { throw new Error(); } } });
        await assert.rejects(runner.health(AbortSignal.timeout(1000)), /STRICT_LINUX_UNAVAILABLE/);
      }
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
  it("Core broker -> actual endpoint -> controlled artifact import preserves main and external provenance", async () => {
    const endpoint = await fixture(); const store = new SoftwareFactoryControlPlaneStore(); const fx = await deploymentFixture(store, {});
    try {
      const core = new CoreApiService(store, { authenticator: fx.core.authenticator, executionTargets: { connectors: { worker: endpoint.connector }, testOnlyEmulator: true } });
      const profile = await core.upsertAgentOrganizationProfile(fx.projectId, fx.human, { profile_key: "worker", role: "DEVELOPER", principal_id: "worker-principal", provider: "emulator", model: "provider-free", execution_target_type: "user_managed_worker", trust_tier: "TIER_2_USER_MANAGED", target_locator: "worker" });
      const task = await core.createTask(fx.projectId, fx.developer, { title: "Private title", task_contract: { allowed_files: ["src/**"] } });
      await core.assignTaskExecutionTarget(fx.projectId, fx.human, task.task_id, { profile_id: profile.profile_id, data_classification: "PUBLIC", public_context: "Public code task" });
      const request = { execution_request_id: randomUUID() }; const imported = await core.executeTaskOnTarget(fx.projectId, fx.developer, task.task_id, request); assert.equal(imported.status, "IMPORTED");
      assert.equal((await core.executeTaskOnTarget(fx.projectId, fx.developer, task.task_id, request)).submission_id, imported.submission_id); assert.equal(endpoint.calls(), 1);
      assert.equal(fx.git(["rev-parse", "main"]), fx.release.main_head_commit_hash);
      const receipt = await store.withRlsTransaction(fx.scope, () => store.getCodeImportSubmission(imported.lease_id)); assert.ok(receipt); assert.equal(fx.git(["show", `${receipt.agent_commit_hash}:src/result.ts`]), "export const result = 42;");
    } finally { await endpoint.close(); fx.cleanup(); }
  });
});
