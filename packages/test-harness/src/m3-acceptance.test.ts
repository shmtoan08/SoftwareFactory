import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "../../shared-types/src/index.ts";
import { type TaskContractSpec } from "../../task-contract/src/index.ts";
import {
  PostgresRlsError,
  type ProjectMemberRole,
  SoftwareFactoryControlPlaneStore,
} from "../../database/src/index.ts";
import {
  Docker3TierVerifier,
  DockerVerifierUnavailableError,
  HardlinkCacheViolationError,
  ImmutableSourceSnapshotStore,
  SnapshotIntegrityError,
  assertZeroHardlinkSharing,
  buildDockerRunSecurityArgs,
  buildRealGitMergeCandidate,
  computeDirectorySha256,
  copyDirectoryWithoutHardlinks,
  extractTier3AssertionEvidence,
  probeDockerVerifierSupport,
  probeLinuxHardlinkSymlinkSysctls,
  sanitizeVerifierEnv,
} from "../../verifier/src/index.ts";
import { LinuxCgroupV2SandboxBackend } from "../../wna/src/index.ts";
import { CoreApiService } from "../../../apps/core-api/src/index.ts";
import { WebApprovalConsoleController } from "../../../apps/web/src/index.ts";

function setupRealGitRepoFixture(initialNow = new Date("2026-11-10T16:00:00.000Z")) {
  const rootDir = mkdtempSync(join(tmpdir(), "sf-m3-fixture-"));
  const bareRepoDir = join(rootDir, "remote.git");
  const mainWorkDir = join(rootDir, "work-main");
  const agentWorkDir = join(rootDir, "work-agent");
  const snapshotStorageDir = join(rootDir, "worm-snapshots");
  const trustedAcceptanceDir = join(rootDir, "trusted-acceptance-policy");

  mkdirSync(bareRepoDir, { recursive: true });
  mkdirSync(trustedAcceptanceDir, { recursive: true });

  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Factory Fixture",
    GIT_AUTHOR_EMAIL: "fixture@software-factory.local",
    GIT_COMMITTER_NAME: "Factory Fixture",
    GIT_COMMITTER_EMAIL: "fixture@software-factory.local",
  };

  const gitAt = (cwd: string, args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      env: gitEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  gitAt(bareRepoDir, ["init", "--bare", "--initial-branch=main"]);
  gitAt(rootDir, ["clone", bareRepoDir, mainWorkDir]);

  mkdirSync(join(mainWorkDir, "src"), { recursive: true });
  mkdirSync(join(mainWorkDir, "tests", "baseline"), { recursive: true });

  writeFileSync(
    join(mainWorkDir, "README.md"),
    "# Pricing Service\n\nBaseline pricing implementation.\n",
    "utf8"
  );
  writeFileSync(
    join(mainWorkDir, "src", "pricing.mjs"),
    [
      "export function calculateDiscount(amount) {",
      "  if (amount <= 0) throw new Error('amount must be positive');",
      "  return Math.round(amount * 0.8);",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(mainWorkDir, "tests", "baseline", "pricing.baseline.spec.mjs"),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { calculateDiscount } from '../../src/pricing.mjs';",
      "",
      "test('baseline throws on non-positive amount', () => {",
      "  assert.throws(() => calculateDiscount(0));",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );

  gitAt(mainWorkDir, ["add", "."]);
  gitAt(mainWorkDir, ["commit", "-m", "chore: initial baseline pricing service"]);
  gitAt(mainWorkDir, ["push", "origin", "main"]);
  const baseMainSha = gitAt(bareRepoDir, ["rev-parse", "refs/heads/main"]);
  const baseTreeSha = gitAt(bareRepoDir, ["rev-parse", `${baseMainSha}^{tree}`]);

  // Write Trusted Acceptance Tests outside the Git repo (mounted :ro by Verifier)
  writeFileSync(
    join(trustedAcceptanceDir, "pricing.acceptance.spec.mjs"),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { pathToFileURL } from 'node:url';",
      "import { join } from 'node:path';",
      "",
      "test('trusted policy requires 25% VIP discount when enabled', async () => {",
      "  const mod = await import(pathToFileURL(join(process.cwd(), 'src', 'pricing.mjs')).href);",
      "  assert.equal(mod.calculateDiscount(100, { vip: false }), 80);",
      "  assert.equal(mod.calculateDiscount(100, { vip: true }), 75);",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );
  const trustedPolicySha256 = computeDirectorySha256(trustedAcceptanceDir);

  gitAt(rootDir, ["clone", bareRepoDir, agentWorkDir]);

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
        project_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        slug: "m3-verifier-project",
        name: "Milestone M3 Project",
        repo_bare_path: bareRepoDir,
        initial_main_commit_hash: baseMainSha,
        initial_main_tree_hash: baseTreeSha,
        approval_ttl_seconds: 3600,
      });
      projectId = proj.project_id;
      for (const [principal_id, member_role] of [
        ["op-1", "ORG_ADMIN"],
        ["approver-1", "PROJECT_APPROVER"],
        ["dev-1", "DEVELOPER"],
      ] as const) {
        store.addProjectMembership({
          project_id: projectId,
          principal_id,
          member_role,
        });
      }
    }
  );

  const snapshotStore = new ImmutableSourceSnapshotStore({
    storageDir: snapshotStorageDir,
  });
  const verifier = new Docker3TierVerifier({ snapshotStore });
  const coreApi = new CoreApiService(store, { snapshotStore });
  const webConsole = new WebApprovalConsoleController(coreApi);
  const authOp1 = coreApi.issueAuthContext({
    projectId,
    principalId: "op-1",
    roles: ["ORG_ADMIN"] as readonly ProjectMemberRole[],
  });
  const authApprover1 = coreApi.issueAuthContext({
    projectId,
    principalId: "approver-1",
    roles: ["PROJECT_APPROVER"] as readonly ProjectMemberRole[],
  });

  const contract: TaskContractSpec = {
    allowed_files: ["src/**"],
    protected_paths: ["tests/baseline/**"],
    forbidden_paths: ["secrets/**"],
    trusted_policy_sha256: trustedPolicySha256,
    max_changed_files: 10,
    max_deleted_lines: 100,
    max_binary_bytes: 65_536,
    allow_binary_files: false,
  };

  return {
    rootDir,
    bareRepoDir,
    mainWorkDir,
    agentWorkDir,
    snapshotStorageDir,
    trustedAcceptanceDir,
    trustedPolicySha256,
    baseMainSha,
    baseTreeSha,
    gitAt,
    store,
    advanceClockMs,
    projectId,
    snapshotStore,
    verifier,
    coreApi,
    webConsole,
    authOp1,
    authApprover1,
    contract,
  };
}

describe("Milestone M3 Acceptance Gate Suite (Candidate Builder + 3-Tier Trusted Verifier)", () => {
  it("M3-Gate-1: Real Git Merge Candidate Builder merges onto live B_base, sets 2 parents, and handles Git merge conflicts into ReworkRequired", async () => {
    const fx = setupRealGitRepoFixture();
    try {
      const task = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "Implement VIP pricing",
        task_contract: fx.contract,
        base_main_commit_hash: fx.baseMainSha,
      });

      // 1. Agent creates clean change in src/pricing.mjs based on B_0
      writeFileSync(
        join(fx.agentWorkDir, "src", "pricing.mjs"),
        [
          "export function calculateDiscount(amount, opts = {}) {",
          "  if (amount <= 0) throw new Error('amount must be positive');",
          "  return opts.vip ? Math.round(amount * 0.75) : Math.round(amount * 0.8);",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );
      fx.gitAt(fx.agentWorkDir, ["add", "src/pricing.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "feat: add vip discount"]);
      const agentCommitSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);
      fx.gitAt(fx.agentWorkDir, [
        "push",
        "origin",
        `${agentCommitSha}:refs/factory/Verify/${task.task_id}/1`,
      ]);

      // 2. Concurrent commit advances main in README.md (non-conflicting with src/pricing.mjs!)
      writeFileSync(
        join(fx.mainWorkDir, "README.md"),
        "# Pricing Service v1.1\n\nNon-conflicting concurrent docs update.\n",
        "utf8"
      );
      fx.gitAt(fx.mainWorkDir, ["add", "README.md"]);
      fx.gitAt(fx.mainWorkDir, ["commit", "-m", "docs: bump version note"]);
      fx.gitAt(fx.mainWorkDir, ["push", "origin", "main"]);
      const advancedMainSha = fx.gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]);
      assert.notEqual(advancedMainSha, fx.baseMainSha);

      // 3. Build C_candidate on top of live B_latest without modifying agent branch
      const built = buildRealGitMergeCandidate({
        repoPath: fx.bareRepoDir,
        taskId: task.task_id,
        agentCommitHash: agentCommitSha,
        snapshotStore: fx.snapshotStore,
      });
      assert.equal(built.ok, true);
      if (!built.ok) return;

      assert.equal(built.baseMainCommitHash, advancedMainSha);
      assert.equal(built.agentCommitHash, agentCommitSha);
      assert.notEqual(built.mergeCandidateHash, agentCommitSha);
      assert.equal(
        fx.gitAt(fx.bareRepoDir, ["rev-parse", `${built.candidateRef}^{commit}`]),
        built.mergeCandidateHash
      );

      const parentsLine = fx.gitAt(fx.bareRepoDir, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        built.mergeCandidateHash,
      ]);
      const parents = parentsLine.split(/\s+/).slice(1);
      assert.deepEqual(parents, [advancedMainSha, agentCommitSha]);

      // Verify C_candidate tree contains BOTH README change from B_latest AND pricing change from C_agent
      const mergedReadme = fx.gitAt(fx.bareRepoDir, [
        "show",
        `${built.mergeCandidateHash}:README.md`,
      ]);
      assert.match(mergedReadme, /Pricing Service v1\.1/);
      const mergedPricing = fx.gitAt(fx.bareRepoDir, [
        "show",
        `${built.mergeCandidateHash}:src/pricing.mjs`,
      ]);
      assert.match(mergedPricing, /opts\.vip/);

      // 4. Advance main with a conflicting edit in src/pricing.mjs -> MERGE_CONFLICT
      writeFileSync(
        join(fx.mainWorkDir, "src", "pricing.mjs"),
        [
          "export function calculateDiscount(amount) {",
          "  if (amount <= 0) throw new Error('positive required');",
          "  return Math.round(amount * 0.9);",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );
      fx.gitAt(fx.mainWorkDir, ["add", "src/pricing.mjs"]);
      fx.gitAt(fx.mainWorkDir, ["commit", "-m", "refactor: incompatible discount change"]);
      fx.gitAt(fx.mainWorkDir, ["push", "origin", "main"]);

      const conflictBuild = buildRealGitMergeCandidate({
        repoPath: fx.bareRepoDir,
        taskId: task.task_id,
        agentCommitHash: agentCommitSha,
      });
      assert.equal(conflictBuild.ok, false);
      if (conflictBuild.ok) return;
      assert.equal(conflictBuild.reason, "MERGE_CONFLICT");
      assert.ok(conflictBuild.conflictedFiles.includes("src/pricing.mjs"));

      const conflictRes = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "op-1",
          currentRole: "core_api_service",
        },
        () =>
          fx.store.markMergeConflictReworkRequired({
            project_id: fx.projectId,
            task_id: task.task_id,
            agent_commit_hash: agentCommitSha,
            base_main_commit_hash: conflictBuild.baseMainCommitHash,
            conflicted_files: conflictBuild.conflictedFiles,
            conflict_summary: conflictBuild.conflictSummary,
          })
      );
      assert.equal(conflictRes.task_status, "ReworkRequired");
      assert.deepEqual(conflictRes.conflicted_files, ["src/pricing.mjs"]);
    } finally {
      rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });

  it("M3-Gate-2: Immutable .tar WORM Snapshot (0o444, zero .git, SHA-256 tamper fail-closed) and 14-Day vs MERGED Permanent GC", async () => {
    const fx = setupRealGitRepoFixture();
    try {
      // Create two distinct candidate commits
      writeFileSync(join(fx.agentWorkDir, "src", "c1.mjs"), "export const c = 1;\n", "utf8");
      fx.gitAt(fx.agentWorkDir, ["add", "src/c1.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "candidate 1"]);
      const c1 = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${c1}:refs/factory/Verify/t1/1`]);

      fx.gitAt(fx.agentWorkDir, ["reset", "--hard", fx.baseMainSha]);
      writeFileSync(join(fx.agentWorkDir, "src", "c2.mjs"), "export const c = 2;\n", "utf8");
      fx.gitAt(fx.agentWorkDir, ["add", "src/c2.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "candidate 2"]);
      const c2 = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${c2}:refs/factory/Verify/t2/1`]);

      const t0 = new Date("2026-11-10T00:00:00.000Z");
      const built1 = buildRealGitMergeCandidate({
        repoPath: fx.bareRepoDir,
        taskId: "t1",
        agentCommitHash: c1,
        snapshotStore: fx.snapshotStore,
        createdAt: t0,
      });
      const built2 = buildRealGitMergeCandidate({
        repoPath: fx.bareRepoDir,
        taskId: "t2",
        agentCommitHash: c2,
        snapshotStore: fx.snapshotStore,
        createdAt: t0,
      });
      assert.equal(built1.ok, true);
      assert.equal(built2.ok, true);
      if (!built1.ok || !built2.ok) return;

      const snap1 = built1.snapshotPath!;
      const snap2 = built2.snapshotPath!;
      assert.ok(existsSync(snap1));
      assert.equal(lstatSync(snap1).mode & 0o777, 0o444);

      // Verify clean extraction and absence of `.git`
      const extractOkDir = join(fx.rootDir, "extracted-ok");
      const extracted = fx.snapshotStore.verifyAndExtractSnapshot({
        snapshotPath: snap1,
        expectedSha256: built1.snapshotSha256!,
        targetDir: extractOkDir,
      });
      assert.equal(extracted.verifiedSha256, built1.snapshotSha256);
      assert.equal(
        extracted.extractedEntries.some((e) => e.split("/").includes(".git")),
        false
      );

      // Verify 1-byte / writable-mode tamper detection fails closed BEFORE extraction
      assert.throws(
        () =>
          fx.snapshotStore.verifyAndExtractSnapshot({
            snapshotPath: snap1,
            expectedSha256: "f".repeat(64),
            targetDir: join(fx.rootDir, "extracted-bad-sha"),
          }),
        (err: unknown) =>
          err instanceof SnapshotIntegrityError && err.code === "ERR_SNAPSHOT_INTEGRITY_MISMATCH"
      );

      chmodSync(snap1, 0o644);
      assert.throws(
        () =>
          fx.snapshotStore.verifyAndExtractSnapshot({
            snapshotPath: snap1,
            expectedSha256: built1.snapshotSha256!,
            targetDir: join(fx.rootDir, "extracted-writable"),
          }),
        (err: unknown) =>
          err instanceof SnapshotIntegrityError && err.code === "ERR_SNAPSHOT_NOT_READONLY"
      );
      chmodSync(snap1, 0o444);

      // Mark snap2 MERGED_PERMANENT while snap1 stays EPHEMERAL_14D
      fx.snapshotStore.markMergedPermanent(snap2);

      // Day 13: both survive
      const gcDay13 = fx.snapshotStore.pruneExpiredSnapshots(
        new Date(t0.getTime() + 13 * 86_400_000)
      );
      assert.equal(gcDay13.deletedPaths.length, 0);
      assert.ok(gcDay13.retainedActivePaths.includes(snap1));
      assert.ok(gcDay13.retainedPermanentPaths.includes(snap2));

      // Day 15: snap1 deleted, snap2 retained forever!
      const gcDay15 = fx.snapshotStore.pruneExpiredSnapshots(
        new Date(t0.getTime() + 15 * 86_400_000)
      );
      assert.deepEqual(gcDay15.deletedPaths, [snap1]);
      assert.deepEqual(gcDay15.retainedPermanentPaths, [snap2]);
      assert.equal(existsSync(snap1), false);
      assert.equal(existsSync(snap2), true);
    } finally {
      rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });

  it("M3-Gate-3 (FAH-01A): Dishonest Agent with broken logic + trivial test fails Tier 1 Trusted Acceptance Tests and blocks trusted_policy_sha256 tampering", async () => {
    const fx = setupRealGitRepoFixture();
    try {
      const task = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "FAH-01A Broken logic + empty agent test",
        task_contract: fx.contract,
        base_main_commit_hash: fx.baseMainSha,
      });
      const lease = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        worker_id: "worker-fah-01a",
      });

      // Agent returns hardcoded 0 for VIP discount & writes always-pass agent test
      writeFileSync(
        join(fx.agentWorkDir, "src", "pricing.mjs"),
        [
          "export function calculateDiscount(amount) {",
          "  if (amount <= 0) throw new Error('amount must be positive');",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );
      writeFileSync(
        join(fx.agentWorkDir, "src", "pricing.agent.spec.mjs"),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "",
          "test('agent always-pass empty check', () => {",
          "  assert.equal(1, 1);",
          "});",
          "",
        ].join("\n"),
        "utf8"
      );
      fx.gitAt(fx.agentWorkDir, ["add", "src/pricing.mjs", "src/pricing.agent.spec.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "cheat: return 0 with trivial test"]);
      const agentCommitSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);
      const stagingRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${agentCommitSha}:${stagingRef}`]);

      const res = await fx.coreApi.buildAndVerifyMergeCandidateFromGit(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: stagingRef,
        agent_commit_hash: agentCommitSha,
        repo_path: fx.bareRepoDir,
        verifier: fx.verifier,
        trusted_acceptance_dir: fx.trustedAcceptanceDir,
        execution_mode: "subprocess",
        tier1_command: {
          command: process.execPath,
          args: ["--test", `${join(fx.trustedAcceptanceDir, "pricing.acceptance.spec.mjs")}`],
        },
        tier2_command: {
          command: process.execPath,
          args: ["--test", "tests/baseline/pricing.baseline.spec.mjs"],
        },
        tier3_command: {
          command: process.execPath,
          args: ["--test", "src/pricing.agent.spec.mjs"],
        },
      });

      assert.equal(res.ok, true);
      if (!res.ok) return;

      assert.equal(res.finalRun.verdict, "FAIL");
      assert.equal(res.finalRun.overall_status, "FAILED_ACCEPTANCE");
      assert.equal(res.finalRun.tier1_trusted_acceptance_passed, false);
      assert.equal(res.finalRun.tier3_agent_tests_passed, true);
      assert.equal(res.taskStatus, "ReworkRequired");

      // Also verify fail-closed ERR_TRUSTED_POLICY_SHA256_MISMATCH when trusted policy changes unexpectedly
      const attemptMismatch = await fx.verifier.runSingleAttempt({
        projectId: fx.projectId,
        taskId: task.task_id,
        mergeCandidateId: res.mergeCandidate.merge_candidate_id,
        mergeCandidateHash: res.mergeCandidate.merge_candidate_hash,
        verifiedTreeHash: res.mergeCandidate.verified_tree_hash,
        baseMainCommitHash: res.mergeCandidate.base_main_commit_hash,
        taskContract: fx.contract,
        snapshotPath: res.mergeCandidate.snapshot_path!,
        snapshotSha256: res.mergeCandidate.snapshot_sha256!,
        trustedAcceptanceDir: fx.trustedAcceptanceDir,
        expectedTrustedPolicySha256: "0".repeat(64),
        repoPath: fx.bareRepoDir,
        executionMode: "subprocess",
        tier1Command: { command: process.execPath, args: ["--version"] },
      });
      assert.equal(attemptMismatch.verdict, "FAIL");
      assert.equal(attemptMismatch.overallStatus, "FAILED_ACCEPTANCE");
      assert.equal(attemptMismatch.trustedPolicyMatched, false);
      assert.match(attemptMismatch.errorMessage ?? "", /ERR_TRUSTED_POLICY_SHA256_MISMATCH/);
    } finally {
      rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });

  it("M3-Gate-4 (FAH-01B): Protected Baseline 1-byte tampering is detected BEFORE test execution with TEST_TAMPERING_DETECTED", async () => {
    const fx = setupRealGitRepoFixture();
    try {
      const task = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "FAH-01B Baseline test tampering",
        task_contract: fx.contract,
        base_main_commit_hash: fx.baseMainSha,
      });
      const lease = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        worker_id: "worker-fah-01b",
      });

      // Mutate 1 byte in tests/baseline/pricing.baseline.spec.mjs (changing comment/check)
      const baselineFile = join(
        fx.agentWorkDir,
        "tests",
        "baseline",
        "pricing.baseline.spec.mjs"
      );
      writeFileSync(
        baselineFile,
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { calculateDiscount } from '../../src/pricing.mjs';",
          "",
          "test('baseline throws on non-positive amount ', () => {",
          "  assert.throws(() => calculateDiscount(0));",
          "});",
          "",
        ].join("\n"),
        "utf8"
      );
      fx.gitAt(fx.agentWorkDir, ["add", "tests/baseline/pricing.baseline.spec.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "tamper baseline file by 1 byte"]);
      const tamperedCommitSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);
      const stagingRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${tamperedCommitSha}:${stagingRef}`]);

      // Bypass gatekeeper validation directly via synthetic candidate_input to test Verifier defense-in-depth!
      const built = await fx.coreApi.buildMergeCandidateFromGit(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: stagingRef,
        agent_commit_hash: tamperedCommitSha,
        repo_path: fx.bareRepoDir,
        candidate_input: {
          agent_commit_hash: tamperedCommitSha,
          verified_tree_hash: fx.gitAt(fx.bareRepoDir, [
            "rev-parse",
            `${tamperedCommitSha}^{tree}`,
          ]),
          parent_commit_hashes: [fx.baseMainSha],
          expected_base_main_commit_hash: fx.baseMainSha,
          contract: fx.contract,
          changes: [
            {
              path: "src/pricing.mjs",
              mode: "100644",
              size_bytes: 120,
              added_lines: 1,
              deleted_lines: 0,
              is_binary: false,
              blob_sha: sha256Hex("b").slice(0, 40),
            },
          ],
        },
      });
      assert.equal(built.ok, true);
      if (!built.ok) return;

      // Side-effect marker file proves Tier 1 command did NOT run after tamper pre-check
      const ranMarker = join(fx.rootDir, "tier1-should-not-run.marker");
      const verifyRes = await fx.coreApi.verifyMergeCandidate(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        merge_candidate_id: built.mergeCandidate.merge_candidate_id,
        verifier: fx.verifier,
        trusted_acceptance_dir: fx.trustedAcceptanceDir,
        repo_path: fx.bareRepoDir,
        execution_mode: "subprocess",
        tier1_command: {
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(ranMarker)}, 'executed')`,
          ],
        },
      });

      assert.equal(existsSync(ranMarker), false, "Verifier must abort before running tests on tamper");
      assert.equal(verifyRes.finalRun.verdict, "FAIL");
      assert.equal(verifyRes.finalRun.overall_status, "TEST_TAMPERING_DETECTED");
      assert.equal(verifyRes.finalRun.tier2_baseline_tamper_detected, true);
      assert.deepEqual(verifyRes.finalRun.tampered_baseline_paths, [
        "tests/baseline/pricing.baseline.spec.mjs",
      ]);
      assert.equal(verifyRes.finalRun.tier1_trusted_acceptance_passed, null);
      assert.equal(verifyRes.taskStatus, "ReworkRequired");

      // DB store invariant blocks forging PASS when tamper is flagged
      await assert.rejects(
        () =>
          fx.store.withRlsTransaction(
            {
              currentProjectId: fx.projectId,
              currentPrincipalId: "op-1",
              currentRole: "core_api_service",
            },
            () =>
              fx.store.recordVerificationRun({
                project_id: fx.projectId,
                task_id: task.task_id,
                merge_candidate_id: built.mergeCandidate.merge_candidate_id,
                merge_candidate_hash: built.mergeCandidate.merge_candidate_hash,
                verified_tree_hash: built.mergeCandidate.verified_tree_hash,
                verifier_image_digest: "sha256:forge",
                verdict: "PASS",
                overall_status: "PASSED",
                tier2_baseline_tamper_detected: true,
                exit_code: 0,
                duration_ms: 10,
                report_sha256: sha256Hex("forged"),
              })
          ),
        (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
      );
    } finally {
      rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });

  it("M3-Gate-5 (FAH-01C pre-capture + No-Hardlink Cache + Secret Stripping + Hardened Docker Security Flags)", async () => {
    const fx = setupRealGitRepoFixture();
    try {
      // 1. Assert Docker CLI security args match MVP-SPEC-04 §2.1
      const dockerArgs = buildDockerRunSecurityArgs({
        containerName: "sf-sec-check",
        dockerImage: "node:22-alpine",
        baselineDir: "/tmp/base",
        trustedAcceptanceDir: "/tmp/policy",
        depsCacheDir: "/tmp/deps",
        command: ["node", "--version"],
      });
      for (const requiredFlag of [
        "--rm",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--pids-limit=512",
        "--memory=4g",
        "--memory-swap=4g",
        "--cpus=2",
        "--network=none",
      ]) {
        assert.ok(dockerArgs.includes(requiredFlag), `Missing hardened Docker flag ${requiredFlag}`);
      }
      assert.ok(dockerArgs.some((a) => a.includes("dst=/workspace/baseline,readonly")));
      assert.ok(dockerArgs.some((a) => a.includes("dst=/trusted-policy/acceptance-tests,readonly")));
      assert.ok(dockerArgs.some((a) => a.includes("dst=/workspace/deps-cache,readonly")));
      assert.ok(dockerArgs.includes("/workspace/run:rw,nosuid,nodev,size=512m"));

      // Probe sysctl values without crashing on macOS
      const sysctls = probeLinuxHardlinkSymlinkSysctls();
      assert.equal(sysctls.supported, process.platform === "linux");

      // 2. Verify no-hardlink dependency cache copy & poisoning rejection
      const depsCacheDir = join(fx.rootDir, "deps-cache");
      const isolatedRunDir = join(fx.rootDir, "isolated-run");
      mkdirSync(join(depsCacheDir, "pkg"), { recursive: true });
      const cachedDepFile = join(depsCacheDir, "pkg", "index.js");
      writeFileSync(cachedDepFile, "module.exports = { ok: true };\n", "utf8");
      copyDirectoryWithoutHardlinks(depsCacheDir, isolatedRunDir);
      assertZeroHardlinkSharing(isolatedRunDir, depsCacheDir);

      // Injecting a real POSIX hardlink inside run pointing to depsCache triggers HardlinkCacheViolationError
      const poisonedTarget = join(isolatedRunDir, "poison.js");
      linkSync(cachedDepFile, poisonedTarget);
      assert.throws(
        () => assertZeroHardlinkSharing(isolatedRunDir, depsCacheDir),
        (err: unknown) =>
          err instanceof HardlinkCacheViolationError &&
          err.code === "ERR_HARDLINK_CACHE_VIOLATION"
      );
      rmSync(poisonedTarget);

      // 3. Tier 3 Assertion Extraction captures it.skip & trivial assertions + secret stripping
      const candDir = join(fx.rootDir, "tier3-cand");
      mkdirSync(join(candDir, "src"), { recursive: true });
      mkdirSync(join(candDir, "tests", "baseline"), { recursive: true });
      writeFileSync(
        join(candDir, "tests", "baseline", "pricing.baseline.spec.mjs"),
        "assert.ok(true);\n",
        "utf8"
      );
      writeFileSync(
        join(candDir, "src", "pricing.agent.spec.mjs"),
        [
          "it.skip('should handle edge case', () => {",
          "  expect(true).toBe(true);",
          "});",
          "test('trivial function check', () => {",
          "  expect(typeof fn).toBe('function');",
          "});",
          "",
        ].join("\n"),
        "utf8"
      );
      const extractedTier3 = extractTier3AssertionEvidence(
        candDir,
        undefined,
        fx.contract.protected_paths
      );
      assert.equal(extractedTier3.length, 1);
      assert.equal(extractedTier3[0]!.filePath, "src/pricing.agent.spec.mjs");
      assert.ok(extractedTier3[0]!.skippedPatterns.some((s) => s.includes("it.skip")));
      assert.ok(
        extractedTier3[0]!.trivialPatterns.some((s) => s.includes("expect(true).toBe(true)"))
      );
      assert.equal(extractedTier3[0]!.hasRealAssertions, false);

      // 4. Verify secret stripping inside running verifier tier process (without violating secret scanner)
      const prevEnvVal = process.env.SF_CONTROL_PLANE_ADMIN_SECRET;
      process.env.SF_CONTROL_PLANE_ADMIN_SECRET = "dummy-non-secret-check-value";
      try {
        const task = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
          title: "Secret stripping + clean deps check",
          task_contract: fx.contract,
          base_main_commit_hash: fx.baseMainSha,
        });
        const lease = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp1, {
          task_id: task.task_id,
          worker_id: "worker-secrets",
        });

        writeFileSync(
          join(fx.agentWorkDir, "src", "pricing.mjs"),
          [
            "export function calculateDiscount(amount, opts = {}) {",
            "  if (amount <= 0) throw new Error('amount must be positive');",
            "  return opts.vip ? Math.round(amount * 0.75) : Math.round(amount * 0.8);",
            "}",
            "",
          ].join("\n"),
          "utf8"
        );
        fx.gitAt(fx.agentWorkDir, ["add", "src/pricing.mjs"]);
        fx.gitAt(fx.agentWorkDir, ["commit", "-m", "feat: valid vip implementation"]);
        const agentCommitSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);
        const stagingRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
        fx.gitAt(fx.agentWorkDir, ["push", "origin", `${agentCommitSha}:${stagingRef}`]);

        const verifyOut = await fx.coreApi.buildAndVerifyMergeCandidateFromGit(
          fx.projectId,
          fx.authOp1,
          {
            task_id: task.task_id,
            lease_id: lease.lease_id,
            lease_epoch: lease.lease_epoch,
            staging_ref: stagingRef,
            agent_commit_hash: agentCommitSha,
            repo_path: fx.bareRepoDir,
            verifier: fx.verifier,
            trusted_acceptance_dir: fx.trustedAcceptanceDir,
            deps_cache_dir: depsCacheDir,
            execution_mode: "subprocess",
            extra_env: {
              OPENAI_API_KEY: "dummy-forbidden-key",
              SAFE_PUBLIC_FLAG: "enabled",
            },
            tier1_command: {
              command: process.execPath,
              args: [
                "--test",
                join(fx.trustedAcceptanceDir, "pricing.acceptance.spec.mjs"),
              ],
            },
            tier3_command: {
              command: process.execPath,
              args: [
                "-e",
                [
                  "const assert = require('node:assert/strict');",
                  "assert.equal(process.env.SF_CONTROL_PLANE_ADMIN_SECRET, undefined);",
                  "assert.equal(process.env.OPENAI_API_KEY, undefined);",
                  "assert.equal(process.env.SAFE_PUBLIC_FLAG, 'enabled');",
                ].join(" "),
              ],
            },
          }
        );

        assert.equal(verifyOut.ok, true);
        if (!verifyOut.ok) return;
        assert.equal(verifyOut.finalRun.verdict, "PASS");
        assert.equal(verifyOut.finalRun.hardlink_cache_forbidden, true);
      } finally {
        if (prevEnvVal === undefined) {
          delete process.env.SF_CONTROL_PLANE_ADMIN_SECRET;
        } else {
          process.env.SF_CONTROL_PLANE_ADMIN_SECRET = prevEnvVal;
        }
      }
    } finally {
      rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });

  it("M3-Gate-6 (P0-3): TEST_TIMEOUT triggers immediate ReworkRequired (no retry), while INFRA_ERROR auto-retries up to 2 times without incrementing rework_count", async () => {
    const fx = setupRealGitRepoFixture();
    try {
      // Valid implementation push reused across timeout vs infra scenarios
      writeFileSync(
        join(fx.agentWorkDir, "src", "pricing.mjs"),
        [
          "export function calculateDiscount(amount, opts = {}) {",
          "  if (amount <= 0) throw new Error('amount must be positive');",
          "  return opts.vip ? Math.round(amount * 0.75) : Math.round(amount * 0.8);",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );
      fx.gitAt(fx.agentWorkDir, ["add", "src/pricing.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "feat: valid vip implementation"]);
      const agentCommitSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);

      // Scenario A: TEST_TIMEOUT -> 1 run, immediate ReworkRequired
      const tTimeout = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "P0-3 TEST_TIMEOUT test",
        task_contract: fx.contract,
        base_main_commit_hash: fx.baseMainSha,
      });
      const lTimeout = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp1, {
        task_id: tTimeout.task_id,
        worker_id: "w-timeout",
      });
      const refA = `refs/factory/Verify/${tTimeout.task_id}/1`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${agentCommitSha}:${refA}`]);

      const timeoutRes = await fx.coreApi.buildAndVerifyMergeCandidateFromGit(
        fx.projectId,
        fx.authOp1,
        {
          task_id: tTimeout.task_id,
          lease_id: lTimeout.lease_id,
          lease_epoch: lTimeout.lease_epoch,
          staging_ref: refA,
          agent_commit_hash: agentCommitSha,
          repo_path: fx.bareRepoDir,
          verifier: fx.verifier,
          trusted_acceptance_dir: fx.trustedAcceptanceDir,
          execution_mode: "subprocess",
          step_timeout_ms: 250,
          tier1_command: {
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
          },
        }
      );
      assert.equal(timeoutRes.ok, true);
      if (!timeoutRes.ok) return;
      assert.equal(timeoutRes.allRuns.length, 1);
      assert.equal(timeoutRes.finalRun.overall_status, "TEST_TIMEOUT");
      assert.equal(timeoutRes.taskStatus, "ReworkRequired");

      // Scenario B: Transient INFRA_ERROR retries 2 times and PASSES on attempt 2 without touching rework_count
      const tRecover = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "P0-3 INFRA_ERROR auto-recovery test",
        task_contract: fx.contract,
        base_main_commit_hash: fx.baseMainSha,
      });
      const lRecover = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp1, {
        task_id: tRecover.task_id,
        worker_id: "w-recover",
      });
      const refB = `refs/factory/Verify/${tRecover.task_id}/1`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${agentCommitSha}:${refB}`]);

      const recoverRes = await fx.coreApi.buildAndVerifyMergeCandidateFromGit(
        fx.projectId,
        fx.authOp1,
        {
          task_id: tRecover.task_id,
          lease_id: lRecover.lease_id,
          lease_epoch: lRecover.lease_epoch,
          staging_ref: refB,
          agent_commit_hash: agentCommitSha,
          repo_path: fx.bareRepoDir,
          verifier: fx.verifier,
          trusted_acceptance_dir: fx.trustedAcceptanceDir,
          execution_mode: "subprocess",
          max_infra_retries: 2,
          infra_error_hook: (attempt) => attempt < 2,
          tier1_command: {
            command: process.execPath,
            args: ["--test", join(fx.trustedAcceptanceDir, "pricing.acceptance.spec.mjs")],
          },
        }
      );
      assert.equal(recoverRes.ok, true);
      if (!recoverRes.ok) return;
      assert.equal(recoverRes.allRuns.length, 3);
      assert.equal(recoverRes.allRuns[0]!.overall_status, "INFRA_ERROR");
      assert.equal(recoverRes.allRuns[1]!.overall_status, "INFRA_ERROR");
      assert.equal(recoverRes.finalRun.overall_status, "PASSED");
      assert.equal(recoverRes.finalRun.infra_retry_count, 2);
      assert.equal(recoverRes.taskStatus, "UnderIndependentReview");
      const recoveredTask = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "op-1",
          currentRole: "core_api_service",
        },
        () => fx.store.getTaskById(tRecover.task_id)
      );
      assert.equal(recoveredTask?.rework_count, 0);

      // Scenario C: Persistent INFRA_ERROR exhausts 2 retries -> ManualIntervention with rework_count === 0
      const tExhaust = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "P0-3 INFRA_ERROR exhausted test",
        task_contract: fx.contract,
        base_main_commit_hash: fx.baseMainSha,
      });
      // M6C-FIX-01: seed a legacy overlapping lease to isolate verifier retry
      // exhaustion from the new public dispatch exclusion rule.
      const lExhaust = await fx.store.withRlsTransaction(
        { currentProjectId: fx.projectId, currentRole: "core_api_service" },
        () => fx.store.grantTaskLease({ project_id: fx.projectId, task_id: tExhaust.task_id,
          worker_id: "w-exhaust", reject_overlapping_active_files: false }));
      const refC = `refs/factory/Verify/${tExhaust.task_id}/1`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${agentCommitSha}:${refC}`]);

      const exhaustRes = await fx.coreApi.buildAndVerifyMergeCandidateFromGit(
        fx.projectId,
        fx.authOp1,
        {
          task_id: tExhaust.task_id,
          lease_id: lExhaust.lease_id,
          lease_epoch: lExhaust.lease_epoch,
          staging_ref: refC,
          agent_commit_hash: agentCommitSha,
          repo_path: fx.bareRepoDir,
          verifier: fx.verifier,
          trusted_acceptance_dir: fx.trustedAcceptanceDir,
          execution_mode: "subprocess",
          max_infra_retries: 2,
          infra_error_hook: () => true,
          tier1_command: {
            command: process.execPath,
            args: ["--version"],
          },
        }
      );
      assert.equal(exhaustRes.ok, true);
      if (!exhaustRes.ok) return;
      assert.equal(exhaustRes.allRuns.length, 3);
      assert.equal(exhaustRes.finalRun.overall_status, "INFRA_ERROR");
      assert.equal(exhaustRes.finalRun.infra_retry_count, 2);
      assert.equal(exhaustRes.taskStatus, "ManualIntervention");
      const exhaustedTask = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "op-1",
          currentRole: "core_api_service",
        },
        () => fx.store.getTaskById(tExhaust.task_id)
      );
      assert.equal(exhaustedTask?.rework_count, 0);
    } finally {
      rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });

  it("M3-Gate-7: Honest non-Docker fallback telemetry, requireDocker fail-closed guard, and real Docker hardened execution when daemon + node image available", async () => {
    const fx = setupRealGitRepoFixture();
    try {
      const task = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "Docker isolation telemetry & probe test",
        task_contract: fx.contract,
        base_main_commit_hash: fx.baseMainSha,
      });
      const lease = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        worker_id: "worker-docker-probe",
      });

      writeFileSync(
        join(fx.agentWorkDir, "src", "pricing.mjs"),
        [
          "export function calculateDiscount(amount, opts = {}) {",
          "  if (amount <= 0) throw new Error('amount must be positive');",
          "  return opts.vip ? Math.round(amount * 0.75) : Math.round(amount * 0.8);",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );
      fx.gitAt(fx.agentWorkDir, ["add", "src/pricing.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "feat: valid vip"]);
      const agentCommitSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);
      const stagingRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${agentCommitSha}:${stagingRef}`]);

      const built = await fx.coreApi.buildMergeCandidateFromGit(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: stagingRef,
        agent_commit_hash: agentCommitSha,
        repo_path: fx.bareRepoDir,
      });
      assert.equal(built.ok, true);
      if (!built.ok) return;

      // 1. Fail-closed when requireDocker=true against missing image / offline daemon
      await assert.rejects(
        () =>
          fx.verifier.runSingleAttempt({
            projectId: fx.projectId,
            taskId: task.task_id,
            mergeCandidateId: built.mergeCandidate.merge_candidate_id,
            mergeCandidateHash: built.mergeCandidate.merge_candidate_hash,
            verifiedTreeHash: built.mergeCandidate.verified_tree_hash,
            baseMainCommitHash: built.mergeCandidate.base_main_commit_hash,
            taskContract: fx.contract,
            snapshotPath: built.mergeCandidate.snapshot_path!,
            snapshotSha256: built.mergeCandidate.snapshot_sha256!,
            trustedAcceptanceDir: fx.trustedAcceptanceDir,
            repoPath: fx.bareRepoDir,
            dockerImage: "sf-nonexistent-verifier:never-present",
            requireDocker: true,
            tier1Command: { command: process.execPath, args: ["--version"] },
          }),
        (err: unknown) =>
          err instanceof DockerVerifierUnavailableError &&
          err.code === "ERR_DOCKER_VERIFIER_UNAVAILABLE"
      );

      // 2. Honest telemetry in subprocess/sandbox mode (never claims isDockerIsolated=true!)
      const hostRes = await fx.verifier.runSingleAttempt({
        projectId: fx.projectId,
        taskId: task.task_id,
        mergeCandidateId: built.mergeCandidate.merge_candidate_id,
        mergeCandidateHash: built.mergeCandidate.merge_candidate_hash,
        verifiedTreeHash: built.mergeCandidate.verified_tree_hash,
        baseMainCommitHash: built.mergeCandidate.base_main_commit_hash,
        taskContract: fx.contract,
        snapshotPath: built.mergeCandidate.snapshot_path!,
        snapshotSha256: built.mergeCandidate.snapshot_sha256!,
        trustedAcceptanceDir: fx.trustedAcceptanceDir,
        repoPath: fx.bareRepoDir,
        executionMode: process.platform === "linux" ? "sandbox" : "subprocess",
        tier1Command: {
          command: process.execPath,
          args: ["--test", join(fx.trustedAcceptanceDir, "pricing.acceptance.spec.mjs")],
        },
      });
      assert.equal(hostRes.verdict, "PASS");
      assert.equal(hostRes.isDockerIsolated, false);
      assert.equal(
        hostRes.executionBackend,
        process.platform === "linux" ? "linux-supervisor" : "host-subprocess"
      );

      // 3. Real Hardened Docker Container test if Docker daemon + node:22-alpine (or cached image) is available
      const nodeDockerProbe = probeDockerVerifierSupport("node:22-alpine");
      if (nodeDockerProbe.daemonAvailable && nodeDockerProbe.imageAvailable) {
        const dockerRes = await fx.verifier.runSingleAttempt({
          projectId: fx.projectId,
          taskId: task.task_id,
          mergeCandidateId: built.mergeCandidate.merge_candidate_id,
          mergeCandidateHash: built.mergeCandidate.merge_candidate_hash,
          verifiedTreeHash: built.mergeCandidate.verified_tree_hash,
          baseMainCommitHash: built.mergeCandidate.base_main_commit_hash,
          taskContract: fx.contract,
          snapshotPath: built.mergeCandidate.snapshot_path!,
          snapshotSha256: built.mergeCandidate.snapshot_sha256!,
          trustedAcceptanceDir: fx.trustedAcceptanceDir,
          repoPath: fx.bareRepoDir,
          dockerImage: "node:22-alpine",
          executionMode: "docker",
          requireDocker: true,
          tier1Command: {
            command: "node",
            args: ["--test", "/trusted-policy/acceptance-tests/pricing.acceptance.spec.mjs"],
          },
          tier2Command: {
            command: "node",
            args: ["--test", "tests/baseline/pricing.baseline.spec.mjs"],
          },
          tier3Command: {
            command: "node",
            args: [
              "-e",
              [
                "const fs = require('node:fs');",
                "const assert = require('node:assert/strict');",
                // Confirm /workspace/baseline and /trusted-policy/acceptance-tests are read-only
                "assert.throws(() => fs.writeFileSync('/workspace/baseline/pwn.txt', 'x'));",
                "assert.throws(() => fs.writeFileSync('/trusted-policy/acceptance-tests/pwn.txt', 'x'));",
              ].join(" "),
            ],
          },
        });
        assert.equal(dockerRes.verdict, "PASS");
        assert.equal(dockerRes.executionBackend, "docker");
        assert.equal(dockerRes.isDockerIsolated, true);
        assert.equal(dockerRes.hermeticNetworkDisabled, true);
      }
    } finally {
      rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });

  it("M3-Gate-8: Full M3 -> 3D Review -> 8-Field Approval -> CAS Merge promotes snapshot to MERGED_PERMANENT surviving +30 day GC", async () => {
    const fx = setupRealGitRepoFixture(new Date("2026-11-01T00:00:00.000Z"));
    try {
      const task = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "Full M3 CAS promotion E2E",
        task_contract: fx.contract,
        base_main_commit_hash: fx.baseMainSha,
      });
      const lease = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        worker_id: "worker-e2e-m3",
      });

      writeFileSync(
        join(fx.agentWorkDir, "src", "pricing.mjs"),
        [
          "export function calculateDiscount(amount, opts = {}) {",
          "  if (amount <= 0) throw new Error('amount must be positive');",
          "  return opts.vip ? Math.round(amount * 0.75) : Math.round(amount * 0.8);",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );
      fx.gitAt(fx.agentWorkDir, ["add", "src/pricing.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "feat: complete vip discount"]);
      const agentCommitSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);
      const stagingRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${agentCommitSha}:${stagingRef}`]);

      const verified = await fx.coreApi.buildAndVerifyMergeCandidateFromGit(
        fx.projectId,
        fx.authOp1,
        {
          task_id: task.task_id,
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          staging_ref: stagingRef,
          agent_commit_hash: agentCommitSha,
          repo_path: fx.bareRepoDir,
          verifier: fx.verifier,
          trusted_acceptance_dir: fx.trustedAcceptanceDir,
          execution_mode: "subprocess",
          tier1_command: {
            command: process.execPath,
            args: ["--test", join(fx.trustedAcceptanceDir, "pricing.acceptance.spec.mjs")],
          },
          tier2_command: {
            command: process.execPath,
            args: ["--test", "tests/baseline/pricing.baseline.spec.mjs"],
          },
        }
      );
      assert.equal(verified.ok, true);
      if (!verified.ok) return;
      assert.equal(verified.taskStatus, "UnderIndependentReview");
      assert.equal(verified.mergeCandidate.snapshot_retention_class, "EPHEMERAL_14D");

      const reviewArtifact = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "op-1",
          currentRole: "core_api_service",
        },
        () =>
          fx.store.recordReviewArtifact({
            project_id: fx.projectId,
            task_id: task.task_id,
            merge_candidate_id: verified.mergeCandidate.merge_candidate_id,
            verification_run_id: verified.finalRun.verification_run_id,
            merge_candidate_hash: verified.mergeCandidate.merge_candidate_hash,
            verified_tree_hash: verified.mergeCandidate.verified_tree_hash,
            writer_provider: "anthropic",
            writer_model: "claude-3-7-sonnet",
            reviewer_provider: "google",
            reviewer_model: "gemini-2.5-pro",
            developer_principal_id: "dev-agent-1",
            reviewer_principal_id: "rev-agent-1",
            developer_session_id: "sess-dev-1",
            reviewer_session_id: "sess-rev-1",
            verdict: "PASS",
          })
      );

      const approval = await fx.webConsole.approveCandidateWith8FieldBinding({
        auth: fx.authApprover1,
        candidate: verified.mergeCandidate,
        verificationRun: verified.finalRun,
        reviewArtifact,
      });

      const mergeRes = await fx.coreApi.executeCasMerge(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        merge_candidate_id: verified.mergeCandidate.merge_candidate_id,
        approval_id: approval.approval_id,
      });
      assert.equal(mergeRes.status, "MERGED_BY_CAS");

      const persistedCandidate = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "op-1",
          currentRole: "core_api_service",
        },
        () => fx.store.getMergeCandidateById(verified.mergeCandidate.merge_candidate_id)
      );
      assert.equal(persistedCandidate?.snapshot_retention_class, "MERGED_PERMANENT");

      const manifestAfterMerge = fx.snapshotStore.getManifest(
        verified.mergeCandidate.snapshot_path!
      );
      assert.equal(manifestAfterMerge?.retentionClass, "MERGED_PERMANENT");
      assert.equal(manifestAfterMerge?.expiresAt, null);

      // +30 day GC preserves MERGED_PERMANENT snapshot
      const gcDay30 = fx.snapshotStore.pruneExpiredSnapshots(
        new Date("2026-12-01T00:00:00.000Z")
      );
      assert.equal(gcDay30.deletedPaths.length, 0);
      assert.deepEqual(gcDay30.retainedPermanentPaths, [
        verified.mergeCandidate.snapshot_path!,
      ]);
      assert.equal(existsSync(verified.mergeCandidate.snapshot_path!), true);
    } finally {
      rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });

  it("M3-Gate-9 (Review Medium fixes): Symlink in candidate yields persisted FAIL verdict without crash, and PASS consistency rejects tier3_agent_tests_passed=false", async () => {
    const fx = setupRealGitRepoFixture();
    try {
      // 1. Medium #1: Repo main contains a symlink (`link -> /etc/hostname`) alongside valid agent edit
      symlinkSync("/etc/hostname", join(fx.mainWorkDir, "link"));
      fx.gitAt(fx.mainWorkDir, ["add", "link"]);
      fx.gitAt(fx.mainWorkDir, ["commit", "-m", "chore: add symlink to main"]);
      fx.gitAt(fx.mainWorkDir, ["push", "origin", "main"]);
      const mainWithSymlinkSha = fx.gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]);
      fx.store.forceSetMainRefCommitHashForTest(fx.projectId, mainWithSymlinkSha);

      fx.gitAt(fx.agentWorkDir, ["pull", "origin", "main"]);
      writeFileSync(
        join(fx.agentWorkDir, "src", "pricing.mjs"),
        [
          "export function calculateDiscount(amount, opts = {}) {",
          "  if (amount <= 0) throw new Error('amount must be positive');",
          "  return opts.vip ? Math.round(amount * 0.75) : Math.round(amount * 0.8);",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );
      fx.gitAt(fx.agentWorkDir, ["add", "src/pricing.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "feat: valid vip discount with repo symlink"]);
      const agentSymlinkSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);

      const task1 = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "Candidate symlink graceful FAIL verdict",
        task_contract: fx.contract,
        base_main_commit_hash: mainWithSymlinkSha,
      });
      const lease1 = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp1, {
        task_id: task1.task_id,
        worker_id: "worker-symlink-cand",
      });
      const stagingRef1 = `refs/factory/Verify/${task1.task_id}/${lease1.lease_epoch}`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${agentSymlinkSha}:${stagingRef1}`]);

      // Must NOT throw HardlinkCacheViolationError; must record structured FAIL & move task to ReworkRequired
      const candSymlinkRes = await fx.coreApi.buildAndVerifyMergeCandidateFromGit(
        fx.projectId,
        fx.authOp1,
        {
          task_id: task1.task_id,
          lease_id: lease1.lease_id,
          lease_epoch: lease1.lease_epoch,
          staging_ref: stagingRef1,
          agent_commit_hash: agentSymlinkSha,
          repo_path: fx.bareRepoDir,
          verifier: fx.verifier,
          trusted_acceptance_dir: fx.trustedAcceptanceDir,
          execution_mode: "subprocess",
          tier1_command: {
            command: process.execPath,
            args: ["--test", join(fx.trustedAcceptanceDir, "pricing.acceptance.spec.mjs")],
          },
        }
      );
      assert.equal(candSymlinkRes.ok, true);
      if (!candSymlinkRes.ok) return;
      assert.equal(candSymlinkRes.allRuns.length, 1);
      assert.equal(candSymlinkRes.finalRun.verdict, "FAIL");
      assert.equal(candSymlinkRes.finalRun.overall_status, "FAILED_ACCEPTANCE");
      assert.equal(candSymlinkRes.taskStatus, "ReworkRequired");
      assert.match(
        candSymlinkRes.retryResult.finalResult.errorMessage ?? "",
        /ERR_CANDIDATE_SYMLINK_PROHIBITED.*\blink\b/
      );

      // Symlink inside trustedAcceptanceDir also yields structured FAIL verdict without uncaught crash
      const symlinkPolicyDir = join(fx.rootDir, "policy-with-symlink");
      mkdirSync(symlinkPolicyDir, { recursive: true });
      writeFileSync(join(symlinkPolicyDir, "ok.txt"), "ok\n", "utf8");
      symlinkSync("/etc/hostname", join(symlinkPolicyDir, "policy-link"));
      const policySymlinkAttempt = await fx.verifier.runSingleAttempt({
        projectId: fx.projectId,
        taskId: task1.task_id,
        mergeCandidateId: candSymlinkRes.mergeCandidate.merge_candidate_id,
        mergeCandidateHash: candSymlinkRes.mergeCandidate.merge_candidate_hash,
        verifiedTreeHash: candSymlinkRes.mergeCandidate.verified_tree_hash,
        baseMainCommitHash: candSymlinkRes.mergeCandidate.base_main_commit_hash,
        taskContract: fx.contract,
        snapshotPath: candSymlinkRes.mergeCandidate.snapshot_path!,
        snapshotSha256: candSymlinkRes.mergeCandidate.snapshot_sha256!,
        trustedAcceptanceDir: symlinkPolicyDir,
        repoPath: fx.bareRepoDir,
        executionMode: "subprocess",
        tier1Command: { command: process.execPath, args: ["--version"] },
      });
      assert.equal(policySymlinkAttempt.verdict, "FAIL");
      assert.equal(policySymlinkAttempt.overallStatus, "FAILED_ACCEPTANCE");
      assert.equal(policySymlinkAttempt.trustedPolicyMatched, false);

      // 2. Medium #2: chk_vr_pass_consistency rejects PASS when tier3_agent_tests_passed is false
      await assert.rejects(
        () =>
          fx.store.withRlsTransaction(
            {
              currentProjectId: fx.projectId,
              currentPrincipalId: "op-1",
              currentRole: "core_api_service",
            },
            () =>
              fx.store.recordVerificationRun({
                project_id: fx.projectId,
                task_id: task1.task_id,
                merge_candidate_id: candSymlinkRes.mergeCandidate.merge_candidate_id,
                merge_candidate_hash: candSymlinkRes.mergeCandidate.merge_candidate_hash,
                verified_tree_hash: candSymlinkRes.mergeCandidate.verified_tree_hash,
                verifier_image_digest: "sha256:forge-tier3",
                verdict: "PASS",
                overall_status: "PASSED",
                tier1_trusted_acceptance_passed: true,
                tier2_protected_baseline_passed: true,
                tier3_agent_tests_passed: false,
                exit_code: 0,
                duration_ms: 15,
                report_sha256: sha256Hex("forged-tier3-pass"),
              })
          ),
        (err: unknown) =>
          err instanceof PostgresRlsError &&
          err.sqlState === "23514" &&
          /chk_vr_pass_consistency/.test(err.message)
      );
    } finally {
      rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });

  it("M3-Gate-10 (Review Minor fixes #1..#8): Snapshot tamper classification, supervisor stdio tails, null skipped tiers, GC isolation, DB failure compensation, detached CAS promotion, symlink target hashing, and NODE_OPTIONS blocking", async () => {
    const fx = setupRealGitRepoFixture(new Date("2026-11-01T00:00:00.000Z"));
    try {
      const task = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "Minor review fixes regression",
        task_contract: fx.contract,
        base_main_commit_hash: fx.baseMainSha,
      });
      const lease = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        worker_id: "worker-minors",
      });

      writeFileSync(
        join(fx.agentWorkDir, "src", "pricing.mjs"),
        [
          "export function calculateDiscount(amount, opts = {}) {",
          "  if (amount <= 0) throw new Error('amount must be positive');",
          "  return opts.vip ? Math.round(amount * 0.75) : Math.round(amount * 0.8);",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );
      fx.gitAt(fx.agentWorkDir, ["add", "src/pricing.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "feat: valid vip implementation"]);
      const agentCommitSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);
      const stagingRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${agentCommitSha}:${stagingRef}`]);

      // Minor #3 + #8 + null preservation: Tier 1 only (tier2 & tier3 omitted) + extra_env NODE_OPTIONS stripped
      const verified = await fx.coreApi.buildAndVerifyMergeCandidateFromGit(
        fx.projectId,
        fx.authOp1,
        {
          task_id: task.task_id,
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          staging_ref: stagingRef,
          agent_commit_hash: agentCommitSha,
          repo_path: fx.bareRepoDir,
          verifier: fx.verifier,
          trusted_acceptance_dir: fx.trustedAcceptanceDir,
          execution_mode: "subprocess",
          extra_env: {
            NODE_OPTIONS: "--require=/tmp/nonexistent-injector.js",
            LD_PRELOAD: "/tmp/nonexistent.so",
            SAFE_VERIFIER_VAR: "ok",
          },
          tier1_command: {
            command: process.execPath,
            args: [
              "-e",
              [
                "const assert = require('node:assert/strict');",
                "assert.equal(process.env.NODE_OPTIONS, undefined);",
                "assert.equal(process.env.LD_PRELOAD, undefined);",
                "assert.equal(process.env.SAFE_VERIFIER_VAR, 'ok');",
              ].join(" "),
            ],
          },
        }
      );
      assert.equal(verified.ok, true);
      if (!verified.ok) return;
      assert.equal(verified.finalRun.verdict, "PASS");
      assert.equal(verified.finalRun.tier1_trusted_acceptance_passed, true);
      assert.equal(verified.finalRun.tier2_protected_baseline_passed, null);
      assert.equal(verified.finalRun.tier3_agent_tests_passed, null);
      assert.equal(verified.retryResult.finalResult.tier2ProtectedBaselinePassed, null);
      assert.equal(verified.retryResult.finalResult.tier3AgentTestsPassed, null);

      const directSanitized = sanitizeVerifierEnv(process.env, {
        NODE_OPTIONS: "--inspect",
        BASH_ENV: "/tmp/evil.sh",
        PERL5OPT: "-Mfoo",
        RUBYOPT: "-rfoo",
        SAFE_CUSTOM_FLAG: "yes",
      });
      assert.equal(directSanitized.NODE_OPTIONS, undefined);
      assert.equal(directSanitized.BASH_ENV, undefined);
      assert.equal(directSanitized.PERL5OPT, undefined);
      assert.equal(directSanitized.RUBYOPT, undefined);
      assert.equal(directSanitized.SAFE_CUSTOM_FLAG, "yes");

      // Minor #1: Snapshot WORM mode / SHA-256 tamper fails immediately with TEST_TAMPERING_DETECTED (1 attempt, not INFRA_ERROR x3)
      const snapPath = verified.mergeCandidate.snapshot_path!;
      chmodSync(snapPath, 0o644);
      const modeTamperRes = await fx.verifier.verifyCandidateWithRetries({
        projectId: fx.projectId,
        taskId: task.task_id,
        mergeCandidateId: verified.mergeCandidate.merge_candidate_id,
        mergeCandidateHash: verified.mergeCandidate.merge_candidate_hash,
        verifiedTreeHash: verified.mergeCandidate.verified_tree_hash,
        baseMainCommitHash: verified.mergeCandidate.base_main_commit_hash,
        taskContract: fx.contract,
        snapshotPath: snapPath,
        snapshotSha256: verified.mergeCandidate.snapshot_sha256!,
        trustedAcceptanceDir: fx.trustedAcceptanceDir,
        repoPath: fx.bareRepoDir,
        executionMode: "subprocess",
        maxInfraRetries: 2,
        tier1Command: { command: process.execPath, args: ["--version"] },
      });
      chmodSync(snapPath, 0o444);
      assert.equal(modeTamperRes.attempts.length, 1);
      assert.equal(modeTamperRes.finalResult.overallStatus, "TEST_TAMPERING_DETECTED");
      assert.equal(modeTamperRes.finalResult.verdict, "FAIL");
      assert.equal(modeTamperRes.finalResult.exitCode, 1);

      const shaTamperRes = await fx.verifier.verifyCandidateWithRetries({
        projectId: fx.projectId,
        taskId: task.task_id,
        mergeCandidateId: verified.mergeCandidate.merge_candidate_id,
        mergeCandidateHash: verified.mergeCandidate.merge_candidate_hash,
        verifiedTreeHash: verified.mergeCandidate.verified_tree_hash,
        baseMainCommitHash: verified.mergeCandidate.base_main_commit_hash,
        taskContract: fx.contract,
        snapshotPath: snapPath,
        snapshotSha256: "f".repeat(64),
        trustedAcceptanceDir: fx.trustedAcceptanceDir,
        repoPath: fx.bareRepoDir,
        executionMode: "subprocess",
        maxInfraRetries: 2,
        tier1Command: { command: process.execPath, args: ["--version"] },
      });
      assert.equal(shaTamperRes.attempts.length, 1);
      assert.equal(shaTamperRes.finalResult.overallStatus, "TEST_TAMPERING_DETECTED");

      // Minor #2: WNA sandbox / linux-supervisor preserves stdoutTail and stderrTail
      const sandboxBackend = new LinuxCgroupV2SandboxBackend();
      const tailTaskId = "minor-2-tail-check";
      const tailWorkDir = join(fx.rootDir, "tail-work");
      mkdirSync(tailWorkDir, { recursive: true });
      try {
        const spawned = sandboxBackend.spawnRealProcessInSandbox({
          taskId: tailTaskId,
          leaseEpoch: 1,
          command: process.execPath,
          args: [
            "-e",
            "console.log('SF_STDOUT_SENTINEL'); console.error('SF_STDERR_SENTINEL');",
          ],
          cwd: tailWorkDir,
          worktreePath: tailWorkDir,
          sanitizedEnv: sanitizeVerifierEnv(process.env),
          isolateNamespaces: false,
          dropPrivileges: false,
        });
        const exitOutcome = await spawned.exitPromise;
        assert.equal(exitOutcome.code, 0);
        assert.match(exitOutcome.stdoutTail ?? "", /SF_STDOUT_SENTINEL/);
        assert.match(exitOutcome.stderrTail ?? "", /SF_STDERR_SENTINEL/);
      } finally {
        await sandboxBackend.killAndVerifyClean(tailTaskId, 1);
      }

      const verifierSandboxTail = await fx.verifier.runSingleAttempt({
        projectId: fx.projectId,
        taskId: task.task_id,
        mergeCandidateId: verified.mergeCandidate.merge_candidate_id,
        mergeCandidateHash: verified.mergeCandidate.merge_candidate_hash,
        verifiedTreeHash: verified.mergeCandidate.verified_tree_hash,
        baseMainCommitHash: verified.mergeCandidate.base_main_commit_hash,
        taskContract: fx.contract,
        snapshotPath: snapPath,
        snapshotSha256: verified.mergeCandidate.snapshot_sha256!,
        trustedAcceptanceDir: fx.trustedAcceptanceDir,
        repoPath: fx.bareRepoDir,
        executionMode: process.platform === "linux" ? "sandbox" : "subprocess",
        tier1Command: {
          command: process.execPath,
          args: [
            "-e",
            "console.log('VERIFIER_OUT_TAIL'); console.error('VERIFIER_ERR_TAIL');",
          ],
        },
      });
      assert.match(verifierSandboxTail.tierOutcomes[0]?.stdoutTail ?? "", /VERIFIER_OUT_TAIL/);
      assert.match(verifierSandboxTail.tierOutcomes[0]?.stderrTail ?? "", /VERIFIER_ERR_TAIL/);

      // Minor #4: Corrupted .meta.json does not halt pruneExpiredSnapshots GC for remaining snapshots
      const isolatedStoreDir = join(fx.rootDir, "gc-isolated-store");
      const isolatedStore = new ImmutableSourceSnapshotStore({ storageDir: isolatedStoreDir });
      mkdirSync(join(isolatedStoreDir, "corrupt-candidate"), { recursive: true });
      writeFileSync(
        join(isolatedStoreDir, "corrupt-candidate", "snapshot-corrupt.tar.meta.json"),
        "{not-valid-json",
        "utf8"
      );
      const validExpiredBuilt = buildRealGitMergeCandidate({
        repoPath: fx.bareRepoDir,
        taskId: "gc-valid-expired",
        agentCommitHash: agentCommitSha,
        snapshotStore: isolatedStore,
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
      });
      assert.equal(validExpiredBuilt.ok, true);
      if (!validExpiredBuilt.ok) return;
      const gcRes = isolatedStore.pruneExpiredSnapshots(new Date("2026-11-20T00:00:00.000Z"));
      assert.deepEqual(gcRes.deletedPaths, [validExpiredBuilt.snapshotPath!]);
      assert.equal(existsSync(validExpiredBuilt.snapshotPath!), false);

      // Minor #6: executeCasMerge succeeds even if local snapshot .meta.json manifest is missing
      const reviewArtifact = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "op-1",
          currentRole: "core_api_service",
        },
        () =>
          fx.store.recordReviewArtifact({
            project_id: fx.projectId,
            task_id: task.task_id,
            merge_candidate_id: verified.mergeCandidate.merge_candidate_id,
            verification_run_id: verified.finalRun.verification_run_id,
            merge_candidate_hash: verified.mergeCandidate.merge_candidate_hash,
            verified_tree_hash: verified.mergeCandidate.verified_tree_hash,
            writer_provider: "anthropic",
            writer_model: "claude-3-7-sonnet",
            reviewer_provider: "google",
            reviewer_model: "gemini-2.5-pro",
            developer_principal_id: "dev-agent-minor6",
            reviewer_principal_id: "rev-agent-minor6",
            developer_session_id: "sess-dev-minor6",
            reviewer_session_id: "sess-rev-minor6",
            verdict: "PASS",
          })
      );
      const approval = await fx.webConsole.approveCandidateWith8FieldBinding({
        auth: fx.authApprover1,
        candidate: verified.mergeCandidate,
        verificationRun: verified.finalRun,
        reviewArtifact,
      });
      unlinkSync(`${snapPath}.meta.json`);
      const casRes = await fx.coreApi.executeCasMerge(fx.projectId, fx.authOp1, {
        task_id: task.task_id,
        merge_candidate_id: verified.mergeCandidate.merge_candidate_id,
        approval_id: approval.approval_id,
      });
      assert.equal(casRes.status, "MERGED_BY_CAS");
      assert.equal(casRes.task_status, "MergedAndCompleted");

      // Minor #5: buildMergeCandidateFromGit rolls back candidate ref + snapshot when createMergeCandidate fails
      const latestMainSha = fx.gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]);
      fx.store.forceSetMainRefCommitHashForTest(fx.projectId, latestMainSha);
      fx.gitAt(fx.agentWorkDir, ["fetch", "origin", "main"]);
      fx.gitAt(fx.agentWorkDir, ["reset", "--hard", latestMainSha]);
      writeFileSync(join(fx.agentWorkDir, "src", "minor5.mjs"), "export const m5 = 1;\n", "utf8");
      fx.gitAt(fx.agentWorkDir, ["add", "src/minor5.mjs"]);
      fx.gitAt(fx.agentWorkDir, ["commit", "-m", "feat: minor 5 agent commit"]);
      const m5AgentSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);

      const taskComp = await fx.coreApi.createTask(fx.projectId, fx.authOp1, {
        title: "Minor 5 orphan ref/snapshot compensation",
        task_contract: fx.contract,
        base_main_commit_hash: latestMainSha,
      });
      const leaseComp = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp1, {
        task_id: taskComp.task_id,
        worker_id: "worker-m5-comp",
      });
      const stagingRefComp = `refs/factory/Verify/${taskComp.task_id}/${leaseComp.lease_epoch}`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${m5AgentSha}:${stagingRefComp}`]);

      // Advance bare Git main WITHOUT updating DB main pointer -> createMergeCandidate throws 23514 after Git build
      fx.gitAt(fx.mainWorkDir, ["pull", "origin", "main"]);
      writeFileSync(join(fx.mainWorkDir, "README.md"), "# Advanced main without DB sync\n", "utf8");
      fx.gitAt(fx.mainWorkDir, ["add", "README.md"]);
      fx.gitAt(fx.mainWorkDir, ["commit", "-m", "docs: advance bare main"]);
      fx.gitAt(fx.mainWorkDir, ["push", "origin", "main"]);

      const compSnapDir = join(fx.rootDir, "comp-snap-store");
      const compSnapStore = new ImmutableSourceSnapshotStore({ storageDir: compSnapDir });
      await assert.rejects(
        () =>
          fx.coreApi.buildMergeCandidateFromGit(fx.projectId, fx.authOp1, {
            task_id: taskComp.task_id,
            lease_id: leaseComp.lease_id,
            lease_epoch: leaseComp.lease_epoch,
            staging_ref: stagingRefComp,
            agent_commit_hash: m5AgentSha,
            repo_path: fx.bareRepoDir,
            snapshot_store: compSnapStore,
          }),
        (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
      );
      const allRefsAfterFailure = fx.gitAt(fx.bareRepoDir, ["show-ref"]);
      assert.equal(
        allRefsAfterFailure.includes(`refs/factory/candidates/${taskComp.task_id}`),
        false
      );
      const gcComp = compSnapStore.pruneExpiredSnapshots(new Date("2026-12-31T00:00:00.000Z"));
      assert.equal(gcComp.deletedPaths.length, 0);
      assert.equal(gcComp.retainedActivePaths.length, 0);
      assert.equal(gcComp.retainedPermanentPaths.length, 0);

      // Minor #7: computeDirectorySha256 changes when symlink target changes
      const symHashDir = join(fx.rootDir, "sym-hash-dir");
      mkdirSync(symHashDir, { recursive: true });
      symlinkSync("target-v1.txt", join(symHashDir, "policy-link"));
      const shaTarget1 = computeDirectorySha256(symHashDir);
      unlinkSync(join(symHashDir, "policy-link"));
      symlinkSync("target-v2.txt", join(symHashDir, "policy-link"));
      const shaTarget2 = computeDirectorySha256(symHashDir);
      assert.notEqual(shaTarget1, shaTarget2);
    } finally {
      rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });
});
