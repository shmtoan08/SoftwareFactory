import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync, lstatSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { CodexCliAdapter, loadAgentRuntimeAdapterFromEnv, type AgentTaskContext } from "@software-factory/adapter-sdk";
import { CoreApiService, CoreApiHttpServer, HttpCoreApiClient, HttpCoreApiError, CORE_API_AUTH_HEADER, encodeCoreApiAuthHeader } from "@software-factory/core-api";
import { type ControlPlaneStore, SoftwareFactoryControlPlaneStore, PostgresControlPlaneRepository,
  PostgresRuntimePool, buildPostgresPoolConfigFromEnv, type RlsSessionContext } from "@software-factory/database";
import { CodeImportError, prepareCodeImport, type CodeImportSubmission, type TaskContractSpec } from "@software-factory/task-contract";
import { AgentGatewayService, AgentGatewayHttpServer, EphemeralGitPushTokenService } from "@software-factory/agent-gateway";
import { WnaWorkerDaemon, LocalOutboxBuffer, LinuxCgroupV2SandboxBackend } from "@software-factory/wna";
import { Docker3TierVerifier, ImmutableSourceSnapshotStore } from "@software-factory/verifier";
import { computeDirectorySha256, type TaskLeaseRecord } from "@software-factory/shared-types";
import { WebApprovalConsoleController } from "../../../apps/web/src/index.ts";

const CHANGED = "export function add(a, b) { return a + b; }\n";
const AGENT_TEST = 'import assert from "node:assert/strict"; import { add } from "../src/calculator.mjs"; assert.equal(add(2, 3), 5);\n';
const B64 = (text: string | Buffer) => Buffer.from(text).toString("base64");
const scope = (projectId: string) => ({ currentProjectId: projectId, currentPrincipalId: "operator", currentRole: "core_api_service" as const });
function git(cwd: string, args: string[], input?: string | Buffer, extraEnv: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, input, encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "M6C", GIT_AUTHOR_EMAIL: "m6c@example.test", GIT_COMMITTER_NAME: "M6C", GIT_COMMITTER_EMAIL: "m6c@example.test", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function writable(path: string) {
  const stat = lstatSync(path); if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) { chmodSync(path, 0o755); for (const name of readdirSync(path)) writable(join(path, name)); }
  else chmodSync(path, 0o644);
}
async function fixture(store: ControlPlaneStore = new SoftwareFactoryControlPlaneStore(), override: Partial<TaskContractSpec> = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-m6c2-")); const work = join(root, "author"); const repo = join(root, "target.git");
  mkdirSync(work); git(work, ["init", "-b", "main"]); mkdirSync(join(work, "src")); mkdirSync(join(work, "tests/protected"), { recursive: true });
  writeFileSync(join(work, "src/calculator.mjs"), "export function add(a, b) { return a - b; }\n");
  writeFileSync(join(work, "src/deletions.txt"), "baseline line\n".repeat(5));
  writeFileSync(join(work, "tests/protected/baseline.test.mjs"), 'import assert from "node:assert/strict"; import { add } from "../../src/calculator.mjs"; assert.equal(typeof add, "function");\n');
  git(work, ["add", "."]); git(work, ["commit", "-m", "baseline"]); const base = git(work, ["rev-parse", "HEAD"]);
  git(root, ["clone", "--bare", work, repo]);
  const trusted = join(root, "trusted"); mkdirSync(trusted);
  writeFileSync(join(trusted, "acceptance.test.mjs"), 'import assert from "node:assert/strict"; import { join } from "node:path"; const { add } = await import(join(process.cwd(), "src/calculator.mjs")); assert.equal(add(2, 3), 5);\n');
  const contract: TaskContractSpec = { allowed_files: ["src/**", "test/**"], protected_paths: ["tests/protected/**"],
    forbidden_paths: ["private/**"], max_changed_files: 4, max_deleted_lines: 20, max_binary_bytes: 1024,
    trusted_policy_sha256: computeDirectorySha256(trusted), ...override };
  const projectId = randomUUID();
  await store.withRlsTransaction({ currentRole: "system_admin_role", currentPrincipalId: "bootstrap" }, async () => {
    await store.createProject({ project_id: projectId, slug: `m6c2-${projectId}`, name: "M6C-2", repo_bare_path: repo, initial_main_commit_hash: base });
    for (const [principal_id, member_role] of [["operator", "ORG_ADMIN"], ["developer", "DEVELOPER"], ["auditor", "AUDITOR"]] as const)
      await store.addProjectMembership({ project_id: projectId, principal_id, member_role });
  });
  const snapshots = new ImmutableSourceSnapshotStore({ storageDir: join(root, "snapshots") });
  const core = new CoreApiService(store, { snapshotStore: snapshots, env: {} });
  const auth = core.issueAuthContext({ projectId, principalId: "operator", roles: ["ORG_ADMIN"] });
  const auditor = core.issueAuthContext({ projectId, principalId: "auditor", roles: ["AUDITOR"] });
  const gateway = new AgentGatewayService({ store, projectId, workerPrincipalId: "import-worker" });
  const taskLease = async () => {
    const task = await core.createTask(projectId, auth, { title: "Implement add", task_contract: contract, base_main_commit_hash: base });
    const lease = await core.dispatchTaskLease(projectId, auth, { task_id: task.task_id, worker_id: "import-worker" });
    return { task, lease };
  };
  return { root, work, repo, base, trusted, contract, projectId, store, core, auth, auditor, snapshots, gateway, taskLease,
    cleanup() { writable(root); rmSync(root, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function submissionFromIndex(f: Fixture, kind: CodeImportSubmission["kind"], operations?: readonly { path: string; content: Buffer | null; mode?: string }[]): CodeImportSubmission {
  const env = { GIT_INDEX_FILE: join(f.root, `index-${randomUUID()}`) };
  const g = (args: string[], input?: string | Buffer) => git(f.work, args, input, env);
  const ops = operations ?? [{ path: "src/calculator.mjs", content: Buffer.from(CHANGED) }, { path: "test/agent.test.mjs", content: Buffer.from(AGENT_TEST) }];
  g(["read-tree", f.base]);
  for (const op of ops) {
    const blob = op.content === null ? "0".repeat(40) : g(["hash-object", "-w", "--stdin"], op.content);
    g(["update-index", "-z", "--index-info"], `${op.content === null ? "0" : ("mode" in op ? op.mode : undefined) ?? "100644"} ${blob}\t${op.path}\0`);
  }
  const tree = g(["write-tree"]); const commit = g(["commit-tree", tree, "-p", f.base], "submission\n");
  g(["update-ref", "refs/heads/submission", commit]);
  if (kind === "bundle") {
    const file = join(f.root, `upload-${randomUUID()}.bundle`); g(["bundle", "create", file, "submission", `^${f.base}`]);
    return { kind, bundle_base64: B64(readFileSync(file)), agent_commit_hash: commit };
  }
  if (kind === "patch") return { kind, patch: execFileSync("git", ["diff", "--binary", f.base, commit], { cwd: f.work, encoding: "utf8" }) };
  return { kind, files: ops.map((op) => op.content === null ? { action: "delete" as const, path: op.path }
    : { action: "write" as const, path: op.path, content_base64: B64(op.content),
      mode: ("mode" in op ? op.mode : undefined) as "100644" | "100755" | undefined }) };
}
function submit(f: Fixture, lease: TaskLeaseRecord, submission: CodeImportSubmission) {
  return f.core.submitCodeImport(f.projectId, f.auth, { task_id: lease.task_id, lease_id: lease.lease_id, lease_epoch: lease.lease_epoch, submission });
}
async function happyImports(store: ControlPlaneStore, fullPipeline = false) {
  for (const kind of ["bundle", "patch", "artifact"] as const) {
    const f = await fixture(store);
    try {
      const { task, lease } = await f.taskLease();
      const outbox = new LocalOutboxBuffer({ projectId: f.projectId, taskId: task.task_id, attemptNo: lease.attempt_no,
        leaseId: lease.lease_id, leaseEpoch: lease.lease_epoch, workerId: lease.worker_id, sandboxBackend: new LinuxCgroupV2SandboxBackend(), outboxDir: join(f.root, "outbox") });
      outbox.enqueueEvent("task.accepted", {}); outbox.enqueueEvent("task.started", {}); await outbox.sendOrReplay(f.gateway);
      const submission = submissionFromIndex(f, kind);
      const receipts = await Promise.all([submit(f, lease, submission), submit(f, lease, submission)]);
      const receipt = receipts[0]!;
      assert.equal(receipts[1]!.submission_id, receipt.submission_id); assert.equal(receipt.source_type, kind);
      assert.equal(git(f.repo, ["rev-parse", receipt.staging_ref]), receipt.agent_commit_hash);
      assert.equal(git(f.repo, ["rev-parse", "main"]), f.base);
      assert.equal(git(f.repo, ["show", `${receipt.agent_commit_hash}:src/calculator.mjs`]), CHANGED.trim());
      await assert.rejects(submit(f, lease, { kind: "artifact", files: [{ action: "write", path: "src/other.mjs", content_base64: B64("other\n") }] }),
        (error: unknown) => error instanceof CodeImportError && error.code === "ERR_IMPORT_PAYLOAD_CONFLICT");
      if (!fullPipeline) continue;
      outbox.enqueueEvent("task.completed", { agent_commit_hash: receipt.agent_commit_hash,
        verified_tree_hash: receipt.verified_tree_hash, staging_ref: receipt.staging_ref });
      await outbox.sendOrReplay(f.gateway);
      // Exact retry is still a read-only receipt lookup after lease completion.
      assert.equal((await submit(f, lease, submission)).submission_id, receipt.submission_id);
      const verified = await f.core.buildAndVerifyMergeCandidateFromGit(f.projectId, f.auth, {
        task_id: task.task_id, lease_id: lease.lease_id, lease_epoch: lease.lease_epoch, staging_ref: receipt.staging_ref,
        agent_commit_hash: receipt.agent_commit_hash, repo_path: f.repo, trusted_acceptance_dir: f.trusted,
        verifier: new Docker3TierVerifier({ snapshotStore: f.snapshots }), execution_mode: "subprocess", network_disabled: true,
        tier1_command: { command: process.execPath, args: [join(f.trusted, "acceptance.test.mjs")] },
        tier2_command: { command: process.execPath, args: ["tests/protected/baseline.test.mjs"] },
        tier3_command: { command: process.execPath, args: ["test/agent.test.mjs"] }, tier3_test_files: ["test/agent.test.mjs"],
      });
      if (!verified.ok) throw new Error(verified.conflictSummary);
      assert.equal(verified.finalRun.verdict, "PASS");
      const reviewed = await f.core.runIndependentReview(f.projectId, f.auth, {
        task_id: task.task_id, merge_candidate_id: verified.mergeCandidate.merge_candidate_id,
        verification_run_id: verified.finalRun.verification_run_id, agent_gateway: f.gateway,
        reviewer_principal_id: "independent-reviewer", reviewer_agent_profile_id: "reviewer-profile",
        reviewer_provider: "google", reviewer_model: "test-reviewer", writer_provider: "openai", writer_model: "test-coder",
        developer_principal_id: "coder", developer_session_id: "coder-session", developer_credential_id: "coder-credential",
        developer_agent_profile_id: "coder-profile", repo_path: f.repo, tier3_test_files: ["test/agent.test.mjs"],
        evaluator: () => ({ verdict: "PASS" }),
      });
      assert.equal(reviewed.reviewArtifact.verdict, "PASS");
      const approval = await new WebApprovalConsoleController(f.core).approveCandidateWith8FieldBinding({ auth: f.auth,
        candidate: verified.mergeCandidate, verificationRun: verified.finalRun, reviewArtifact: reviewed.reviewArtifact });
      await f.core.enqueueMerge(f.projectId, f.auth, { task_id: task.task_id,
        merge_candidate_id: verified.mergeCandidate.merge_candidate_id, approval_id: approval.approval_id });
      assert.equal((await f.core.drainMergeQueue(f.projectId, f.auth, { require_real_git: true }))?.status, "MERGED");
      assert.equal(git(f.repo, ["rev-parse", "main"]), verified.mergeCandidate.merge_candidate_hash);
      assert.equal((await f.core.getTask(f.projectId, f.auth, task.task_id))?.status, "MergedAndCompleted");
      const lineage = await f.core.getCandidateBoundLineage(f.projectId, f.auth, { task_id: task.task_id });
      assert.equal(lineage.lineageComplete, true); assert.equal(lineage.codeImportSubmission?.submission_id, receipt.submission_id);
    } finally { f.cleanup(); }
  }
}

async function receiptFailureChecks(store: ControlPlaneStore) {
  const f = await fixture(store);
  const originalReceipt = store.recordCodeImportSubmission.bind(store);
  const originalTx = store.withRlsTransaction.bind(store);
  try {
    const { lease } = await f.taskLease(); const submission = submissionFromIndex(f, "artifact");
    store.recordCodeImportSubmission = () => { throw new Error("injected receipt persistence failure"); };
    await assert.rejects(submit(f, lease, submission));
    assert.throws(() => git(f.repo, ["rev-parse", "--verify", `refs/factory/Verify/${lease.task_id}/${lease.lease_epoch}`]));
    assert.equal((await store.withRlsTransaction(scope(f.projectId), () => store.getVerifiedImportsForTask(lease.task_id))).length, 0);
    store.recordCodeImportSubmission = originalReceipt;
    let lostResponse = true;
    store.withRlsTransaction = async <T>(ctx: Partial<RlsSessionContext>, fn: () => T | Promise<T>): Promise<T> => {
      const result = await originalTx(ctx, fn);
      if (lostResponse && result && typeof result === "object" && "submission_id" in result) {
        lostResponse = false; throw new Error("simulated lost COMMIT response");
      }
      return result;
    };
    const receipt = await submit(f, lease, submission); assert.equal(receipt.source_type, "artifact");
    store.withRlsTransaction = originalTx;
    assert.equal((await submit(f, lease, submission)).submission_id, receipt.submission_id);
    await f.core.revokeTaskLease(f.projectId, f.auth, { task_id: lease.task_id, lease_id: lease.lease_id, reason: "fixture receipt scenario complete", requeueTask: true });
    // A retry commits immediately after the failed caller's recovery transaction
    // returns. Compensation must already be complete while its lease lock is held.
    const retryRace = await f.taskLease();
    let retryWon: Awaited<ReturnType<typeof submit>> | undefined;
    let recoverRetry = true;
    store.recordCodeImportSubmission = () => {
      store.recordCodeImportSubmission = originalReceipt;
      throw new Error("injected failure before concurrent retry");
    };
    store.withRlsTransaction = async <T>(ctx: Partial<RlsSessionContext>, fn: () => T | Promise<T>): Promise<T> => {
      const result = await originalTx(ctx, fn);
      if (recoverRetry && result === null) {
        recoverRetry = false;
        retryWon = await submit(f, retryRace.lease, submission);
      }
      return result;
    };
    await assert.rejects(submit(f, retryRace.lease, submission));
    store.withRlsTransaction = originalTx;
    assert.ok(retryWon);
    assert.equal(git(f.repo, ["rev-parse", retryWon.staging_ref]), retryWon.agent_commit_hash);
    await f.core.revokeTaskLease(f.projectId, f.auth, { task_id: retryRace.lease.task_id, lease_id: retryRace.lease.lease_id, reason: "fixture retry scenario complete", requeueTask: true });
    const concurrent = await f.taskLease();
    const raced = await Promise.allSettled([submit(f, concurrent.lease, submission), submit(f, concurrent.lease,
      { kind: "artifact", files: [{ action: "write", path: "src/other.mjs", content_base64: B64("other\n") }] })]);
    assert.equal(raced.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const accepted = raced.find((attempt) => attempt.status === "fulfilled"); assert.ok(accepted?.status === "fulfilled");
    assert.equal(git(f.repo, ["rev-parse", accepted.value.staging_ref]), accepted.value.agent_commit_hash);
    await f.core.revokeTaskLease(f.projectId, f.auth, { task_id: concurrent.lease.task_id, lease_id: concurrent.lease.lease_id, reason: "fixture concurrent scenario complete", requeueTask: true });
    const revoked = await f.taskLease();
    await f.core.revokeTaskLease(f.projectId, f.auth, { task_id: revoked.task.task_id, lease_id: revoked.lease.lease_id, reason: "revoked", requeueTask: true });
    await assert.rejects(submit(f, revoked.lease, submission), (error: unknown) => error instanceof CodeImportError && error.code === "ERR_IMPORT_STALE_LEASE");
  } finally { store.recordCodeImportSubmission = originalReceipt; store.withRlsTransaction = originalTx; f.cleanup(); }
}

function writeCodexEmulator(root: string): string {
  const program = join(root, "codex-emulator.mjs");
  writeFileSync(program, `import { execFileSync } from 'node:child_process'; import { mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
const args=process.argv.slice(2); if(args[0]!=='exec'||!args.includes('--json')||!args.includes('--ephemeral')) process.exit(2);
if(process.env.CODEX_API_KEY!=='scoped-provider-test-credential'||process.env.SF_WNA_PRIVATE_KEY||process.env.DATABASE_URL) process.exit(3);
const cwd=args[args.indexOf('--cd')+1]; mkdirSync(join(cwd,'test'),{recursive:true});
writeFileSync(join(cwd,'src/calculator.mjs'),${JSON.stringify(CHANGED)}); writeFileSync(join(cwd,'test/agent.test.mjs'),${JSON.stringify(AGENT_TEST)});
const git=(args)=>execFileSync('git',args,{cwd,stdio:'pipe'}); git(['add','src/calculator.mjs','test/agent.test.mjs']);
git(['-c','user.name=Codex emulator','-c','user.email=codex@example.test','commit','-m','implement add']);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done, claimed hash '+ 'f'.repeat(40)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));`);
  const executable = join(root, "codex");
  writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${program.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  return executable;
}

async function securityMatrix(store: ControlPlaneStore) {
  const f = await fixture(store, { max_changed_files: 2, max_deleted_lines: 1 });
  try {
    const cases = [
      { name: "out of scope", ops: [{ path: "outside.txt", content: Buffer.from("outside\n") }] },
      { name: "protected rename source", ops: [
        { path: "tests/protected/baseline.test.mjs", content: null },
        { path: "src/copied.mjs", content: readFileSync(join(f.work, "tests/protected/baseline.test.mjs")) }] },
      { name: "binary", ops: [{ path: "src/binary.bin", content: Buffer.from([0, 1, 2]) }] },
      { name: "oversized blob", ops: [{ path: "src/large.txt", content: Buffer.alloc(1025, "a") }] },
      { name: "excessive deletion", ops: [{ path: "src/deletions.txt", content: null }] },
      { name: "forbidden case", ops: [{ path: "src/secret.KEY", content: Buffer.from("forbidden\n") }] },
      { name: "abnormal diff", ops: ["a", "b", "c"].map((x) => ({ path: `src/${x}.txt`, content: Buffer.from(x) })) },
      { name: "case collision with baseline", ops: [{ path: "src/CALCULATOR.mjs", content: Buffer.from("collision\n") }] },
      { name: "control character", ops: [{ path: "src/new\nfile.mjs", content: Buffer.from("unsafe\n") }] },
      { name: "Git metadata", ops: [{ path: ".gitattributes", content: Buffer.from("* diff=unsafe\n") }] },
    ];
    for (const kind of ["bundle", "patch", "artifact"] as const) {
      for (const scenario of cases) {
        const { lease } = await f.taskLease();
        const submission = submissionFromIndex(f, kind, scenario.ops);
        await assert.rejects(submit(f, lease, submission), (error: unknown) => error instanceof CodeImportError, `${kind}: ${scenario.name}`);
        assert.equal(git(f.repo, ["rev-parse", "main"]), f.base);
        assert.equal(await store.withRlsTransaction(scope(f.projectId), () => store.getCodeImportSubmission(lease.lease_id)), null);
        assert.throws(() => git(f.repo, ["rev-parse", "--verify", `refs/factory/Verify/${lease.task_id}/${lease.lease_epoch}`]));
        await f.core.revokeTaskLease(f.projectId, f.auth, { task_id: lease.task_id, lease_id: lease.lease_id, reason: "fixture rejected transport complete", requeueTask: true });
      }
      for (const mode of ["120000", "160000"]) {
        const { lease } = await f.taskLease();
        // A gitlink points to the existing base commit; a symlink stores path text.
        if (kind === "artifact") {
          await assert.rejects(submit(f, lease, { kind, files: [{ action: "write", path: "src/link", content_base64: B64("target"), mode: mode as "100644" }] }));
          await f.core.revokeTaskLease(f.projectId, f.auth, { task_id: lease.task_id, lease_id: lease.lease_id, reason: "fixture rejected mode complete", requeueTask: true });
        } else {
          const modeEnv = { GIT_INDEX_FILE: join(f.root, `mode-index-${randomUUID()}`) };
          git(f.work, ["read-tree", f.base], undefined, modeEnv);
          const blob = mode === "160000" ? f.base : git(f.work, ["hash-object", "-w", "--stdin"], "../../private");
          git(f.work, ["update-index", "-z", "--index-info"], `${mode} ${blob}\tsrc/link\0`, modeEnv);
          const tree = git(f.work, ["write-tree"], undefined, modeEnv); const commit = git(f.work, ["commit-tree", tree, "-p", f.base], "malicious mode\n");
          git(f.work, ["update-ref", "refs/heads/submission", commit]);
          let submission: CodeImportSubmission;
          if (kind === "patch") submission = { kind, patch: execFileSync("git", ["diff", "--binary", f.base, commit], { cwd: f.work, encoding: "utf8" }) };
          else { const path = join(f.root, `${randomUUID()}.bundle`); git(f.work, ["bundle", "create", path, "submission", `^${f.base}`]); submission = { kind, bundle_base64: B64(readFileSync(path)), agent_commit_hash: commit }; }
          await assert.rejects(submit(f, lease, submission));
          await f.core.revokeTaskLease(f.projectId, f.auth, { task_id: lease.task_id, lease_id: lease.lease_id, reason: "fixture rejected mode complete", requeueTask: true });
        }
      }
    }
  } finally { f.cleanup(); }
}

describe("M6C-2 runtime adapter and extended controlled imports", () => {
  it("Codex adapter contract: explicit config, clean environment, real Git hashes and fail-closed results", async () => {
    const f = await fixture();
    try {
      const { task, lease } = await f.taskLease(); const executable = writeCodexEmulator(f.root);
      const adapter = loadAgentRuntimeAdapterFromEnv({ SF_AGENT_RUNTIME: "codex-cli", SF_AGENT_MODEL: "codex-test-model",
        SF_AGENT_BINARY: executable, SF_CODEX_API_KEY: "scoped-provider-test-credential" }, { testOnlyEmulator: true });
      const agentWork = join(f.root, "codex-linked-worktree");
      git(f.work, ["worktree", "add", "--detach", agentWork, f.base]);
      const ctx: AgentTaskContext = { projectId: f.projectId, taskId: task.task_id, leaseId: lease.lease_id, leaseEpoch: lease.lease_epoch,
        worktreePath: agentWork, baseMainCommitHash: f.base, taskTitle: "Implement add", taskContract: f.contract,
        hostEnvironmentToSanitize: { CODEX_API_KEY: "host-secret", WORKER_NODE_CREDENTIAL: "host-credential", DATABASE_URL: "host-database" } };
      const plan = await adapter.prepareInvocation(ctx);
      assert.equal(adapter.runtimeId, "codex-cli"); assert.equal(adapter.writerProvider, "openai");
      assert.equal(plan.sanitizedEnv.CODEX_API_KEY, "scoped-provider-test-credential"); assert.equal(plan.sanitizedEnv.DATABASE_URL, undefined);
      assert.ok(plan.args.includes('shell_environment_policy.inherit="none"'));
      assert.ok(plan.args.includes('default_permissions="sf-worker"'));
      assert.equal(plan.args.includes("--sandbox"), false);
      // Optional provider-free smoke with a locally installed native Codex CLI.
      // The real sandbox executes the emulator's edits/commit, not a model call.
      const nativeSandbox = process.env.SF_TEST_CODEX_SANDBOX_BINARY;
      const permissionConfig = plan.args.find((arg) => arg.startsWith("permissions="))!;
      const nativeEnv = { ...plan.sanitizedEnv, PATH: `${dirname(process.execPath)}:${plan.sanitizedEnv.PATH}` };
      const stdout = nativeSandbox
        ? execFileSync(nativeSandbox, ["sandbox", "-P", "sf-worker", "-C", agentWork, "-c", permissionConfig,
          "--", plan.binaryPath, ...plan.args], { cwd: agentWork, env: nativeEnv, encoding: "utf8", timeout: 30_000 })
        : execFileSync(plan.binaryPath, [...plan.args], { cwd: agentWork, env: plan.sanitizedEnv, encoding: "utf8" });
      if (nativeSandbox) {
        const common = git(agentWork, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        assert.throws(() => execFileSync(nativeSandbox, ["sandbox", "-P", "sf-worker", "-C", agentWork, "-c", permissionConfig,
          "--", "/usr/bin/touch", join(common, "refs", "forbidden-native-write")], {
          cwd: agentWork, env: nativeEnv, timeout: 30_000, stdio: "pipe",
        }));
        assert.equal(existsSync(join(common, "refs", "forbidden-native-write")), false);
      }
      const result = await adapter.parseExecutionResult(ctx, 0, stdout, "");
      assert.equal(existsSync(plan.sanitizedEnv.HOME!), false);
      assert.equal(result.exitCode, 0); assert.equal(result.agentCommitHash, git(agentWork, ["rev-parse", "HEAD"]));
      assert.notEqual(result.agentCommitHash, "f".repeat(40)); assert.equal(result.verifiedTreeHash, git(agentWork, ["rev-parse", "HEAD^{tree}"]));
      for (const [exit, output] of [[0, "not json"], [0, '{"type":"turn.failed"}\n'], [1, stdout]] as const) {
        const bad = await adapter.parseExecutionResult(ctx, exit, output, "scoped-provider-test-credential");
        assert.equal(bad.agentCommitHash, null); assert.notEqual(bad.exitCode, 0); assert.equal(bad.stderrTail.includes("scoped-provider-test-credential"), false);
      }
      const monitorMarker = join(f.root, "fsmonitor-was-executed");
      git(agentWork, ["config", "core.fsmonitor", `!touch '${monitorMarker}'`]);
      assert.equal((await adapter.parseExecutionResult(ctx, 0, `clipped JSON fragment\n${stdout}`, "")).exitCode, 0);
      assert.throws(() => lstatSync(monitorMarker));
      writeFileSync(join(agentWork, "src/dirty.mjs"), "dirty\n");
      assert.equal((await adapter.parseExecutionResult(ctx, 0, stdout, "")).agentCommitHash, null);
      assert.throws(() => loadAgentRuntimeAdapterFromEnv({ SF_AGENT_RUNTIME: "unknown" }));
      assert.throws(() => loadAgentRuntimeAdapterFromEnv({ SF_AGENT_RUNTIME: "codex-cli" }));
      await assert.rejects(new CodexCliAdapter({ writerModel: "test" }).prepareInvocation(ctx));
      assert.equal(loadAgentRuntimeAdapterFromEnv({ SF_AGENT_RUNTIME: "claude-code-cli" }).runtimeId, "claude-code-cli");
    } finally { f.cleanup(); }
  });

  it("Codex runtime passes the real WNA lifecycle and controlled Git push using a CLI emulator", async () => {
    const f = await fixture(); const tokenService = new EphemeralGitPushTokenService();
    const http = new AgentGatewayHttpServer({ store: f.store, tokenService });
    try {
      const endpoint = await http.start();
      copyFileSync(resolve("scripts/git-hooks/pre-receive"), join(f.repo, "hooks/pre-receive")); chmodSync(join(f.repo, "hooks/pre-receive"), 0o755);
      const { task, lease } = await f.taskLease(); const executable = writeCodexEmulator(f.root);
      const daemon = new WnaWorkerDaemon({ testOnlyEmulator: true, gateway: f.gateway, worktreeBaseDir: join(f.root, "worktrees"), outboxDir: join(f.root, "outbox"),
        env: { SF_AGENT_RUNTIME: "codex-cli", SF_AGENT_MODEL: "test-codex", SF_AGENT_BINARY: executable, SF_CODEX_API_KEY: "scoped-provider-test-credential" } });
      const result = await daemon.executeLease({ task, lease, repoBarePath: f.repo, preReceiveUrl: endpoint.url,
        gitPushToken: tokenService.issueLeasePushToken({ projectId: f.projectId, taskId: task.task_id, leaseId: lease.lease_id,
          leaseEpoch: lease.lease_epoch, workerId: lease.worker_id }),
        // Tests exercise the adapter/process/Git contract. Linux isolation is tested separately by M2/M5.
        requireKernelCgroup: false, requireNamespaceIsolation: false, isolateNamespaces: false, dropPrivileges: false,
      });
      assert.equal(result.outcome, "COMPLETED", result.error);
      assert.ok(result.pushedCommitHash); assert.equal(git(f.repo, ["rev-parse", `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`]), result.pushedCommitHash);
      assert.equal(git(f.repo, ["rev-parse", "main"]), f.base);
      assert.ok(result.cleanupEvidence); assert.equal((await f.core.getTask(f.projectId, f.auth, task.task_id))?.status, "BuildingMergeCandidate");
      const blocked = await fixture();
      try {
        const pending = await blocked.taskLease();
        const production = new WnaWorkerDaemon({ gateway: blocked.gateway, worktreeBaseDir: join(blocked.root, "worker"), outboxDir: join(blocked.root, "outbox"),
          runtimeAdapter: new CodexCliAdapter({ writerModel: "test", binaryPath: executable, apiKey: "scoped-provider-test-credential", testOnlyEmulator: true }) });
        const denied = await production.executeLease({ task: pending.task, lease: pending.lease, repoBarePath: blocked.repo,
          gitPushToken: "unused-token", requireKernelCgroup: false, requireNamespaceIsolation: false, isolateNamespaces: false, dropPrivileges: false });
        assert.equal(denied.outcome, "FAILED"); assert.match(denied.error ?? "", /ERR_UNMETERED_CODEX_DISABLED/);
        assert.equal(denied.agentExecution, null);
        assert.equal(git(blocked.repo, ["rev-parse", "main"]), blocked.base);
        assert.throws(() => git(blocked.repo, ["rev-parse", `refs/factory/Verify/${pending.task.task_id}/1`]));
      } finally { blocked.cleanup(); }
    } finally { await http.close(); f.cleanup(); }
  });

  it("Bundle, Patch and Artifact imports traverse real candidate/verifier/reviewer/approval/CAS", () => happyImports(new SoftwareFactoryControlPlaneStore(), true));
  it("all three transports reject protected/out-of-scope paths, modes, binaries, oversized blobs, collisions and abnormal diffs", () => securityMatrix(new SoftwareFactoryControlPlaneStore()));

  it("normalization rejects traversal, malformed bundles/encodings and caller-controlled contract overrides", async () => {
    const f = await fixture();
    try {
      const { lease } = await f.taskLease();
      for (const submission of [
        { kind: "artifact", files: [{ action: "write", path: "../escape", content_base64: B64("unsafe") }] },
        { kind: "artifact", files: [{ action: "write", path: "src/a.txt", content_base64: "%%%=" }] },
        { kind: "patch", patch: "diff --git a/../escape b/../escape\nnew file mode 100644\n--- /dev/null\n+++ b/../escape\n@@ -0,0 +1 @@\n+unsafe\n" },
        { kind: "bundle", bundle_base64: B64("invalid bundle"), agent_commit_hash: "a".repeat(40) },
        { kind: "bundle", bundle_base64: B64(Buffer.alloc(2 * 1024 * 1024 + 1)), agent_commit_hash: "a".repeat(40) },
        { kind: "patch", patch: "x", contract: { allowed_files: ["**"] } },
      ]) await assert.rejects(submit(f, lease, submission as CodeImportSubmission));
      const correct = submissionFromIndex(f, "artifact");
      const first = prepareCodeImport({ repoPath: f.repo, baseCommitHash: f.base, taskId: lease.task_id,
        leaseEpoch: lease.lease_epoch, contract: f.contract, submission: correct });
      const second = prepareCodeImport({ repoPath: f.repo, baseCommitHash: f.base, taskId: lease.task_id,
        leaseEpoch: lease.lease_epoch, contract: f.contract, submission: correct });
      try { assert.equal(first.candidate.agent_commit_hash, second.candidate.agent_commit_hash); }
      finally { first.dispose(); second.dispose(); }
    } finally { f.cleanup(); }
  });

  it("receipt failures compensate Git/DB; lost commit responses reconcile; conflicting concurrent payloads are fenced", async () => {
    await receiptFailureChecks(new SoftwareFactoryControlPlaneStore());
  });

  it("expiry during normalization is rechecked; accepted imports recover without task.completed", async () => {
    let now = Date.now(); const store = new SoftwareFactoryControlPlaneStore(() => new Date(now)); const f = await fixture(store);
    try {
      const submission = submissionFromIndex(f, "artifact"); const first = await f.taskLease();
      const lock = store.withTaskLeaseLock.bind(store);
      store.withTaskLeaseLock = async <T>(projectId: string, taskId: string, leaseId: string, fn: () => Promise<T>): Promise<T> => {
        now += 36_000; return lock(projectId, taskId, leaseId, fn);
      };
      await assert.rejects(submit(f, first.lease, submission), (error: unknown) => error instanceof CodeImportError && error.code === "ERR_IMPORT_STALE_LEASE");
      store.withTaskLeaseLock = lock;
      assert.throws(() => git(f.repo, ["rev-parse", "--verify", `refs/factory/Verify/${first.task.task_id}/1`]));
      // An expired task remains in-flight until reconciliation releases it.
      await f.core.runOrphanedPushReconciler(f.projectId, f.auth);
      const second = await f.taskLease(); const receipt = await submit(f, second.lease, submission);
      now += 36_000;
      const recovered = await f.core.runOrphanedPushReconciler(f.projectId, f.auth);
      assert.ok(recovered.some((outcome) => outcome.task_id === second.task.task_id && outcome.outcome === "RECOVERED_ORPHANED_PUSH"));
      assert.equal((await f.core.getTask(f.projectId, f.auth, second.task.task_id))?.status, "BuildingMergeCandidate");
      assert.equal((await submit(f, second.lease, submission)).submission_id, receipt.submission_id);
    } finally { f.cleanup(); }
  });

  it("HTTP import endpoint enforces membership, tenant identity, payload limits and lease binding", async () => {
    const f = await fixture(); const foreign = await fixture(); const server = new CoreApiHttpServer({ coreApi: f.core });
    try {
      const { baseUrl } = await server.start(); const client = new HttpCoreApiClient(baseUrl); const { task, lease } = await f.taskLease();
      const input = { task_id: task.task_id, lease_id: lease.lease_id, lease_epoch: lease.lease_epoch, submission: submissionFromIndex(f, "patch") };
      for (const auth of [f.auditor, foreign.auth]) await assert.rejects(client.submitCodeImport(f.projectId, auth, input), (error: unknown) => error instanceof HttpCoreApiError && error.statusCode === 403);
      const receipt = await client.submitCodeImport(f.projectId, f.auth, input); assert.equal(receipt.project_id, f.projectId);
      assert.equal((await client.submitCodeImport(f.projectId, f.auth, input)).submission_id, receipt.submission_id);
      const response = await fetch(`${baseUrl}/api/v1/projects/${f.projectId}/tasks/${task.task_id}/imports`, {
        method: "POST", headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(f.auth), "content-type": "application/json" },
        body: JSON.stringify({ lease_id: lease.lease_id, lease_epoch: lease.lease_epoch,
          submission: { kind: "artifact", files: [{ action: "write", path: "src/too-large", content_base64: B64(Buffer.alloc(3 * 1024 * 1024)) }] } }) });
      assert.ok(response.status === 400 || response.status === 413);
      assert.equal(git(f.repo, ["rev-parse", "main"]), f.base);
    } finally { await server.stop(); f.cleanup(); foreign.cleanup(); }
  });

  it("PostgreSQL 0010: concurrent transport receipts, common security validation, tenant RLS and append-only grants", async (t) => {
    const config = buildPostgresPoolConfigFromEnv(); if (!config) { t.skip("Configure PGHOST/DATABASE_URL for the real PostgreSQL M6C-2 gate"); return; }
    const pool = new PostgresRuntimePool(config); const store = new PostgresControlPlaneRepository(pool);
    try {
      await happyImports(store); await securityMatrix(store); await receiptFailureChecks(store);
      const f = await fixture(store); const other = await fixture(store);
      try {
        const { lease } = await f.taskLease(); const receipt = await submit(f, lease, submissionFromIndex(f, "artifact"));
        assert.equal((await store.withRlsTransaction(scope(f.projectId), () => store.getCodeImportSubmission(lease.lease_id)))?.submission_id, receipt.submission_id);
        assert.equal(await store.withRlsTransaction(scope(other.projectId), () => store.getCodeImportSubmission(lease.lease_id)), null);
        assert.equal(await store.getCodeImportSubmission(lease.lease_id), null);
        await assert.rejects(store.withRlsTransaction(scope(f.projectId), () => pool.queryInActiveTx("UPDATE code_import_submissions SET payload_sha256 = repeat('0', 64);")));
        await assert.rejects(store.withRlsTransaction(scope(f.projectId), () => pool.queryInActiveTx("DELETE FROM code_import_submissions;")));
        const foreignLease = await other.taskLease();
        await assert.rejects(store.withRlsTransaction(scope(other.projectId), () => store.recordCodeImportSubmission({
          ...receipt, project_id: other.projectId, task_id: foreignLease.task.task_id, lease_id: foreignLease.lease.lease_id,
          lease_epoch: foreignLease.lease.lease_epoch,
          staging_ref: `refs/factory/Verify/${foreignLease.task.task_id}/${foreignLease.lease.lease_epoch}` })), (error: unknown) => (error as { sqlState?: string }).sqlState === "23503");
        const info = await store.withRlsTransaction(scope(f.projectId), () => pool.queryInActiveTx("SELECT relforcerowsecurity FROM pg_class WHERE relname = 'code_import_submissions';"));
        assert.equal(info.rows[0]?.relforcerowsecurity, true);
      } finally { f.cleanup(); other.cleanup(); }
    } finally { await pool.close(); }
  });
});
