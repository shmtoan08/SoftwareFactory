import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  STATE_TRANSITION_MATRIX,
  type TaskStatus,
  canonicalizeJson,
  computeCanonicalPayloadSha256,
  computeEventIdempotencyKey,
  sha256Hex,
} from "../../shared-types/src/index.ts";
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
import {
  PostgresRlsError,
  type ProjectMemberRole,
  SoftwareFactoryControlPlaneStore,
} from "../../database/src/index.ts";
import {
  LinuxCgroupV2SandboxBackend,
  SimulatedCgroupV2SandboxBackend,
} from "../../wna/src/index.ts";
import {
  AgentGatewayHttpServer,
  AgentGatewayService,
  EphemeralGitPushTokenService,
} from "../../../apps/agent-gateway/src/index.ts";
import { type CoreApiAuthContext, CoreApiService } from "../../../apps/core-api/src/index.ts";
import { WebApprovalConsoleController } from "../../../apps/web/src/index.ts";
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

function createM2Environment(
  initialNow = new Date("2026-11-10T14:00:00.000Z"),
  options?: { approvalTtlSeconds?: number; repoBarePath?: string; initialMainSha?: string; initialTreeSha?: string }
) {
  let currentNow = new Date(initialNow.getTime());
  const store = new SoftwareFactoryControlPlaneStore(() => currentNow);
  const advanceClockMs = (ms: number) => {
    currentNow = new Date(currentNow.getTime() + ms);
  };

  let projectId = "";
  let projectBId = "";
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
        repo_bare_path: options?.repoBarePath ?? "/var/lib/software-factory/repos/m2-worker-plane.git",
        initial_main_commit_hash: options?.initialMainSha ?? BASE_MAIN_SHA,
        initial_main_tree_hash: options?.initialTreeSha ?? BASE_TREE_SHA,
        approval_ttl_seconds: options?.approvalTtlSeconds,
      });
      projectId = proj.project_id;

      const projB = store.createProject({
        project_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        slug: "m2-other-project",
        name: "Milestone M2 Other Project",
        repo_bare_path: "/var/lib/software-factory/repos/m2-other-project.git",
        initial_main_commit_hash: BASE_MAIN_SHA,
        initial_main_tree_hash: BASE_TREE_SHA,
      });
      projectBId = projB.project_id;

      for (const [principal_id, member_role] of [
        ["op-1", "ORG_ADMIN"],
        ["admin-1", "ORG_ADMIN"],
        ["dev-1", "DEVELOPER"],
        ["approver-human-1", "PROJECT_APPROVER"],
        ["approver-1", "PROJECT_APPROVER"],
        ["approver-2", "PROJECT_APPROVER"],
        ["bob-approver", "PROJECT_APPROVER"],
        ["auditor-1", "AUDITOR"],
      ] as const) {
        store.addProjectMembership({
          project_id: projectId,
          principal_id,
          member_role,
        });
      }

      store.addProjectMembership({
        project_id: projectBId,
        principal_id: "admin-1",
        member_role: "ORG_ADMIN",
      });
    }
  );

  const coreApi = new CoreApiService(store);
  const issueAuth = (
    targetProjectId: string,
    principalId: string,
    roles: readonly ProjectMemberRole[],
    ttlMs = 3_600_000
  ): CoreApiAuthContext =>
    coreApi.issueAuthContext({
      projectId: targetProjectId,
      principalId,
      roles,
      ttlMs,
    });

  const gateway = new AgentGatewayService({
    store,
    projectId,
    workerPrincipalId: "wna-supervisor-node-01",
  });
  const webConsole = new WebApprovalConsoleController(coreApi);
  const sandboxBackend = new SimulatedCgroupV2SandboxBackend();

  return {
    store,
    coreApi,
    gateway,
    webConsole,
    sandboxBackend,
    projectId,
    projectBId,
    advanceClockMs,
    issueAuth,
    authOp1: issueAuth(projectId, "op-1", ["ORG_ADMIN"]),
    authAdmin1: issueAuth(projectId, "admin-1", ["ORG_ADMIN"]),
    authDev1: issueAuth(projectId, "dev-1", ["DEVELOPER"]),
    authApproverHuman1: issueAuth(projectId, "approver-human-1", ["PROJECT_APPROVER"]),
    authApprover1: issueAuth(projectId, "approver-1", ["PROJECT_APPROVER"]),
    authAuditor1: issueAuth(projectId, "auditor-1", ["AUDITOR"]),
    authAdminProjectB: issueAuth(projectBId, "admin-1", ["ORG_ADMIN"]),
  };
}

describe("Milestone M2 Gate — Worker Plane, Sandbox, Controlled Git Push Import & Adapter P-010", () => {
  it("M2-Gate-1 (Adversarial Scenario 7): Simulated Double-Fork Orphan & Sandbox Escape Defense (Mount Isolation, /etc/sf-wna Deny, Subreaper & Traversal Guard)", async () => {
    const { sandboxBackend } = createM2Environment();
    assert.ok(sandboxBackend instanceof SimulatedCgroupV2SandboxBackend);

    const taskAId = "10000000-0000-4000-8000-000000000001";
    const taskBId = "20000000-0000-4000-8000-000000000002";
    const epoch = 1;
    const taskAWorktree = `/var/lib/software-factory/worktrees/${taskAId}/epoch-${epoch}`;
    const taskBWorktree = `/var/lib/software-factory/worktrees/${taskBId}/epoch-${epoch}`;

    // Spawn simulated sandbox process with a direct child and a double-forked grandchild
    sandboxBackend.spawnProcessInSandbox({
      taskId: taskAId,
      leaseEpoch: epoch,
      pid: 61001,
      childPids: [61002],
      worktreePath: taskAWorktree,
    });
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

    // 4. Execute killAndVerifyClean when lease is revoked/expired — must explicitly declare simulation status (FIX-05)
    assert.equal(sandboxBackend.getActivePids(taskAId, epoch).length, 3);
    const cleanup = await sandboxBackend.killAndVerifyClean(taskAId, epoch);

    assert.equal(cleanup.backendMode, "simulated-cgroup-v2");
    assert.equal(cleanup.isSimulated, true);
    assert.equal(cleanup.realKernelOperationsExecuted, false);
    assert.equal(cleanup.freezeApplied, true);
    assert.equal(cleanup.cgroupKillWritten, true);
    assert.equal(cleanup.populatedZeroVerified, true);
    assert.equal(cleanup.remainingProcsCount, 0);
    assert.equal(cleanup.cgroupDirRemoved, true);
    assert.deepEqual(cleanup.subreaperWaitpidReapedPids, [61099]);
    assert.deepEqual(cleanup.killedPids, [61001, 61002, 61099]);
  });

  it("M2-Gate-2 (Adversarial Scenario 6): Malicious Git Push Blocked 100% at Pre-Receive Hook (Forbidden Ref, Outside Allowed, Protected Rename, Symlink, Submodule, Binary, Wipeout)", async () => {
    const { coreApi, gateway, projectId, authOp1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authOp1, {
      title: "M2 Gatekeeper adversarial push checks",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authOp1, {
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

  it("M2-Gate-3: Fail-Closed Pre-Receive Gatekeeper When Control Plane Is Disconnected or Exceeds Hard Async Deadline (FIX-16)", async () => {
    const { coreApi, gateway, projectId, authOp1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authOp1, {
      title: "Fail-Closed outage & real async timeout test",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authOp1, {
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

    // Case B: Real asynchronous Promise.race + AbortController deadline enforcement (no synthetic latency parameter!)
    let abortSignalFired = false;
    const startedMs = Date.now();
    const timeoutResult = await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: verifyRef,
      agent_commit_hash: "3333333333333333333333333333333333333333",
      verified_tree_hash: "4444444444444444444444444444444444444444",
      parent_commit_hashes: [BASE_MAIN_SHA],
      deadlineMs: 80,
      changes: [
        {
          path: "src/service.ts",
          mode: "100644",
          size_bytes: 120,
          is_binary: false,
          added_lines: 5,
          deleted_lines: 0,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
      authorizeCheckHook: (signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 400);
          signal.addEventListener(
            "abort",
            () => {
              abortSignalFired = true;
              clearTimeout(timer);
            },
            { once: true }
          );
        }),
    });
    const elapsedMs = Date.now() - startedMs;
    assert.equal(timeoutResult.allowed, false);
    assert.equal(timeoutResult.error_code, "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE");
    assert.equal(abortSignalFired, true);
    assert.ok(elapsedMs < 350, `Expected Promise.race deadline to abort quickly, got ${elapsedMs}ms`);
  });

  it("M2-Gate-4 (Orphaned Push Reconciler P0-4): Immediate verified_code_imports Recording at Pre-Receive & Automatic Recovery After Worker Crash", async () => {
    const { store, coreApi, gateway, projectId, advanceClockMs, authOp1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authOp1, {
      title: "Automatic Orphaned Push Reconciler from verified_code_imports",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authOp1, {
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
    assert.equal(recoveredTask?.status, "BuildingMergeCandidate");
  });

  it("M2-Gate-5: Real Git Repository Tree Inspection (inspectRealGitCommitForImport) End-to-End with Allowed Commit & Symlink Rejection", async () => {
    const { coreApi, gateway, projectId, authOp1 } = createM2Environment();
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

      const task = await coreApi.createTask(projectId, authOp1, {
        title: "Real Git tree inspection task",
        task_contract: M2_CONTRACT,
        base_main_commit_hash: realBaseMainSha,
      });
      const lease = await coreApi.dispatchTaskLease(projectId, authOp1, {
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
      assert.ok(result.agentCommitHash);
      assert.ok(result.verifiedTreeHash);
      assert.match(result.agentCommitHash, /^[0-9a-f]{40}$/);
      assert.match(result.verifiedTreeHash, /^[0-9a-f]{40}$/);
      assert.equal(result.writerProvider, "anthropic");
    }
  });
});

describe("Milestone M1 & M2 Review Verification Suite (FIX-01 .. FIX-27)", () => {
  it("(a) Merge with REJECTED approval is strictly blocked (FIX-01)", async () => {
    const { store, coreApi, projectId, authAdmin1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authAdmin1, {
      title: "Test Reject CAS Merge",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
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
          developer_principal_id: "wna-writer-a",
          reviewer_principal_id: "independent-reviewer-a",
          developer_session_id: "sess-writer-a",
          reviewer_session_id: "sess-reviewer-a",
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
        assert.equal(store.getTaskById(task.task_id)?.status, "ManualIntervention");

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

  it("(b) Human approval by DEVELOPER or unmembered user is rejected fail-closed with 42501 (FIX-11 & FIX-23)", async () => {
    const { store, coreApi, projectId, issueAuth } = createM2Environment();
    await store.withRlsTransaction({ currentRole: "system_admin_role" }, () => {
      store.addProjectMembership({
        project_id: projectId,
        principal_id: "junior-dev-1",
        member_role: "DEVELOPER",
      });
    });

    // Store-level fail-closed check for DEVELOPER AND unmembered principal ("mallory-no-membership")
    await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      async () => {
        for (const unauthorizedPrincipal of ["junior-dev-1", "mallory-no-membership"]) {
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
                approver_principal_id: unauthorizedPrincipal,
                decision: "APPROVED",
              });
            },
            (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "42501"
          );
        }
      }
    );

    // CoreApi-level check: even with a forged/issued ORG_ADMIN token for unmembered mallory, live membership lookup fails closed
    const malloryToken = issueAuth(projectId, "mallory-no-membership", ["ORG_ADMIN"]);
    await assert.rejects(
      () =>
        coreApi.submitHumanApproval(projectId, malloryToken, {
          task_id: "non-existent",
          merge_candidate_id: "mc-1",
          agent_commit_hash: "a".repeat(40),
          base_main_commit_hash: "b".repeat(40),
          verified_tree_hash: "c".repeat(40),
          merge_candidate_hash: "d".repeat(40),
          verification_run_id: "vr-1",
          review_artifact_id: "ra-1",
          decision: "APPROVED",
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "42501"
    );
  });

  it("(c) Worker event fencing rejects worker_id mismatch with 409 ERR_STALE_LEASE (FIX-04)", async () => {
    const { coreApi, gateway, projectId, authAdmin1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authAdmin1, {
      title: "Worker fencing test",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
      task_id: task.task_id,
      worker_id: "worker-legitimate",
    });

    const payload = { started: true };
    const ack = await gateway.submitEvent({
      schema_version: "1.5",
      project_id: projectId,
      task_id: task.task_id,
      attempt_no: lease.attempt_no,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      worker_id: "worker-impostor",
      sequence_no: 1,
      event_type: "task.accepted",
      task_execution_idempotency_key: lease.task_execution_idempotency_key,
      event_idempotency_key: computeEventIdempotencyKey(
        lease.lease_id,
        lease.lease_epoch,
        1,
        "task.accepted"
      ),
      payload_sha256: computeCanonicalPayloadSha256(payload),
      emitted_at: new Date().toISOString(),
      payload,
    });

    assert.equal(ack.http_status, 409);
    assert.equal(ack.ack_status, "REJECTED_STALE_LEASE");
    assert.equal(ack.error_code, "ERR_STALE_LEASE");
  });

  it("(d) Nested .env and uppercase forbidden extensions (.PEM, .KEY) are rejected (FIX-07)", async () => {
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
    if (!resNestedEnv.valid) {
      assert.equal(resNestedEnv.error_code, "ERR_IMPORT_PATH_POLICY_VIOLATION");
    }

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
    if (!resUpperPem.valid) {
      assert.equal(resUpperPem.error_code, "ERR_IMPORT_PATH_POLICY_VIOLATION");
    }
  });

  it("(e) Multiple ACTIVE approvals for the same candidate are rejected with 23505 (FIX-11)", async () => {
    const { store, coreApi, projectId, authAdmin1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authAdmin1, {
      title: "Duplicate active approval check",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
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
          developer_principal_id: "wna-writer-e",
          reviewer_principal_id: "independent-reviewer-e",
          developer_session_id: "sess-writer-e",
          reviewer_session_id: "sess-reviewer-e",
          verdict: "PASS",
        });

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
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23505"
        );
      }
    );
  });

  it("(f) Merge candidate bound to import of another task is rejected with 23503 (FIX-12)", async () => {
    const { store, coreApi, projectId, authAdmin1 } = createM2Environment();
    const task1 = await coreApi.createTask(projectId, authAdmin1, {
      title: "Task 1",
      task_contract: M2_CONTRACT,
    });
    const task2 = await coreApi.createTask(projectId, authAdmin1, {
      title: "Task 2",
      task_contract: M2_CONTRACT,
    });
    const lease1 = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
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
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23503"
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
          deleted_lines: 75,
          is_binary: false,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });

    assert.equal(res.valid, false);
    if (!res.valid) {
      assert.equal(res.error_code, "ERR_IMPORT_ABNORMAL_DIFF_THRESHOLD");
    }
  });

  it("(h) Push without changes is rejected with ERR_GATEKEEPER_MISSING_CHANGES (FIX-10)", async () => {
    const { coreApi, gateway, projectId, authAdmin1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authAdmin1, {
      title: "Missing changes push test",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
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

    assert.equal(res.agentCommitHash, null);
    assert.equal(res.verifiedTreeHash, null);
    assert.ok(res.error && res.error.includes("Failed to parse valid 40-char commit hash"));
  });

  it("(j) End-to-End Real `git push` -> `scripts/git-hooks/pre-receive` -> Live `AgentGatewayHttpServer` (FIX-14 & FIX-16)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sf-e2e-git-push-"));
    const bareRepoDir = join(tempDir, "remote-repo.git");
    const workerCloneDir = join(tempDir, "worker-clone");
    const hookSource = resolve(process.cwd(), "scripts", "git-hooks", "pre-receive");

    execFileSync("git", ["init", "--bare", "-b", "main", bareRepoDir], { stdio: "ignore" });
    execFileSync("git", ["clone", bareRepoDir, workerCloneDir], { stdio: "ignore" });

    const gitWorker = (args: string[]) =>
      execFileSync("git", args, {
        cwd: workerCloneDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    gitWorker(["checkout", "-b", "main"]);
    gitWorker(["config", "user.name", "sf-seed"]);
    gitWorker(["config", "user.email", "seed@software-factory.local"]);
    mkdirSync(join(workerCloneDir, "src"), { recursive: true });
    writeFileSync(join(workerCloneDir, "src", "base.ts"), "export const base = 1;\n", "utf8");
    gitWorker(["add", "."]);
    gitWorker(["commit", "-m", "seed main"]);
    gitWorker(["push", "-u", "origin", "main"]);

    const baseMainSha = gitWorker(["rev-parse", "HEAD"]);
    const baseTreeSha = gitWorker(["rev-parse", "HEAD^{tree}"]);

    // Install real scripts/git-hooks/pre-receive hook AFTER seeding main
    const installedHookPath = join(bareRepoDir, "hooks", "pre-receive");
    copyFileSync(hookSource, installedHookPath);
    chmodSync(installedHookPath, 0o755);

    const { store, coreApi, projectId, authOp1 } = createM2Environment(undefined, {
      repoBarePath: bareRepoDir,
      initialMainSha: baseMainSha,
      initialTreeSha: baseTreeSha,
    });
    const tokenService = new EphemeralGitPushTokenService();
    const httpServer = new AgentGatewayHttpServer({
      store,
      tokenService,
      port: 0,
      deadlineMs: 2000,
    });

    try {
      const serverInfo = await httpServer.start();

      // Task 1: Valid push to refs/heads/sf/staging/<task_id>/<epoch> with valid HMAC Bearer token
      const task1 = await coreApi.createTask(projectId, authOp1, {
        title: "Real git push E2E",
        task_contract: M2_CONTRACT,
        base_main_commit_hash: baseMainSha,
      });
      const lease1 = await coreApi.dispatchTaskLease(projectId, authOp1, {
        task_id: task1.task_id,
        worker_id: "worker-e2e-1",
      });
      const token1 = tokenService.issueLeasePushToken({
        projectId,
        taskId: task1.task_id,
        leaseId: lease1.lease_id,
        leaseEpoch: lease1.lease_epoch,
        workerId: lease1.worker_id,
      });

      writeFileSync(join(workerCloneDir, "src", "feature.ts"), "export const ok = true;\n", "utf8");
      gitWorker(["add", "src/feature.ts"]);
      gitWorker(["commit", "-m", "feat: valid staging commit"]);
      const validCommitSha = gitWorker(["rev-parse", "HEAD"]);

      const runGitPush = (refspec: string, leaseToken: string, url = serverInfo.url) =>
        new Promise<{ status: number | null; stdout: string; stderr: string }>(
          (resolvePush, rejectPush) => {
            const child = spawn("git", ["push", bareRepoDir, refspec], {
              cwd: workerCloneDir,
              env: {
                ...process.env,
                SF_GATEWAY_PRE_RECEIVE_URL: url,
                SF_GIT_LEASE_TOKEN: leaseToken,
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            });
            child.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8");
            });
            child.on("error", rejectPush);
            child.on("close", (status) => {
              resolvePush({ status, stdout, stderr });
            });
          }
        );

      const validPush = await runGitPush(
        `HEAD:refs/heads/sf/staging/${task1.task_id}/${lease1.lease_epoch}`,
        token1
      );
      assert.equal(validPush.status, 0, `Expected valid git push exit 0, stderr: ${validPush.stderr}`);

      const imports1 = await store.withRlsTransaction(
        { currentProjectId: projectId, currentRole: "core_api_service" },
        () => store.getVerifiedImportsForTask(task1.task_id)
      );
      assert.equal(imports1.length, 1);
      assert.equal(imports1[0]?.agent_commit_hash, validCommitSha);

      // Static/invalid token rejected fail-closed (HTTP 403)
      const taskBadToken = await coreApi.createTask(projectId, authOp1, {
        title: "Bad token push E2E",
        task_contract: M2_CONTRACT,
        base_main_commit_hash: baseMainSha,
      });
      const leaseBadToken = await coreApi.dispatchTaskLease(projectId, authOp1, {
        task_id: taskBadToken.task_id,
        worker_id: "worker-e2e-2",
      });
      const staticTokenRes = await runGitPush(
        `HEAD:refs/heads/sf/staging/${taskBadToken.task_id}/${leaseBadToken.lease_epoch}`,
        "static-unsigned-token"
      );
      assert.notEqual(staticTokenRes.status, 0);
      assert.match(staticTokenRes.stderr, /HTTP 403/);

      // Direct push to refs/heads/main blocked at hook level
      const mainPushRes = await runGitPush("HEAD:refs/heads/main", token1);
      assert.notEqual(mainPushRes.status, 0);
      assert.match(mainPushRes.stderr, /ERR.*forbidden/i);

      // Nested .env commit rejected at AgentGatewayHttpServer via inspectRealGitCommitForImport quarantine inspection (403)
      gitWorker(["reset", "--hard", baseMainSha]);
      mkdirSync(join(workerCloneDir, "src", "nested"), { recursive: true });
      writeFileSync(join(workerCloneDir, "src", "nested", ".env.local"), "SECRET=1\n", "utf8");
      gitWorker(["add", "src/nested/.env.local"]);
      gitWorker(["commit", "-m", "malicious env"]);
      const taskEnv = await coreApi.createTask(projectId, authOp1, {
        title: "Forbidden .env push E2E",
        task_contract: M2_CONTRACT,
        base_main_commit_hash: baseMainSha,
      });
      const leaseEnv = await coreApi.dispatchTaskLease(projectId, authOp1, {
        task_id: taskEnv.task_id,
        worker_id: "worker-e2e-env",
      });
      const tokenEnv = tokenService.issueLeasePushToken({
        projectId,
        taskId: taskEnv.task_id,
        leaseId: leaseEnv.lease_id,
        leaseEpoch: leaseEnv.lease_epoch,
        workerId: leaseEnv.worker_id,
      });
      const envPushRes = await runGitPush(
        `HEAD:refs/factory/Verify/${taskEnv.task_id}/${leaseEnv.lease_epoch}`,
        tokenEnv
      );
      assert.notEqual(envPushRes.status, 0);
      assert.match(envPushRes.stderr, /ERR_IMPORT_PATH_POLICY_VIOLATION/);

      // Real async timeout (> deadlineMs) fails closed with HTTP 504
      gitWorker(["reset", "--hard", baseMainSha]);
      writeFileSync(join(workerCloneDir, "src", "timeout.ts"), "export const t = 1;\n", "utf8");
      gitWorker(["add", "src/timeout.ts"]);
      gitWorker(["commit", "-m", "commit for timeout test"]);
      httpServer.deadlineMs = 80;
      httpServer.authorizeCheckHook = (signal) =>
        new Promise((resolveWait) => {
          const timer = setTimeout(resolveWait, 400);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
            },
            { once: true }
          );
        });
      const timeoutPush = await runGitPush(
        `HEAD:refs/factory/Verify/${taskEnv.task_id}/${leaseEnv.lease_epoch}`,
        tokenEnv
      );
      assert.notEqual(timeoutPush.status, 0);
      assert.match(timeoutPush.stderr, /HTTP 504/);

      // Closed gateway fails closed (exit != 0)
      await httpServer.close();
      httpServer.authorizeCheckHook = undefined;
      httpServer.deadlineMs = 2000;
      const unreachablePush = await runGitPush(
        `HEAD:refs/factory/Verify/${taskEnv.task_id}/${leaseEnv.lease_epoch}`,
        tokenEnv
      );
      assert.notEqual(unreachablePush.status, 0);
    } finally {
      await httpServer.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("(k) Real Subprocess Group SIGKILL, Non-Linux cgroup v2 Fail-Closed Guard, and '..' Path Traversal Rejection (FIX-05 & FIX-15)", async () => {
    const backend = new LinuxCgroupV2SandboxBackend({
      cgroupRoot: "/nonexistent/sf-cgroup-v2-root",
    });
    const taskId = "99000000-0000-4000-8000-000000000001";
    const worktreePath = "/var/lib/software-factory/worktrees/real-proc/epoch-1";

    try {
      // 1. Spawn a real detached Node child process and kill it via OS process group SIGKILL
      const spawned = backend.spawnRealProcessInSandbox({
        taskId,
        leaseEpoch: 1,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        sanitizedEnv: {},
        cwd: process.cwd(),
        worktreePath,
      });
      assert.equal(spawned.executionMode, "real-process");
      assert.ok(spawned.pid > 0);

      // Verify traversal bypass is rejected fail-closed (FIX-15)
      assert.throws(
        () =>
          backend.assertSandboxPathAccess(
            taskId,
            1,
            `${worktreePath}/../../../../../../etc/sf-wna/worker.key`
          ),
        /EACCES: Mount namespace isolation denied access to WNA credential path/
      );
      assert.throws(
        () =>
          backend.assertSandboxPathAccess(
            taskId,
            1,
            `${worktreePath}/../../other-task/src/index.ts`
          ),
        /EACCES: Mount namespace isolation denied cross-worktree or host path access/
      );

      const evidence = await backend.killAndVerifyClean(taskId, 1);
      assert.equal(evidence.backendMode, "simulated-cgroup-v2");
      assert.equal(evidence.isSimulated, true);
      assert.equal(evidence.realProcessGroupKilled, true);
      assert.equal(evidence.realKernelOperationsExecuted, false);
      assert.equal(evidence.remainingProcsCount, 0);
      assert.deepEqual(evidence.killedPids, [spawned.pid]);

      // 2. Requiring real Linux cgroups v2 when cgroupfs is unavailable fails closed
      assert.throws(
        () =>
          backend.spawnRealProcessInSandbox({
            taskId,
            leaseEpoch: 2,
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            sanitizedEnv: {},
            cwd: process.cwd(),
            requireKernelCgroup: true,
          }),
        /ERR_LINUX_CGROUP_V2_UNAVAILABLE/
      );
    } finally {
      await backend.killAndVerifyClean(taskId, 1).catch(() => {});
    }
  });

  it("(l) CoreApiService Enforces Signed AuthN, Membership & RBAC Roles Fail-Closed (FIX-23)", async () => {
    const { coreApi, projectId, authAdminProjectB, authAuditor1, authDev1, authAdmin1 } =
      createM2Environment();

    // 1. Raw principal string rejected at runtime
    await assert.rejects(
      () =>
        coreApi.createTask(projectId, "op-1" as unknown as CoreApiAuthContext, {
          title: "Unauthenticated call",
          task_contract: M2_CONTRACT,
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "42501"
    );

    // 2. Forged signature rejected
    const forged: CoreApiAuthContext = {
      ...authAdmin1,
      signatureHex: "0".repeat(64),
    };
    await assert.rejects(
      () =>
        coreApi.createTask(projectId, forged, {
          title: "Forged signature",
          task_contract: M2_CONTRACT,
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "42501"
    );

    // 3. Cross-project token rejected
    await assert.rejects(
      () =>
        coreApi.createTask(projectId, authAdminProjectB, {
          title: "Cross-project token",
          task_contract: M2_CONTRACT,
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "42501"
    );

    // 4. AUDITOR cannot mutate tasks
    await assert.rejects(
      () =>
        coreApi.createTask(projectId, authAuditor1, {
          title: "Auditor mutation forbidden",
          task_contract: M2_CONTRACT,
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "42501"
    );

    // 5. DEVELOPER cannot approve candidates
    await assert.rejects(
      () =>
        coreApi.submitHumanApproval(projectId, authDev1, {
          task_id: "nonexistent",
          merge_candidate_id: "nonexistent",
          agent_commit_hash: BASE_MAIN_SHA,
          base_main_commit_hash: BASE_MAIN_SHA,
          verified_tree_hash: BASE_TREE_SHA,
          merge_candidate_hash: BASE_MAIN_SHA,
          verification_run_id: "nonexistent",
          review_artifact_id: "nonexistent",
          decision: "APPROVED",
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "42501"
    );
  });

  it("(m) 3D Reviewer Enforces Non-Empty Distinct Principals and Distinct Session IDs (FIX-03)", async () => {
    const { store, coreApi, projectId, authAdmin1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authAdmin1, {
      title: "3D principal/session independence test",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
      task_id: task.task_id,
      worker_id: "worker-3d",
    });

    await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      () => {
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
          verifier_image_digest: "sha256:v",
          verdict: "PASS",
          exit_code: 0,
          duration_ms: 100,
          report_sha256: "sha256:r",
        });

        // Same principal rejected
        assert.throws(
          () =>
            store.recordReviewArtifact({
              project_id: projectId,
              task_id: task.task_id,
              merge_candidate_id: mc.merge_candidate_id,
              verification_run_id: vr.verification_run_id,
              merge_candidate_hash: mc.merge_candidate_hash,
              verified_tree_hash: mc.verified_tree_hash,
              writer_provider: "anthropic",
              writer_model: "claude-3-7-sonnet",
              reviewer_provider: "openai",
              reviewer_model: "gpt-4.1",
              developer_principal_id: "same-principal",
              reviewer_principal_id: "same-principal",
              developer_session_id: "sess-1",
              reviewer_session_id: "sess-2",
              verdict: "PASS",
            }),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
        );

        // Same session rejected
        assert.throws(
          () =>
            store.recordReviewArtifact({
              project_id: projectId,
              task_id: task.task_id,
              merge_candidate_id: mc.merge_candidate_id,
              verification_run_id: vr.verification_run_id,
              merge_candidate_hash: mc.merge_candidate_hash,
              verified_tree_hash: mc.verified_tree_hash,
              writer_provider: "anthropic",
              writer_model: "claude-3-7-sonnet",
              reviewer_provider: "openai",
              reviewer_model: "gpt-4.1",
              developer_principal_id: "dev-principal",
              reviewer_principal_id: "rev-principal",
              developer_session_id: "same-sess",
              reviewer_session_id: "same-sess",
              verdict: "PASS",
            }),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
        );

        // Blank session rejected
        assert.throws(
          () =>
            store.recordReviewArtifact({
              project_id: projectId,
              task_id: task.task_id,
              merge_candidate_id: mc.merge_candidate_id,
              verification_run_id: vr.verification_run_id,
              merge_candidate_hash: mc.merge_candidate_hash,
              verified_tree_hash: mc.verified_tree_hash,
              writer_provider: "anthropic",
              writer_model: "claude-3-7-sonnet",
              reviewer_provider: "openai",
              reviewer_model: "gpt-4.1",
              developer_principal_id: "dev-principal",
              reviewer_principal_id: "rev-principal",
              developer_session_id: "   ",
              reviewer_session_id: "sess-2",
              verdict: "PASS",
            }),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
        );
      }
    );
  });

  it("(n) Import Lease Fencing & Empty Changes Rejection (FIX-08 & FIX-10)", async () => {
    // 1. validateGitTreeImport rejects empty changes: []
    const emptyValidation = validateGitTreeImport({
      agent_commit_hash: "a".repeat(40),
      verified_tree_hash: "b".repeat(40),
      parent_commit_hashes: [BASE_MAIN_SHA],
      expected_base_main_commit_hash: BASE_MAIN_SHA,
      contract: M2_CONTRACT,
      changes: [],
    });
    assert.equal(emptyValidation.valid, false);
    if (!emptyValidation.valid) {
      assert.equal(emptyValidation.error_code, "ERR_IMPORT_EMPTY_CHANGES");
    }

    const { store, coreApi, projectId, authAdmin1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authAdmin1, {
      title: "Import lease fencing test",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
      task_id: task.task_id,
      worker_id: "worker-fence",
    });

    const validCandidateInput = {
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
    };

    await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      async () => {
        // Unknown lease rejected (23503)
        assert.throws(
          () =>
            store.recordVerifiedCodeImport({
              project_id: projectId,
              task_id: task.task_id,
              lease_id: "nonexistent-lease-id",
              lease_epoch: lease.lease_epoch,
              staging_ref: `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`,
              candidate_input: validCandidateInput,
            }),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23503"
        );

        // Wrong lease_epoch rejected (23514)
        assert.throws(
          () =>
            store.recordVerifiedCodeImport({
              project_id: projectId,
              task_id: task.task_id,
              lease_id: lease.lease_id,
              lease_epoch: lease.lease_epoch + 1,
              staging_ref: `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch + 1}`,
              candidate_input: validCandidateInput,
            }),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
        );

        // Wrong staging_ref rejected (23514)
        assert.throws(
          () =>
            store.recordVerifiedCodeImport({
              project_id: projectId,
              task_id: task.task_id,
              lease_id: lease.lease_id,
              lease_epoch: lease.lease_epoch,
              staging_ref: "refs/heads/feature/rogue",
              candidate_input: validCandidateInput,
            }),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
        );

        // Revoked lease rejected (23514)
        await store.revokeTaskLease({
          project_id: projectId,
          task_id: task.task_id,
          lease_id: lease.lease_id,
          reason: "TEST_REVOKE",
        });
        assert.throws(
          () =>
            store.recordVerifiedCodeImport({
              project_id: projectId,
              task_id: task.task_id,
              lease_id: lease.lease_id,
              lease_epoch: lease.lease_epoch,
              staging_ref: `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`,
              candidate_input: validCandidateInput,
            }),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
        );
      }
    );
  });

  it("(o) createMergeCandidate Fails Closed Without refs/heads/main & Preserves task.base_main_commit_hash (FIX-12)", async () => {
    const { store, coreApi, projectId, authAdmin1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authAdmin1, {
      title: "Merge candidate base pointer integrity test",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
      task_id: task.task_id,
      worker_id: "worker-mc",
    });

    await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      () => {
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

        // Base mismatch must fail with 23514 and MUST NOT overwrite task.base_main_commit_hash
        const driftedMain = "9999888899998888999988889999888899998888";
        assert.throws(
          () =>
            store.createMergeCandidate({
              project_id: projectId,
              task_id: task.task_id,
              import_id: imp.import_id,
              base_main_commit_hash: driftedMain,
              merge_candidate_hash: "cccc3333cccc3333cccc3333cccc3333cccc3333",
              verified_tree_hash: imp.verified_tree_hash,
            }),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
        );
        assert.equal(store.getTaskById(task.task_id)?.base_main_commit_hash, BASE_MAIN_SHA);

        // verified_tree_hash mismatch must fail with 23514
        assert.throws(
          () =>
            store.createMergeCandidate({
              project_id: projectId,
              task_id: task.task_id,
              import_id: imp.import_id,
              base_main_commit_hash: BASE_MAIN_SHA,
              merge_candidate_hash: "cccc3333cccc3333cccc3333cccc3333cccc3333",
              verified_tree_hash: "0000000000000000000000000000000000000000",
            }),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
        );

        // Deleted refs/heads/main fails closed with 23503 (never falls back to candidate hash)
        store.deleteGitRefForTest(projectId, "refs/heads/main");
        assert.throws(
          () =>
            store.createMergeCandidate({
              project_id: projectId,
              task_id: task.task_id,
              import_id: imp.import_id,
              base_main_commit_hash: BASE_MAIN_SHA,
              merge_candidate_hash: "cccc3333cccc3333cccc3333cccc3333cccc3333",
              verified_tree_hash: imp.verified_tree_hash,
            }),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23503"
        );
      }
    );
  });

  it("(p) Custom Project approval_ttl_seconds, REQUEST_CHANGES Rework Loop & max_rework_cycles Escalation (FIX-22)", async () => {
    const {
      store,
      coreApi,
      gateway,
      webConsole,
      projectId,
      advanceClockMs,
      authAdmin1,
      authApprover1,
    } = createM2Environment(new Date("2026-11-10T10:00:00.000Z"), { approvalTtlSeconds: 120 });

    const task = await coreApi.createTask(projectId, authAdmin1, {
      title: "REQUEST_CHANGES rework cycle test",
      task_contract: M2_CONTRACT,
      max_rework_cycles: 1,
    });
    const submitWorkerStep = async (
      lease: Awaited<ReturnType<typeof coreApi.dispatchTaskLease>>,
      seq: number,
      eventType: "task.accepted" | "task.started" | "task.completed",
      payload: Record<string, unknown>
    ) => {
      const ack = await gateway.submitEvent({
        schema_version: "1.5",
        project_id: projectId,
        task_id: task.task_id,
        attempt_no: lease.attempt_no,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        worker_id: lease.worker_id,
        sequence_no: seq,
        event_type: eventType,
        task_execution_idempotency_key: lease.task_execution_idempotency_key,
        event_idempotency_key: computeEventIdempotencyKey(
          lease.lease_id,
          lease.lease_epoch,
          seq,
          eventType
        ),
        payload_sha256: computeCanonicalPayloadSha256(payload),
        emitted_at: new Date().toISOString(),
        payload,
      });
      assert.equal(ack.ack_status, "ACCEPTED");
    };

    const lease1 = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
      task_id: task.task_id,
      worker_id: "worker-rework-1",
    });
    await submitWorkerStep(lease1, 1, "task.accepted", { attempt: 1 });
    await submitWorkerStep(lease1, 2, "task.started", { attempt: 1 });

    const stagingRef1 = `refs/heads/sf/staging/${task.task_id}/${lease1.lease_epoch}`;
    const agentCommit1 = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const verifiedTree1 = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
    const candidateHash1 = "cccc3333cccc3333cccc3333cccc3333cccc3333";

    await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease1.lease_id,
      lease_epoch: lease1.lease_epoch,
      staging_ref: stagingRef1,
      agent_commit_hash: agentCommit1,
      verified_tree_hash: verifiedTree1,
      parent_commit_hashes: [BASE_MAIN_SHA],
      changes: [
        {
          path: "src/feature.ts",
          mode: "100644",
          size_bytes: 120,
          added_lines: 6,
          deleted_lines: 0,
          is_binary: false,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    await submitWorkerStep(lease1, 3, "task.completed", { agent_commit_hash: agentCommit1 });

    const { mergeCandidate: mc1 } = await coreApi.importAndBuildCandidate(projectId, authAdmin1, {
      task_id: task.task_id,
      lease_id: lease1.lease_id,
      lease_epoch: lease1.lease_epoch,
      staging_ref: stagingRef1,
      base_main_commit_hash: BASE_MAIN_SHA,
      merge_candidate_hash: candidateHash1,
      candidate_input: {
        agent_commit_hash: agentCommit1,
        verified_tree_hash: verifiedTree1,
        parent_commit_hashes: [BASE_MAIN_SHA],
        expected_base_main_commit_hash: BASE_MAIN_SHA,
        contract: M2_CONTRACT,
        changes: [
          {
            path: "src/feature.ts",
            mode: "100644",
            size_bytes: 120,
            added_lines: 6,
            deleted_lines: 0,
            is_binary: false,
            blob_sha: BASE_MAIN_SHA,
          },
        ],
      },
    });

    const { verificationRun: vr1, reviewArtifact: ra1 } =
      await coreApi.recordVerificationAndIndependentReview(projectId, authAdmin1, {
        task_id: task.task_id,
        merge_candidate_id: mc1.merge_candidate_id,
        merge_candidate_hash: mc1.merge_candidate_hash,
        verified_tree_hash: mc1.verified_tree_hash,
        verifier_image_digest: "sha256:v1",
        verification_verdict: "PASS",
        exit_code: 0,
        duration_ms: 100,
        report_sha256: "sha256:r1",
        writer_provider: "anthropic",
        writer_model: "claude-3-7-sonnet",
        reviewer_provider: "openai",
        reviewer_model: "gpt-4.1",
        developer_principal_id: "wna-writer-p",
        reviewer_principal_id: "independent-reviewer-p",
        developer_session_id: "sess-writer-p",
        reviewer_session_id: "sess-reviewer-p",
        review_verdict: "PASS",
      });

    // Request changes via Web Console -> transitions task to ReworkRequired
    const reqChangesApproval = await webConsole.requestChangesWith8FieldBinding({
      auth: authApprover1,
      candidate: mc1,
      verificationRun: vr1,
      reviewArtifact: ra1,
      feedback: "Please add error handling on empty input",
    });
    assert.equal(reqChangesApproval.decision, "REQUEST_CHANGES");

    const taskAfterReqChanges = await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      () => store.getTaskById(task.task_id)
    );
    assert.equal(taskAfterReqChanges?.status, "ReworkRequired");

    // Dispatch rework lease (cycle 1 of max 1): succeeds and increments rework_count to 1
    const lease2 = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
      task_id: task.task_id,
      worker_id: "worker-rework-2",
    });
    await submitWorkerStep(lease2, 1, "task.accepted", { attempt: 2 });
    await submitWorkerStep(lease2, 2, "task.started", { attempt: 2 });
    await gateway.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease2.lease_id,
      lease_epoch: lease2.lease_epoch,
      staging_ref: `refs/heads/sf/staging/${task.task_id}/${lease2.lease_epoch}`,
      agent_commit_hash: "dddd4444dddd4444dddd4444dddd4444dddd4444",
      verified_tree_hash: "eeee5555eeee5555eeee5555eeee5555eeee5555",
      parent_commit_hashes: [BASE_MAIN_SHA],
      changes: [
        {
          path: "src/feature.ts",
          mode: "100644",
          size_bytes: 150,
          added_lines: 10,
          deleted_lines: 0,
          is_binary: false,
          blob_sha: BASE_MAIN_SHA,
        },
      ],
    });
    await submitWorkerStep(lease2, 3, "task.completed", {
      agent_commit_hash: "dddd4444dddd4444dddd4444dddd4444dddd4444",
    });
    const { mergeCandidate: mc2 } = await coreApi.importAndBuildCandidate(projectId, authAdmin1, {
      task_id: task.task_id,
      lease_id: lease2.lease_id,
      lease_epoch: lease2.lease_epoch,
      staging_ref: `refs/heads/sf/staging/${task.task_id}/${lease2.lease_epoch}`,
      base_main_commit_hash: BASE_MAIN_SHA,
      merge_candidate_hash: "ffff6666ffff6666ffff6666ffff6666ffff6666",
      candidate_input: {
        agent_commit_hash: "dddd4444dddd4444dddd4444dddd4444dddd4444",
        verified_tree_hash: "eeee5555eeee5555eeee5555eeee5555eeee5555",
        parent_commit_hashes: [BASE_MAIN_SHA],
        expected_base_main_commit_hash: BASE_MAIN_SHA,
        contract: M2_CONTRACT,
        changes: [
          {
            path: "src/feature.ts",
            mode: "100644",
            size_bytes: 150,
            added_lines: 10,
            deleted_lines: 0,
            is_binary: false,
            blob_sha: BASE_MAIN_SHA,
          },
        ],
      },
    });
    const { verificationRun: vr2, reviewArtifact: ra2 } =
      await coreApi.recordVerificationAndIndependentReview(projectId, authAdmin1, {
        task_id: task.task_id,
        merge_candidate_id: mc2.merge_candidate_id,
        merge_candidate_hash: mc2.merge_candidate_hash,
        verified_tree_hash: mc2.verified_tree_hash,
        verifier_image_digest: "sha256:v2",
        verification_verdict: "PASS",
        exit_code: 0,
        duration_ms: 100,
        report_sha256: "sha256:r2",
        writer_provider: "anthropic",
        writer_model: "claude-3-7-sonnet",
        reviewer_provider: "openai",
        reviewer_model: "gpt-4.1",
        developer_principal_id: "wna-writer-p2",
        reviewer_principal_id: "independent-reviewer-p2",
        developer_session_id: "sess-writer-p2",
        reviewer_session_id: "sess-reviewer-p2",
        review_verdict: "PASS",
      });

    // Verify project.approval_ttl_seconds (120s) is respected when ttlMs is omitted
    const approval2 = await webConsole.approveCandidateWith8FieldBinding({
      auth: authApprover1,
      candidate: mc2,
      verificationRun: vr2,
      reviewArtifact: ra2,
    });
    const ttlDeltaMs = Date.parse(approval2.expires_at) - Date.parse(approval2.approved_at);
    assert.equal(ttlDeltaMs, 120_000);

    // Advance 121s (> 120s project approval TTL) -> executeCasMerge sees APPROVAL_EXPIRED!
    advanceClockMs(121_000);
    const expiredMerge = await coreApi.executeCasMerge(projectId, authAdmin1, {
      task_id: task.task_id,
      merge_candidate_id: mc2.merge_candidate_id,
      approval_id: approval2.approval_id,
    });
    assert.equal(expiredMerge.status, "APPROVAL_EXPIRED");
    assert.equal(expiredMerge.task_status, "AwaitingHumanApproval");

    // Second REQUEST_CHANGES after rework_count == max_rework_cycles escalates immediately to ManualIntervention!
    await webConsole.requestChangesWith8FieldBinding({
      auth: authApprover1,
      candidate: mc2,
      verificationRun: vr2,
      reviewArtifact: ra2,
      feedback: "Still needs work beyond max cycles",
    });
    const escalatedTask = await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      () => store.getTaskById(task.task_id)
    );
    assert.equal(escalatedTask?.status, "ManualIntervention");
    assert.equal(escalatedTask?.rework_count, 1);
  });

  it("(q) Canonical 11 TaskStatus Matrix, Collision-Free canonicalizeJson & Reconciler Strict Ref Match (FIX-21, FIX-25 & FIX-27)", async () => {
    // 1. Canonical 11 TaskStatus values
    const canonicalStatuses: readonly TaskStatus[] = [
      "Ready",
      "Leased",
      "ExecutingInTarget",
      "BuildingMergeCandidate",
      "VerifyingInDocker",
      "UnderIndependentReview",
      "AwaitingHumanApproval",
      "AtomicCasMerge",
      "MergedAndCompleted",
      "ReworkRequired",
      "ManualIntervention",
    ];
    assert.deepEqual(Object.keys(STATE_TRANSITION_MATRIX).sort(), [...canonicalStatuses].sort());
    assert.equal(Object.keys(STATE_TRANSITION_MATRIX).length, 11);

    // 2. Collision-free canonicalizeJson (FIX-25)
    assert.notEqual(canonicalizeJson([undefined]), canonicalizeJson([null]));
    assert.notEqual(
      computeCanonicalPayloadSha256({ arr: [undefined] }),
      computeCanonicalPayloadSha256({ arr: [null] })
    );
    assert.notEqual(canonicalizeJson({ v: Number.NaN }), canonicalizeJson({ v: null }));
    assert.notEqual(
      canonicalizeJson({ v: Number.POSITIVE_INFINITY }),
      canonicalizeJson({ v: Number.NEGATIVE_INFINITY })
    );
    assert.equal(canonicalizeJson({ n: 42n }), '{"n":42n}');

    // 3. Reconciler Path A must NOT match when live staging ref was deleted / does not point to import commit (FIX-27)
    const { store, coreApi, projectId, advanceClockMs, authAdmin1 } = createM2Environment();
    const task = await coreApi.createTask(projectId, authAdmin1, {
      title: "Reconciler strict ref match check",
      task_contract: M2_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectId, authAdmin1, {
      task_id: task.task_id,
      worker_id: "worker-rec",
      heartbeat_interval_ms: 10_000,
      lease_ttl_ms: 30_000,
    });

    await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      () => {
        // Record import directly without pushing live Git ref
        store.recordVerifiedCodeImport({
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
      }
    );

    advanceClockMs(35_000);
    const reconciled = await store.runLeaseExpiryAndOrphanedPushReconciler();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.outcome, "EXPIRED_AND_REQUEUED");

    const updated = await store.withRlsTransaction(
      { currentProjectId: projectId, currentRole: "core_api_service" },
      () => store.getTaskById(task.task_id)
    );
    assert.equal(updated?.status, "Ready");
  });
});
