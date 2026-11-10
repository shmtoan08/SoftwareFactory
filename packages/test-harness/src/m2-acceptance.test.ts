import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "../../shared-types/src/index.ts";
import {
  type TaskContractSpec,
  inspectRealGitCommitForImport,
  validateGitTreeImport,
} from "../../task-contract/src/index.ts";
import {
  type AgentRuntimeAdapter,
  type AgentTaskContext,
  ClaudeCodeCliAdapter,
  FORBIDDEN_SANDBOX_ENV_PATTERNS,
  TaskContextAssembler,
} from "../../adapter-sdk/src/index.ts";
import { SoftwareFactoryControlPlaneStore } from "../../database/src/index.ts";
import { LinuxCgroupV2SandboxBackend } from "../../wna/src/index.ts";
import { AgentGatewayService } from "../../../apps/agent-gateway/src/index.ts";
import { CoreApiService } from "../../../apps/core-api/src/index.ts";
import { FakeAgentHarnessAdapter } from "./index.ts";

const M2_CONTRACT: TaskContractSpec = {
  allowed_files: ["src/**/*.ts"],
  protected_paths: ["src/security/**", "src/baseline.test.ts"],
  forbidden_paths: ["secrets/**"],
  max_changed_files: 5,
  max_deleted_lines: 100,
  max_binary_bytes: 65_536,
  allow_binary_files: false,
};

const BASE_MAIN_SHA = "1111111111111111111111111111111111111111";
const BASE_TREE_SHA = "2222222222222222222222222222222222222222";

function createM2Environment(initialNow = new Date("2026-11-10T14:00:00.000Z")) {
  let currentNow = new Date(initialNow.getTime());
  const store = new SoftwareFactoryControlPlaneStore(() => currentNow);
  const advanceClockMs = (ms: number) => {
    currentNow = new Date(currentNow.getTime() + ms);
  };

  let projectId = "";
  store.withRlsTransaction(
    {
      currentRole: "system_admin_role",
      currentPrincipalId: "bootstrap-admin",
    },
    () => {
      const proj = store.createProject({
        project_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        slug: "m2-worker-plane",
        name: "Milestone M2 Project",
        repo_bare_path: "/var/lib/software-factory/repos/m2-worker-plane.git",
        initial_main_commit_hash: BASE_MAIN_SHA,
        initial_main_tree_hash: BASE_TREE_SHA,
      });
      projectId = proj.project_id;
    }
  );

  const coreApi = new CoreApiService(store);
  const gateway = new AgentGatewayService({
    store,
    projectId,
    workerPrincipalId: "wna-supervisor-node-01",
  });
  const sandboxBackend = new LinuxCgroupV2SandboxBackend();

  return {
    store,
    coreApi,
    gateway,
    sandboxBackend,
    projectId,
    advanceClockMs,
  };
}

describe("Milestone M2 Gate — Worker Plane, Linux Sandbox (Subreaper), Controlled Git Push Import & Adapter P-010", () => {
  it("M2-Gate-1 (Adversarial Scenario 7): Double-Fork Orphan & Sandbox Escape Defense (Mount Isolation, /etc/sf-wna Deny, Subreaper waitpid() & rmdir(cgroup))", async () => {
    const { sandboxBackend } = createM2Environment();
    const taskAId = "10000000-0000-4000-8000-000000000001";
    const taskBId = "20000000-0000-4000-8000-000000000002";
    const epoch = 1;
    const taskAWorktree = `/var/lib/software-factory/worktrees/${taskAId}/epoch-${epoch}`;
    const taskBWorktree = `/var/lib/software-factory/worktrees/${taskBId}/epoch-${epoch}`;

    // Spawn sandboxed process with a direct child and a double-forked grandchild
    sandboxBackend.spawnProcessInSandbox({
      taskId: taskAId,
      leaseEpoch: epoch,
      pid: 61001,
      childPids: [61002],
      worktreePath: taskAWorktree,
    });
    // Agent performs double-fork (`fork() -> setsid() -> fork() -> exit(0)`) attempting to escape supervision
    sandboxBackend.spawnDoubleForkOrphanInSandbox(taskAId, epoch, 61099);

    const meta = sandboxBackend.getSandboxSecurityMetadata(taskAId, epoch);
    assert.ok(meta);
    assert.equal(meta.supervisorUser, "sf-wna");
    assert.equal(meta.subreaperEnabled, true);
    assert.equal(meta.sandboxUser, "sf-task-runner");
    assert.deepEqual(meta.namespaces, ["mount", "pid", "ipc", "uts"]);

    // 1. Sandbox process can access its own worktree and /tmp
    assert.deepEqual(
      sandboxBackend.assertSandboxPathAccess(taskAId, epoch, `${taskAWorktree}/src/index.ts`),
      { allowed: true }
    );
    assert.deepEqual(
      sandboxBackend.assertSandboxPathAccess(taskAId, epoch, "/tmp/build-output.json"),
      { allowed: true }
    );

    // 2. Sandbox process is strictly blocked from reading /etc/sf-wna (WNA credentials)
    assert.throws(
      () => sandboxBackend.assertSandboxPathAccess(taskAId, epoch, "/etc/sf-wna/worker_credential.key"),
      /EACCES: Mount namespace isolation denied access to WNA credential path/
    );

    // 3. Sandbox process is strictly blocked from reading another task's worktree
    assert.throws(
      () => sandboxBackend.assertSandboxPathAccess(taskAId, epoch, `${taskBWorktree}/src/secret.ts`),
      /EACCES: Mount namespace isolation denied cross-worktree or host path access/
    );

    // 4. Execute killAndVerifyClean when lease is revoked/expired
    assert.equal(sandboxBackend.getActivePids(taskAId, epoch).length, 3);
    const cleanup = await sandboxBackend.killAndVerifyClean(taskAId, epoch);

    assert.equal(cleanup.freezeApplied, true);
    assert.equal(cleanup.cgroupKillWritten, true);
    assert.equal(cleanup.populatedZeroVerified, true);
    assert.equal(cleanup.remainingProcsCount, 0);
    assert.equal(cleanup.cgroupDirRemoved, true);
    assert.deepEqual(cleanup.subreaperWaitpidReapedPids, [61099]);
    assert.deepEqual(cleanup.killedPids, [61001, 61002, 61099]);
  });

  it("M2-Gate-2 (Adversarial Scenario 6): Malicious Git Push Blocked 100% at Pre-Receive Hook (Forbidden Ref, Outside Allowed, Protected Rename, Symlink, Submodule, Binary, Wipeout)", async () => {
    const { coreApi, gateway, projectId } = createM2Environment();
    const task = await coreApi.createTask(projectId, "op-1", {
      title: "M2 Gatekeeper adversarial push checks",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-m2-01",
    });

    const verifyRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
    const dummyCommit = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const dummyTree = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

    // 2a. Attempt to push directly to refs/heads/main -> Blocked
    const pushMain = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: "refs/heads/main",
      agent_commit_hash: dummyCommit,
      verified_tree_hash: dummyTree,
      parent_commit_hashes: [BASE_MAIN_SHA],
    });
    assert.equal(pushMain.allowed, false);
    assert.equal(pushMain.error_code, "ERR_GATEKEEPER_FORBIDDEN_REF");

    // 2b. Attempt to push file outside allowed_files (Default Deny) -> Blocked at pre-receive
    const pushOutsideAllowed = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: dummyCommit,
      verified_tree_hash: dummyTree,
      parent_commit_hashes: [BASE_MAIN_SHA],
      changes: [
        {
          path: "package.json",
          mode: "100644",
          size_bytes: 500,
          is_binary: false,
          added_lines: 2,
          deleted_lines: 1,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    assert.equal(pushOutsideAllowed.allowed, false);
    assert.equal(pushOutsideAllowed.error_code, "ERR_IMPORT_PATH_POLICY_VIOLATION");

    // 2c. Attempt to bypass protected_paths by renaming `src/security/auth.ts` -> `src/auth-copy.ts` -> Blocked!
    const pushRenameProtected = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: dummyCommit,
      verified_tree_hash: dummyTree,
      parent_commit_hashes: [BASE_MAIN_SHA],
      changes: [
        {
          path: "src/auth-copy.ts",
          old_path: "src/security/auth.ts",
          mode: "100644",
          size_bytes: 500,
          is_binary: false,
          added_lines: 0,
          deleted_lines: 0,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    assert.equal(pushRenameProtected.allowed, false);
    assert.equal(pushRenameProtected.error_code, "ERR_IMPORT_PATH_POLICY_VIOLATION");

    // 2d. Attempt to push malicious symlink (mode 120000) -> Blocked at pre-receive
    const pushSymlink = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: dummyCommit,
      verified_tree_hash: dummyTree,
      parent_commit_hashes: [BASE_MAIN_SHA],
      changes: [
        {
          path: "src/link-to-etc-passwd.ts",
          mode: "120000",
          size_bytes: 12,
          is_binary: false,
          added_lines: 1,
          deleted_lines: 0,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    assert.equal(pushSymlink.allowed, false);
    assert.equal(pushSymlink.error_code, "ERR_IMPORT_FORBIDDEN_GIT_MODE");

    // 2e. Attempt to push submodule (mode 160000) or .gitattributes -> Blocked at pre-receive
    const pushSubmodule = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: dummyCommit,
      verified_tree_hash: dummyTree,
      parent_commit_hashes: [BASE_MAIN_SHA],
      changes: [
        {
          path: "src/nested-repo",
          mode: "160000",
          size_bytes: 0,
          is_binary: false,
          added_lines: 1,
          deleted_lines: 0,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    assert.equal(pushSubmodule.allowed, false);
    assert.equal(pushSubmodule.error_code, "ERR_IMPORT_FORBIDDEN_GIT_MODE");

    const pushGitAttributes = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: dummyCommit,
      verified_tree_hash: dummyTree,
      parent_commit_hashes: [BASE_MAIN_SHA],
      changes: [
        {
          path: ".gitattributes",
          mode: "100644",
          size_bytes: 64,
          is_binary: false,
          added_lines: 1,
          deleted_lines: 0,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    assert.equal(pushGitAttributes.allowed, false);
    assert.equal(pushGitAttributes.error_code, "ERR_IMPORT_PATH_POLICY_VIOLATION");

    // 2f. Attempt to push binary or oversized blob -> Blocked at pre-receive
    const pushBinary = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: dummyCommit,
      verified_tree_hash: dummyTree,
      parent_commit_hashes: [BASE_MAIN_SHA],
      changes: [
        {
          path: "src/payload.ts",
          mode: "100644",
          size_bytes: 1024,
          is_binary: true,
          added_lines: 0,
          deleted_lines: 0,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    assert.equal(pushBinary.allowed, false);
    assert.equal(pushBinary.error_code, "ERR_IMPORT_BINARY_OR_SIZE_LIMIT");

    // 2g. Attempt to wipe out source code (deleted_lines > max_deleted_lines) -> Blocked at pre-receive
    const pushWipeout = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: dummyCommit,
      verified_tree_hash: dummyTree,
      parent_commit_hashes: [BASE_MAIN_SHA],
      changes: [
        {
          path: "src/core.ts",
          mode: "100644",
          size_bytes: 10,
          is_binary: false,
          added_lines: 0,
          deleted_lines: 500, // exceeds max_deleted_lines=100
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    assert.equal(pushWipeout.allowed, false);
    assert.equal(pushWipeout.error_code, "ERR_IMPORT_ABNORMAL_DIFF_THRESHOLD");
  });

  it("M2-Gate-3: Fail-Closed Pre-Receive Gatekeeper When Control Plane Is Disconnected or Exceeds 2000ms Timeout", async () => {
    const { coreApi, gateway, projectId } = createM2Environment();
    const task = await coreApi.createTask(projectId, "op-1", {
      title: "Fail-Closed outage & timeout test",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-m2-01",
    });

    const verifyRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;

    // Case A: Control Plane disconnected
    const outageResult = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: "3333333333333333333333333333333333333333",
      verified_tree_hash: "4444444444444444444444444444444444444444",
      parent_commit_hashes: [BASE_MAIN_SHA],
      simulateControlPlaneOutage: true,
    });
    assert.equal(outageResult.allowed, false);
    assert.equal(outageResult.error_code, "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE");

    // Case B: Gatekeeper response exceeds 2000ms timeout (e.g. 2500ms)
    const timeoutResult = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: "3333333333333333333333333333333333333333",
      verified_tree_hash: "4444444444444444444444444444444444444444",
      parent_commit_hashes: [BASE_MAIN_SHA],
      simulatedGatekeeperLatencyMs: 2500,
    });
    assert.equal(timeoutResult.allowed, false);
    assert.equal(timeoutResult.error_code, "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE");
  });

  it("M2-Gate-4 (Orphaned Push Reconciler P0-4): Immediate verified_code_imports Recording at Pre-Receive & Automatic Recovery After Worker Crash", async () => {
    const { store, coreApi, gateway, projectId, advanceClockMs } = createM2Environment();
    const task = await coreApi.createTask(projectId, "op-1", {
      title: "Automatic Orphaned Push Reconciler from verified_code_imports",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-m2-crash",
      heartbeat_interval_ms: 10_000,
      lease_ttl_ms: 30_000,
    });

    const verifyRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
    const validCommit = "5555555555555555555555555555555555555555";
    const validTree = "6666666666666666666666666666666666666666";

    // Worker pushes valid commit to refs/factory/Verify/<task_id>/<epoch>; TrustedImportValidator passes & immediately records verified_code_imports!
    const pushRes = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: validCommit,
      verified_tree_hash: validTree,
      parent_commit_hashes: [BASE_MAIN_SHA],
      changes: [
        {
          path: "src/service.ts",
          mode: "100644",
          size_bytes: 720,
          is_binary: false,
          added_lines: 30,
          deleted_lines: 4,
          blob_sha: sha256Hex("service-code").slice(0, 40),
        },
      ],
    });
    assert.equal(pushRes.allowed, true);
    assert.ok(pushRes.import_id, "verified_code_imports must be recorded immediately at pre-receive");

    // Simulate Worker crash immediately after git push (never sends task.completed); lease expires after 35s
    advanceClockMs(35_000);

    // Run Reconciler WITHOUT any external diff callback: it automatically finds the pre-recorded verified_code_imports row!
    const reconciled = await store.runLeaseExpiryAndOrphanedPushReconciler();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.outcome, "RECOVERED_ORPHANED_PUSH");
    assert.equal(reconciled[0]?.import_id, pushRes.import_id);

    const recoveredTask = await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      () => store.getTaskById(task.task_id)
    );
    assert.equal(recoveredTask?.status, "AGENT_COMPLETED");
  });

  it("M2-Gate-5: Real Git Repository Tree Inspection (inspectRealGitCommitForImport) End-to-End with Allowed Commit & Symlink Rejection", async () => {
    const { coreApi, gateway, projectId } = createM2Environment();
    const tempRepoDir = mkdtempSync(join(tmpdir(), "sf-m2-real-git-"));

    try {
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd: tempRepoDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();

      git(["init", "-b", "main"]);
      git(["config", "user.name", "sf-task-runner"]);
      git(["config", "user.email", "sf-task-runner@software-factory.local"]);

      mkdirSync(join(tempRepoDir, "src", "security"), { recursive: true });
      writeFileSync(join(tempRepoDir, "src", "index.ts"), "export const v = 1;\n", "utf8");
      writeFileSync(join(tempRepoDir, "src", "security", "guard.ts"), "export const guard = true;\n", "utf8");
      git(["add", "."]);
      git(["commit", "-m", "initial main commit"]);
      const realBaseMainSha = git(["rev-parse", "HEAD"]);

      const task = await coreApi.createTask(projectId, "op-1", {
        title: "Real Git tree inspection task",
        task_contract: M2_CONTRACT,
        base_main_commit_hash: realBaseMainSha,
      });
      const lease = await coreApi.dispatchTaskLease(projectId, "op-1", {
        task_id: task.task_id,
        worker_id: "worker-real-git",
      });

      // 1. Create a valid agent commit modifying src/index.ts
      writeFileSync(
        join(tempRepoDir, "src", "index.ts"),
        "export const v = 2;\nexport const status = 'ready';\n",
        "utf8"
      );
      git(["add", "src/index.ts"]);
      git(["commit", "-m", "feat: update index.ts"]);
      const validAgentSha = git(["rev-parse", "HEAD"]);

      const inspectedValid = inspectRealGitCommitForImport({
        repoPath: tempRepoDir,
        expectedBaseMainCommitHash: realBaseMainSha,
        agentCommitHash: validAgentSha,
        contract: M2_CONTRACT,
      });

      assert.equal(inspectedValid.changes.length, 1);
      assert.equal(inspectedValid.changes[0]?.path, "src/index.ts");
      assert.equal(inspectedValid.changes[0]?.mode, "100644");

      const pushValidRes = await gateway.authorizeAndPushStagingRef({
        task_id: task.task_id,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`,
        agent_commit_hash: inspectedValid.agent_commit_hash,
        verified_tree_hash: inspectedValid.verified_tree_hash,
        parent_commit_hashes: inspectedValid.parent_commit_hashes,
        changes: inspectedValid.changes,
      });
      assert.equal(pushValidRes.allowed, true);
      assert.ok(pushValidRes.import_id);

      // 2. Reset back to realBaseMainSha and create a malicious commit containing a symlink (mode 120000)
      git(["reset", "--hard", realBaseMainSha]);
      symlinkSync("/etc/passwd", join(tempRepoDir, "src", "malicious-link.ts"));
      git(["add", "src/malicious-link.ts"]);
      git(["commit", "-m", "malicious symlink commit"]);
      const symlinkCommitSha = git(["rev-parse", "HEAD"]);

      const inspectedSymlink = inspectRealGitCommitForImport({
        repoPath: tempRepoDir,
        expectedBaseMainCommitHash: realBaseMainSha,
        agentCommitHash: symlinkCommitSha,
        contract: M2_CONTRACT,
      });
      assert.equal(inspectedSymlink.changes[0]?.mode, "120000");

      const pushSymlinkRes = await gateway.authorizeAndPushStagingRef({
        task_id: task.task_id,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`,
        agent_commit_hash: inspectedSymlink.agent_commit_hash,
        verified_tree_hash: inspectedSymlink.verified_tree_hash,
        parent_commit_hashes: inspectedSymlink.parent_commit_hashes,
        changes: inspectedSymlink.changes,
      });
      assert.equal(pushSymlinkRes.allowed, false);
      assert.equal(pushSymlinkRes.error_code, "ERR_IMPORT_FORBIDDEN_GIT_MODE");
    } finally {
      rmSync(tempRepoDir, { recursive: true, force: true });
    }
  });

  it("M2-Gate-6: AdapterContractTestSuite for Both FakeAgentHarnessAdapter and ClaudeCodeCliAdapter (P-010)", async () => {
    const adapters: AgentRuntimeAdapter[] = [
      new FakeAgentHarnessAdapter(),
      new ClaudeCodeCliAdapter({
        writerModel: "claude-3-7-sonnet-20250219",
        binaryPath: "/usr/local/bin/claude",
      }),
    ];

    const ctx: AgentTaskContext = {
      projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      taskId: "30000000-0000-4000-8000-000000000003",
      leaseId: "40000000-0000-4000-8000-000000000004",
      leaseEpoch: 2,
      worktreePath: "/var/lib/software-factory/worktrees/task-3/epoch-2",
      baseMainCommitHash: BASE_MAIN_SHA,
      taskTitle: "Implement P-010 adapter contract",
      taskContract: M2_CONTRACT,
      ephemeralGitPushToken: "ephemeral-jwt-token-epoch-2",
      hostEnvironmentToSanitize: {
        SF_WNA_PRIVATE_KEY: "TOP_SECRET_WNA_KEY",
        WORKER_NODE_CREDENTIAL: "SECRET_NODE_CRED",
        DATABASE_URL: "postgres://app_runtime:secret@localhost:5432/sf",
        OPENAI_API_KEY: "sk-secret",
        ANTHROPIC_API_KEY: "sk-ant-secret",
      },
    };

    // Verify TaskContextAssembler strips all forbidden host secrets
    const assembled = TaskContextAssembler.assemble(ctx);
    for (const envKey of Object.keys(assembled.sanitizedEnv)) {
      for (const pattern of FORBIDDEN_SANDBOX_ENV_PATTERNS) {
        assert.equal(
          pattern.test(envKey),
          false,
          `Forbidden env variable ${envKey} must never leak into sandbox`
        );
      }
    }
    assert.equal(assembled.sanitizedEnv.SF_GIT_LEASE_TOKEN, "ephemeral-jwt-token-epoch-2");
    assert.equal(
      assembled.stagingRef,
      `refs/factory/Verify/${ctx.taskId}/${ctx.leaseEpoch}`
    );

    for (const adapter of adapters) {
      const plan = await adapter.prepareInvocation(ctx);
      assert.ok(plan.binaryPath.length > 0);
      assert.ok(plan.timeoutMs > 0);
      assert.equal(plan.sanitizedEnv.SF_TASK_ID, ctx.taskId);
      assert.equal(plan.sanitizedEnv.SF_LEASE_EPOCH, String(ctx.leaseEpoch));
      assert.equal(plan.sanitizedEnv.SF_WNA_PRIVATE_KEY, undefined);
      assert.equal(plan.sanitizedEnv.DATABASE_URL, undefined);

      const simulatedStdout = JSON.stringify({
        agent_commit_hash: "abcd1234abcd1234abcd1234abcd1234abcd1234",
        verified_tree_hash: "ef015678ef015678ef015678ef015678ef015678",
      });
      const result = await adapter.parseExecutionResult(ctx, 0, simulatedStdout, "");
      assert.equal(result.exitCode, 0);
      assert.match(result.agentCommitHash, /^[0-9a-f]{40}$/);
      assert.match(result.verifiedTreeHash, /^[0-9a-f]{40}$/);
      assert.equal(result.writerProvider, "anthropic");
    }
  });
});

describe("Milestone M1 & M2 Review Verification Suite (FIX-01 .. FIX-27)", () => {
  it("(a) Merge with REJECTED approval is strictly blocked (FIX-01)", async () => {
    const { store, coreApi, projectId } = createM2Environment();
    const task = await coreApi.createTask(projectId, "admin-1", {
      title: "Test Reject CAS Merge",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, "admin-1", {
      task_id: task.task_id,
      worker_id: "worker-1",
    });

    await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      async () => {
        const imp = store.recordVerifiedCodeImport({
          project_id: projectId,
          task_id: task.task_id,
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          staging_ref: `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`,
          candidate_input: {
            agent_commit_hash: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
            verified_tree_hash: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
            parent_commit_hashes: [BASE_MAIN_SHA],
            expected_base_main_commit_hash: BASE_MAIN_SHA,
            contract: M2_CONTRACT,
            changes: [
              {
                path: "src/feature.ts",
                mode: "100644",
                size_bytes: 100,
                added_lines: 5,
                deleted_lines: 0,
                is_binary: false,
                blob_sha: BASE_MAIN_SHA,
              },
            ],
          },
        });

        const mc = store.createMergeCandidate({
          project_id: projectId,
          task_id: task.task_id,
          import_id: imp.import_id,
          base_main_commit_hash: BASE_MAIN_SHA,
          merge_candidate_hash: "cccc3333cccc3333cccc3333cccc3333cccc3333",
          verified_tree_hash: imp.verified_tree_hash,
        });

        const vr = store.recordVerificationRun({
          project_id: projectId,
          task_id: task.task_id,
          merge_candidate_id: mc.merge_candidate_id,
          merge_candidate_hash: mc.merge_candidate_hash,
          verified_tree_hash: mc.verified_tree_hash,
          verifier_image_digest: "sha256:verifier",
          verdict: "PASS",
          exit_code: 0,
          duration_ms: 100,
          report_sha256: "sha256:report",
        });

        const ra = store.recordReviewArtifact({
          project_id: projectId,
          task_id: task.task_id,
          merge_candidate_id: mc.merge_candidate_id,
          verification_run_id: vr.verification_run_id,
          merge_candidate_hash: mc.merge_candidate_hash,
          verified_tree_hash: mc.verified_tree_hash,
          writer_provider: "anthropic",
          writer_model: "claude-3-5-sonnet",
          reviewer_provider: "google",
          reviewer_model: "gemini-1-5-pro",
          verdict: "PASS",
        });

        // Submit REJECTED decision
        const rejectedApproval = store.submitHumanApproval({
          project_id: projectId,
          task_id: task.task_id,
          merge_candidate_id: mc.merge_candidate_id,
          agent_commit_hash: mc.agent_commit_hash,
          base_main_commit_hash: mc.base_main_commit_hash,
          verified_tree_hash: mc.verified_tree_hash,
          merge_candidate_hash: mc.merge_candidate_hash,
          verification_run_id: vr.verification_run_id,
          review_artifact_id: ra.review_artifact_id,
          approver_principal_id: "approver-human-1",
          decision: "REJECTED",
        });
        assert.equal(rejectedApproval.decision, "REJECTED");

        // Attempting CAS merge with REJECTED approval must be blocked
        await assert.rejects(
          async () => {
            await store.executeAtomicCasMergeOrReconcile({
              project_id: projectId,
              task_id: task.task_id,
              merge_candidate_id: mc.merge_candidate_id,
              approval_id: rejectedApproval.approval_id,
            });
          },
          /Cannot merge candidate with decision REJECTED/
        );
      }
    );
  });

  it("(b) Human approval by non-authorized project member is rejected (FIX-11)", async () => {
    const { store, projectId } = createM2Environment();
    // Add developer member (not approver)
    await store.withRlsTransaction(
      { currentRole: "system_admin_role" },
      () => {
        store.addProjectMembership({
          project_id: projectId,
          principal_id: "junior-dev-1",
          member_role: "DEVELOPER",
        });
      }
    );

    await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      async () => {
        await assert.rejects(
          async () => {
            store.submitHumanApproval({
              project_id: projectId,
              task_id: "non-existent",
              merge_candidate_id: "mc-1",
              agent_commit_hash: "a".repeat(40),
              base_main_commit_hash: "b".repeat(40),
              verified_tree_hash: "c".repeat(40),
              merge_candidate_hash: "d".repeat(40),
              verification_run_id: "vr-1",
              review_artifact_id: "ra-1",
              approver_principal_id: "junior-dev-1",
              decision: "APPROVED",
            });
          },
          (err: any) => err.sqlState === "42501" || err.message.includes("not authorized")
        );
      }
    );
  });

  it("(c) Worker event fencing rejects worker_id mismatch with 409 ERR_STALE_LEASE (FIX-04)", async () => {
    const { coreApi, gateway, projectId } = createM2Environment();
    const task = await coreApi.createTask(projectId, "admin-1", {
      title: "Worker fencing test",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, "admin-1", {
      task_id: task.task_id,
      worker_id: "worker-legitimate",
    });

    // Impostor worker tries to submit event for this lease
    const ack = await gateway.submitEvent({
      envelope_version: "1.0",
      project_id: projectId,
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      worker_id: "worker-impostor",
      sequence_no: 1,
      event_type: "task.accepted",
      event_idempotency_key: "idem-fencing-test",
      payload_sha256: sha256Hex(JSON.stringify({ started: true })),
      emitted_at: new Date().toISOString(),
      payload: { started: true },
    });

    assert.equal(ack.http_status, 409);
    assert.equal(ack.ack_status, "REJECTED_STALE_LEASE");
    assert.equal(ack.error_code, "ERR_STALE_LEASE");
  });

  it("(d) Nested .env and uppercase forbidden extensions (.PEM, .KEY) are rejected (FIX-07)", async () => {
    // 1. Nested .env
    const resNestedEnv = validateGitTreeImport({
      agent_commit_hash: "a".repeat(40),
      verified_tree_hash: "b".repeat(40),
      parent_commit_hashes: [BASE_MAIN_SHA],
      expected_base_main_commit_hash: BASE_MAIN_SHA,
      contract: M2_CONTRACT,
      changes: [
        {
          path: "subfolder/config/.env.production",
          mode: "100644",
          size_bytes: 50,
          added_lines: 2,
          deleted_lines: 0,
          is_binary: false,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    assert.equal(resNestedEnv.valid, false);
    assert.equal(resNestedEnv.error_code, "ERR_IMPORT_PATH_POLICY_VIOLATION");

    // 2. Uppercase .PEM extension
    const resUpperPem = validateGitTreeImport({
      agent_commit_hash: "a".repeat(40),
      verified_tree_hash: "b".repeat(40),
      parent_commit_hashes: [BASE_MAIN_SHA],
      expected_base_main_commit_hash: BASE_MAIN_SHA,
      contract: M2_CONTRACT,
      changes: [
        {
          path: "certs/SERVER.PEM",
          mode: "100644",
          size_bytes: 120,
          added_lines: 5,
          deleted_lines: 0,
          is_binary: false,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    assert.equal(resUpperPem.valid, false);
    assert.equal(resUpperPem.error_code, "ERR_IMPORT_PATH_POLICY_VIOLATION");
  });

  it("(e) Multiple ACTIVE approvals for the same candidate are rejected with 23505 (FIX-11)", async () => {
    const { store, coreApi, projectId } = createM2Environment();
    const task = await coreApi.createTask(projectId, "admin-1", {
      title: "Duplicate active approval check",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, "admin-1", {
      task_id: task.task_id,
      worker_id: "worker-1",
    });

    await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      async () => {
        const imp = store.recordVerifiedCodeImport({
          project_id: projectId,
          task_id: task.task_id,
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          staging_ref: `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`,
          candidate_input: {
            agent_commit_hash: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
            verified_tree_hash: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
            parent_commit_hashes: [BASE_MAIN_SHA],
            expected_base_main_commit_hash: BASE_MAIN_SHA,
            contract: M2_CONTRACT,
            changes: [
              {
                path: "src/feature.ts",
                mode: "100644",
                size_bytes: 100,
                added_lines: 5,
                deleted_lines: 0,
                is_binary: false,
                blob_sha: BASE_MAIN_SHA,
              },
            ],
          },
        });

        const mc = store.createMergeCandidate({
          project_id: projectId,
          task_id: task.task_id,
          import_id: imp.import_id,
          base_main_commit_hash: BASE_MAIN_SHA,
          merge_candidate_hash: "cccc3333cccc3333cccc3333cccc3333cccc3333",
          verified_tree_hash: imp.verified_tree_hash,
        });

        const vr = store.recordVerificationRun({
          project_id: projectId,
          task_id: task.task_id,
          merge_candidate_id: mc.merge_candidate_id,
          merge_candidate_hash: mc.merge_candidate_hash,
          verified_tree_hash: mc.verified_tree_hash,
          verifier_image_digest: "sha256:verifier",
          verdict: "PASS",
          exit_code: 0,
          duration_ms: 100,
          report_sha256: "sha256:report",
        });

        const ra = store.recordReviewArtifact({
          project_id: projectId,
          task_id: task.task_id,
          merge_candidate_id: mc.merge_candidate_id,
          verification_run_id: vr.verification_run_id,
          merge_candidate_hash: mc.merge_candidate_hash,
          verified_tree_hash: mc.verified_tree_hash,
          writer_provider: "anthropic",
          writer_model: "claude-3-5-sonnet",
          reviewer_provider: "google",
          reviewer_model: "gemini-1-5-pro",
          verdict: "PASS",
        });

        // First ACTIVE approval
        store.submitHumanApproval({
          project_id: projectId,
          task_id: task.task_id,
          merge_candidate_id: mc.merge_candidate_id,
          agent_commit_hash: mc.agent_commit_hash,
          base_main_commit_hash: mc.base_main_commit_hash,
          verified_tree_hash: mc.verified_tree_hash,
          merge_candidate_hash: mc.merge_candidate_hash,
          verification_run_id: vr.verification_run_id,
          review_artifact_id: ra.review_artifact_id,
          approver_principal_id: "approver-1",
          decision: "APPROVED",
        });

        // Second ACTIVE approval on same candidate must throw 23505 unique violation
        assert.throws(
          () => {
            store.submitHumanApproval({
              project_id: projectId,
              task_id: task.task_id,
              merge_candidate_id: mc.merge_candidate_id,
              agent_commit_hash: mc.agent_commit_hash,
              base_main_commit_hash: mc.base_main_commit_hash,
              verified_tree_hash: mc.verified_tree_hash,
              merge_candidate_hash: mc.merge_candidate_hash,
              verification_run_id: vr.verification_run_id,
              review_artifact_id: ra.review_artifact_id,
              approver_principal_id: "approver-2",
              decision: "APPROVED",
            });
          },
          (err: any) => err.sqlState === "23505"
        );
      }
    );
  });

  it("(f) Merge candidate bound to import of another task is rejected with 23503 (FIX-12)", async () => {
    const { store, coreApi, projectId } = createM2Environment();
    const task1 = await coreApi.createTask(projectId, "admin-1", {
      title: "Task 1",
      task_contract: M2_CONTRACT,
    });
    const task2 = await coreApi.createTask(projectId, "admin-1", {
      title: "Task 2",
      task_contract: M2_CONTRACT,
    });
    const lease1 = await coreApi.dispatchTaskLease(projectId, "admin-1", {
      task_id: task1.task_id,
      worker_id: "worker-1",
    });

    await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      () => {
        const imp1 = store.recordVerifiedCodeImport({
          project_id: projectId,
          task_id: task1.task_id,
          lease_id: lease1.lease_id,
          lease_epoch: lease1.lease_epoch,
          staging_ref: `refs/heads/sf/staging/${task1.task_id}/${lease1.lease_epoch}`,
          candidate_input: {
            agent_commit_hash: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
            verified_tree_hash: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
            parent_commit_hashes: [BASE_MAIN_SHA],
            expected_base_main_commit_hash: BASE_MAIN_SHA,
            contract: M2_CONTRACT,
            changes: [
              {
                path: "src/feature.ts",
                mode: "100644",
                size_bytes: 100,
                added_lines: 5,
                deleted_lines: 0,
                is_binary: false,
                blob_sha: BASE_MAIN_SHA,
              },
            ],
          },
        });

        // Trying to create candidate for task2 with import of task1 -> must throw 23503
        assert.throws(
          () => {
            store.createMergeCandidate({
              project_id: projectId,
              task_id: task2.task_id,
              import_id: imp1.import_id,
              base_main_commit_hash: BASE_MAIN_SHA,
              merge_candidate_hash: "cccc3333cccc3333cccc3333cccc3333cccc3333",
              verified_tree_hash: imp1.verified_tree_hash,
            });
          },
          (err: any) => err.sqlState === "23503"
        );
      }
    );
  });

  it("(g) Rename + delete exceeding wipeout threshold is blocked (FIX-09)", async () => {
    const res = validateGitTreeImport({
      agent_commit_hash: "a".repeat(40),
      verified_tree_hash: "b".repeat(40),
      parent_commit_hashes: [BASE_MAIN_SHA],
      expected_base_main_commit_hash: BASE_MAIN_SHA,
      contract: {
        ...M2_CONTRACT,
        max_deleted_lines: 50,
      },
      changes: [
        {
          path: "src/new-name.ts",
          old_path: "src/old-name.ts",
          mode: "100644",
          size_bytes: 200,
          added_lines: 10,
          deleted_lines: 75, // Exceeds max_deleted_lines (50)
          is_binary: false,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });

    assert.equal(res.valid, false);
    assert.equal(res.error_code, "ERR_IMPORT_ABNORMAL_DIFF_THRESHOLD");
  });

  it("(h) Push without changes is rejected with ERR_GATEKEEPER_MISSING_CHANGES (FIX-10)", async () => {
    const { coreApi, gateway, projectId } = createM2Environment();
    const task = await coreApi.createTask(projectId, "admin-1", {
      title: "Missing changes push test",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, "admin-1", {
      task_id: task.task_id,
      worker_id: "worker-1",
    });

    const pushRes = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`,
      agent_commit_hash: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
      verified_tree_hash: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
      parent_commit_hashes: [BASE_MAIN_SHA],
      // changes is intentionally omitted!
    });

    assert.equal(pushRes.allowed, false);
    assert.equal(pushRes.error_code, "ERR_GATEKEEPER_MISSING_CHANGES");
  });

  it("(i) Claude adapter with unparseable stdout returns null hashes without fabricating fake ones (FIX-06)", async () => {
    const adapter = new ClaudeCodeCliAdapter();
    const ctx: AgentTaskContext = {
      projectId: "p-1",
      taskId: "t-1",
      leaseId: "l-1",
      leaseEpoch: 1,
      worktreePath: "/tmp/worktree",
      baseMainCommitHash: BASE_MAIN_SHA,
      taskTitle: "Fake stdout test",
      taskContract: M2_CONTRACT,
      ephemeralGitPushToken: "token-1",
      hostEnvironmentToSanitize: {},
    };

    const res = await adapter.parseExecutionResult(
      ctx,
      0,
      "I am an LLM output that failed to emit structured git commit hashes.",
      ""
    );

    // Must never return 40-char fake hashes!
    assert.equal(res.agentCommitHash, null);
    assert.equal(res.verifiedTreeHash, null);
    assert.ok(res.error && res.error.includes("Failed to parse valid 40-char commit hash"));
  });
});

