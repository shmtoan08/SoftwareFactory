import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { LinuxWorkerEndpointRunner, createWorkerEndpointServer, WorkerExecutionJournal, type WorkerEndpointServer } from "@software-factory/wna";
import { UserManagedWorkerHttpConnector, type AgentRuntimeAdapter, type ExternalTargetAction } from "@software-factory/adapter-sdk";

const cgroupRoot = process.env.SF_WORKER_TEST_CGROUP_ROOT;
if (process.platform !== "linux" || process.getuid?.() !== 0 || !cgroupRoot) throw new Error("Strict Linux worker acceptance requires root and SF_WORKER_TEST_CGROUP_ROOT; skips are forbidden");
async function waitFor(check: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Kernel cleanup condition timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sf-m6c3-a-real-kernel-")); chmodSync(root, 0o755);
  const repo = join(root, "public-repo"); mkdirSync(repo, { mode: 0o755 }); mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/value.txt"), "baseline\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Kernel test", GIT_AUTHOR_EMAIL: "kernel@example.test", GIT_COMMITTER_NAME: "Kernel test", GIT_COMMITTER_EMAIL: "kernel@example.test" }, stdio: "pipe" }).trim();
  git(["init", "--initial-branch=main"]); git(["add", "."]); git(["commit", "-m", "public baseline"]); const commit = git(["rev-parse", "HEAD"]);
  const stateDir = join(root, "state"); mkdirSync(stateDir, { mode: 0o700 }); writeFileSync(join(stateDir, "service-secret"), "SERVICE_SECRET_CANARY");
  const outside = join(root, "outside"); mkdirSync(outside, { mode: 0o777 }); chmodSync(outside, 0o777);
  return { root, repo, commit, stateDir, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function adapter(script: string): AgentRuntimeAdapter {
  return { runtimeId: "fake-agent-harness", writerProvider: "emulator", writerModel: "provider-free", prepareInvocation: async () => ({ binaryPath: process.execPath, args: ["-e", script], sanitizedEnv: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, timeoutMs: 3000 }), parseExecutionResult: async () => { throw new Error("Artifact runner must not parse untrusted Git metadata"); } };
}
describe("M6C-3 strict external Linux worker (no skips)", () => {
  it("actual runner enforces workspace-only writes, strips secrets and exports artifacts after kernel cleanup", async () => {
    const fx = fixture(); let server: WorkerEndpointServer | undefined; const prior = process.env.SF_TARGET_SIGNING_KEY; process.env.SF_TARGET_SIGNING_KEY = "PARENT_SECRET_CANARY";
    try {
      const script = `const fs=require('node:fs'),assert=require('node:assert/strict');
        assert.equal(process.getuid()===0,false);
        assert.equal(Object.values(process.env).some(v=>v.includes('PARENT_SECRET_CANARY')),false);
        assert.throws(()=>fs.readFileSync(${JSON.stringify(join(fx.stateDir, "service-secret"))}));
        assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(fx.outside, "escape"))},'escape'));
        fs.appendFileSync('.git/config','\\n[core]\\n fsmonitor = touch ${join(fx.outside, "host-exec")}\\n');
        fs.writeFileSync('src/value.txt','implemented\\n');`;
      const runner = new LinuxWorkerEndpointRunner({ tenantNamespace: "kernel-test", stateDir: fx.stateDir, worktreeBaseDir: join(fx.root, "workspaces"), baselineCommitRegistry: { [fx.commit]: fx.repo }, cgroupRoot, adapter: adapter(script) });
      const signingSecret = randomBytes(32).toString("hex");
      server = createWorkerEndpointServer({ tenantNamespace: "kernel-test", principalId: "real-worker", workerId: "real-worker", provider: "emulator", model: "provider-free", signingSecret, stateDir: fx.stateDir, runner });
      const { endpoint } = await server.listen();
      const connector = new UserManagedWorkerHttpConnector({ endpoint, signingSecret, principalId: "real-worker", workerId: "real-worker", provider: "emulator", model: "provider-free", testOnlyLoopback: true });
      await connector.health(AbortSignal.timeout(10000));
      const action: ExternalTargetAction = { execution_id: randomUUID(), task_id: randomUUID(), lease_epoch: 1, base_main_commit_hash: fx.commit, deadline: new Date(Date.now() + 20000).toISOString(), allowed_files: ["src/**"], public_context: "Implement public value" };
      const imported = await connector.execute(action, AbortSignal.timeout(20000));
      const record = new WorkerExecutionJournal(fx.stateDir, "kernel-test").read(action);
      assert.equal(record?.status, "COMPLETED"); assert.ok(record?.cleanupEvidence);
      const result = { submission: imported, cleanupEvidence: record.cleanupEvidence };
      assert.equal(result.submission.kind, "artifact"); assert.equal(result.cleanupEvidence.isSimulated, false); assert.equal(result.cleanupEvidence.realKernelOperationsExecuted, true); assert.equal(result.cleanupEvidence.populatedZeroVerified, true); assert.equal(result.cleanupEvidence.cgroupDirRemoved, true); assert.equal(result.cleanupEvidence.remainingProcsCount, 0);
      assert.equal(existsSync(join(fx.outside, "escape")), false); assert.equal(existsSync(join(fx.outside, "host-exec")), false);
      assert.equal(readFileSync(join(fx.repo, "src/value.txt"), "utf8"), "baseline\n");
      if (result.submission.kind === "artifact") assert.equal(Buffer.from((result.submission.files[0] as { content_base64: string }).content_base64, "base64").toString(), "implemented\n");
    } finally { await server?.close(); if (prior === undefined) delete process.env.SF_TARGET_SIGNING_KEY; else process.env.SF_TARGET_SIGNING_KEY = prior; fx.cleanup(); }
  });
  for (const mode of ["coordinator-death", "native-timeout"] as const) {
    it(`native supervisor cleans its real cgroup after ${mode}, including detached descendants`, async () => {
      const fx = fixture(); const taskId = randomUUID(); const workspace = join(fx.root, "worker"); mkdirSync(workspace, { mode: 0o777 }); chmodSync(workspace, 0o777);
      const scope = join(cgroupRoot!, "software-factory.slice", `sf-task-${taskId}-epoch-1.scope`);
      const script = `import {LinuxCgroupV2SandboxBackend} from '@software-factory/wna';
        const backend=new LinuxCgroupV2SandboxBackend({cgroupRoot:${JSON.stringify(cgroupRoot)}});
        const result=backend.spawnRealProcessInSandbox({taskId:${JSON.stringify(taskId)},leaseEpoch:1,command:${JSON.stringify(process.execPath)},args:['-e',${JSON.stringify(`require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>{},60000);`)}],sanitizedEnv:{PATH:'/usr/bin:/bin'},cwd:${JSON.stringify(workspace)},worktreePath:${JSON.stringify(workspace)},requireKernelCgroup:true,requireSubreaper:true,requireNamespaceIsolation:true,dropPrivileges:true,externalWorkerGuard:{maxRuntimeMs:${mode === "native-timeout" ? 1000 : 10000}}});
        console.log('READY');
        const exit=await result.exitPromise;
        const proof=await backend.killAndVerifyClean(${JSON.stringify(taskId)},1);
        console.log(JSON.stringify({exit:exit.code,populatedZeroVerified:proof.populatedZeroVerified,cgroupDirRemoved:proof.cgroupDirRemoved}));`;
      const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
      child.stdout.on("data", (s) => { stdout += s; }); child.stderr.on("data", (s) => { stderr += s; });
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      try {
        await waitFor(() => stdout.includes("READY") || child.exitCode !== null); assert.ok(stdout.includes("READY"), stderr);
        if (mode === "coordinator-death") { child.kill("SIGKILL"); await exited; await waitFor(() => !existsSync(scope)); }
        else { assert.equal(await exited, 0, stderr); const proof = JSON.parse(stdout.trim().split("\n").at(-1)!); assert.equal(proof.exit, 124); assert.equal(proof.populatedZeroVerified, true); assert.equal(proof.cgroupDirRemoved, true); }
        assert.equal(existsSync(scope), false);
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); fx.cleanup(); }
    });
  }
});
