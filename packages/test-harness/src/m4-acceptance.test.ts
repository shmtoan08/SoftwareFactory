import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AgentGatewayService,
  EphemeralGitPushTokenService,
  EphemeralReviewerCredentialService,
  ReviewerIdentityIndependenceError,
} from "@software-factory/agent-gateway";
import { CoreApiService, type CoreApiWarning } from "@software-factory/core-api";
import {
  ApprovalExpiredOrStaleError,
  SimulatedPostMergeCrashError,
  SoftwareFactoryControlPlaneStore,
} from "@software-factory/database";
import {
  IndependentReviewerService,
  ReviewerContextLeakError,
} from "@software-factory/reviewer";
import type { TaskContractSpec } from "@software-factory/task-contract";
import {
  Docker3TierVerifier,
  ImmutableSourceSnapshotStore,
} from "@software-factory/verifier";
import { WebApprovalConsoleController } from "@software-factory/web";
import { LinuxCgroupV2SandboxBackend } from "@software-factory/wna";

interface M4RealFixture {
  readonly rootDir: string;
  readonly bareRepoDir: string;
  readonly mainWorkDir: string;
  readonly agentWorkDir: string;
  readonly snapshotDir: string;
  readonly trustedAcceptanceDir: string;
  readonly store: SoftwareFactoryControlPlaneStore;
  readonly gateway: AgentGatewayService;
  readonly coreApi: CoreApiService;
  readonly warnings: CoreApiWarning[];
  readonly webConsole: WebApprovalConsoleController;
  readonly snapshotStore: ImmutableSourceSnapshotStore;
  readonly verifier: Docker3TierVerifier;
  readonly reviewerService: IndependentReviewerService;
  readonly sandboxBackend: LinuxCgroupV2SandboxBackend;
  readonly projectId: string;
  readonly authOp: ReturnType<CoreApiService["issueAuthContext"]>;
  readonly authApprover: ReturnType<CoreApiService["issueAuthContext"]>;
  readonly initialMainSha: string;
  readonly contract: TaskContractSpec;
  gitAt(dir: string, args: string[]): string;
  advanceClockMs(ms: number): void;
  cleanup(): void;
}

function createM4RealFixture(options?: {
  approvalTtlSeconds?: number;
  withInitialClockMs?: number;
}): M4RealFixture {
  const rootDir = mkdtempSync(join(tmpdir(), "sf-m4-e2e-"));
  const bareRepoDir = join(rootDir, "remote.git");
  const mainWorkDir = join(rootDir, "main-work");
  const agentWorkDir = join(rootDir, "agent-work");
  const snapshotDir = join(rootDir, "snapshots");
  const trustedAcceptanceDir = join(rootDir, "trusted-acceptance");

  mkdirSync(bareRepoDir, { recursive: true });
  mkdirSync(mainWorkDir, { recursive: true });
  mkdirSync(agentWorkDir, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });
  mkdirSync(trustedAcceptanceDir, { recursive: true });

  const gitAt = (dir: string, args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Factory M4 Test",
        GIT_AUTHOR_EMAIL: "m4-test@software-factory.local",
        GIT_COMMITTER_NAME: "Factory M4 Test",
        GIT_COMMITTER_EMAIL: "m4-test@software-factory.local",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();

  gitAt(bareRepoDir, ["init", "--bare", "--initial-branch=main"]);
  gitAt(rootDir, ["clone", bareRepoDir, mainWorkDir]);
  gitAt(mainWorkDir, ["checkout", "-B", "main"]);
  gitAt(mainWorkDir, ["config", "user.name", "Factory Main Maintainer"]);
  gitAt(mainWorkDir, ["config", "user.email", "maintainer@software-factory.local"]);

  mkdirSync(join(mainWorkDir, "src"), { recursive: true });
  mkdirSync(join(mainWorkDir, "baseline"), { recursive: true });
  mkdirSync(join(mainWorkDir, "test"), { recursive: true });

  writeFileSync(
    join(mainWorkDir, "package.json"),
    JSON.stringify({ name: "m4-sample-app", version: "1.0.0", type: "module" }, null, 2) + "\n",
    "utf8"
  );
  writeFileSync(
    join(mainWorkDir, "src", "calculator.mjs"),
    [
      "export function add(a, b) {",
      "  return a + b;",
      "}",
      "",
      "export function multiply(a, b) {",
      "  return a * b;",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(mainWorkDir, "baseline", "baseline.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { add } from "../src/calculator.mjs";',
      "assert.equal(add(2, 3), 5);",
      'console.log("baseline-ok");',
      "",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(join(mainWorkDir, "README.md"), "# M4 Sample App\n", "utf8");

  gitAt(mainWorkDir, ["add", "."]);
  gitAt(mainWorkDir, ["commit", "-m", "chore: initial baseline B_base"]);
  gitAt(mainWorkDir, ["push", "-u", "origin", "main"]);
  const initialMainSha = gitAt(bareRepoDir, ["rev-parse", "refs/heads/main"]);
  const initialMainTreeSha = gitAt(bareRepoDir, ["rev-parse", `${initialMainSha}^{tree}`]);

  gitAt(rootDir, ["clone", bareRepoDir, agentWorkDir]);
  gitAt(agentWorkDir, ["config", "user.name", "WNA Agent Runner"]);
  gitAt(agentWorkDir, ["config", "user.email", "agent@software-factory.local"]);

  writeFileSync(
    join(trustedAcceptanceDir, "acceptance.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { join } from "node:path";',
      'const mod = await import(join(process.cwd(), "src", "calculator.mjs"));',
      'assert.equal(typeof mod.subtract, "function");',
      "assert.equal(mod.subtract(10, 4), 6);",
      'console.log("tier1-trusted-acceptance-pass");',
      "",
    ].join("\n"),
    "utf8"
  );

  let nowMs = options?.withInitialClockMs ?? Date.parse("2026-11-10T10:00:00.000Z");
  const clockFn = () => new Date(nowMs);
  const advanceClockMs = (ms: number): void => {
    nowMs += ms;
  };

  const store = new SoftwareFactoryControlPlaneStore(clockFn);
  let projectId = "";
  store.withRlsTransaction(
    {
      currentRole: "system_admin_role",
      currentPrincipalId: "bootstrap-admin",
    },
    () => {
      const project = store.createProject({
        slug: "m4-e2e-project",
        name: "Milestone M4 Project",
        repo_bare_path: bareRepoDir,
        initial_main_commit_hash: initialMainSha,
        initial_main_tree_hash: initialMainTreeSha,
        approval_ttl_seconds: options?.approvalTtlSeconds ?? 120,
      });
      projectId = project.project_id;
      store.addProjectMembership({
        project_id: projectId,
        principal_id: "operator-alice",
        member_role: "DEVELOPER",
      });
      store.addProjectMembership({
        project_id: projectId,
        principal_id: "approver-bob",
        member_role: "PROJECT_APPROVER",
      });
    }
  );

  const warnings: CoreApiWarning[] = [];
  const snapshotStore = new ImmutableSourceSnapshotStore({ storageDir: snapshotDir });
  const sandboxBackend = new LinuxCgroupV2SandboxBackend();
  const coreApi = new CoreApiService(store, {
    clockFn,
    snapshotStore,
    onWarning: (w) => {
      warnings.push(w);
    },
  });
  const gateway = new AgentGatewayService({
    store,
    projectId,
    reviewerCredentialService: new EphemeralReviewerCredentialService({ clockFn }),
  });
  const verifier = new Docker3TierVerifier({
    snapshotStore,
  });
  const reviewerService = new IndependentReviewerService({
    snapshotStore,
    sandboxBackend,
  });
  const webConsole = new WebApprovalConsoleController(coreApi);

  const authOp = coreApi.issueAuthContext({
    projectId,
    principalId: "operator-alice",
    roles: ["DEVELOPER"],
  });
  const authApprover = coreApi.issueAuthContext({
    projectId,
    principalId: "approver-bob",
    roles: ["PROJECT_APPROVER"],
  });

  const contract: TaskContractSpec = {
    allowed_files: ["src/**", "test/**"],
    protected_paths: ["baseline/**"],
    forbidden_paths: [".github/workflows/**", ".env*"],
  };

  const cleanup = (): void => {
    const restoreWritable = (dirPath: string): void => {
      if (!existsSync(dirPath)) return;
      try {
        chmodSync(dirPath, 0o700);
      } catch {
        // best-effort
      }
    };
    restoreWritable(snapshotDir);
    try {
      rmSync(rootDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failure
    }
  };

  return {
    rootDir,
    bareRepoDir,
    mainWorkDir,
    agentWorkDir,
    snapshotDir,
    trustedAcceptanceDir,
    store,
    gateway,
    coreApi,
    warnings,
    webConsole,
    snapshotStore,
    verifier,
    reviewerService,
    sandboxBackend,
    projectId,
    authOp,
    authApprover,
    initialMainSha,
    contract,
    gitAt,
    advanceClockMs,
    cleanup,
  };
}

async function prepareVerifiedCandidate(
  fx: M4RealFixture,
  opts: {
    title: string;
    task_contract?: TaskContractSpec;
    max_rework_cycles?: number;
    calculatorSource?: string;
    agentTestPath: string;
    agentTestSource: string;
  }
) {
  const baseMainSha = fx.gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]);
  fx.gitAt(fx.agentWorkDir, ["fetch", "origin", "main"]);
  fx.gitAt(fx.agentWorkDir, ["reset", "--hard", baseMainSha]);

  const calcSrc =
    opts.calculatorSource ??
    [
      "export function add(a, b) {",
      "  return a + b;",
      "}",
      "",
      "export function multiply(a, b) {",
      "  return a * b;",
      "}",
      "",
      "export function subtract(a, b) {",
      "  return a - b;",
      "}",
      "",
    ].join("\n");

  writeFileSync(join(fx.agentWorkDir, "src", "calculator.mjs"), calcSrc, "utf8");
  mkdirSync(join(fx.agentWorkDir, "test"), { recursive: true });
  writeFileSync(join(fx.agentWorkDir, opts.agentTestPath), opts.agentTestSource, "utf8");

  fx.gitAt(fx.agentWorkDir, ["add", "src/calculator.mjs", opts.agentTestPath]);
  fx.gitAt(fx.agentWorkDir, ["commit", "-m", `feat: ${opts.title}`]);
  const agentCommitSha = fx.gitAt(fx.agentWorkDir, ["rev-parse", "HEAD"]);

  const task = await fx.coreApi.createTask(fx.projectId, fx.authOp, {
    title: opts.title,
    task_contract: opts.task_contract ?? fx.contract,
    base_main_commit_hash: baseMainSha,
    max_rework_cycles: opts.max_rework_cycles,
  });

  const lease = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp, {
    task_id: task.task_id,
    worker_id: `worker-${task.task_id.slice(0, 8)}`,
  });

  const stagingRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
  fx.gitAt(fx.agentWorkDir, ["push", "origin", `${agentCommitSha}:${stagingRef}`]);

  const res = await fx.coreApi.buildAndVerifyMergeCandidateFromGit(fx.projectId, fx.authOp, {
    task_id: task.task_id,
    lease_id: lease.lease_id,
    lease_epoch: lease.lease_epoch,
    staging_ref: stagingRef,
    agent_commit_hash: agentCommitSha,
    repo_path: fx.bareRepoDir,
    verifier: fx.verifier,
    trusted_acceptance_dir: fx.trustedAcceptanceDir,
    execution_mode: "subprocess",
    network_disabled: true,
    tier1_command: {
      command: process.execPath,
      args: [join(fx.trustedAcceptanceDir, "acceptance.test.mjs")],
    },
    tier2_command: {
      command: process.execPath,
      args: ["baseline/baseline.test.mjs"],
    },
    tier3_command: {
      command: process.execPath,
      args: [opts.agentTestPath],
    },
    tier3_test_files: [opts.agentTestPath],
  });

  if (!res.ok) {
    throw new Error(`Unexpected merge conflict preparing verified candidate: ${res.conflictSummary}`);
  }

  return {
    task,
    lease,
    agentCommitSha,
    stagingRef,
    ...res,
  };
}

describe("Milestone M4 Gate — 3D Independent Reviewer, Approval TTL, Atomic CAS Merge & Crash Recovery", () => {
  it("M4-Gate-1 (Scenario 8 Part 1): Enforces 3D Identity Independence across principal, session, credential, agent_profile, model & ROLE_REVIEWER_READONLY Git write denial", async () => {
    const fx = createM4RealFixture();
    try {
      const prep = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 1 Identity Independence",
        agentTestPath: "test/calc.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          'import { subtract } from "../src/calculator.mjs";',
          "assert.equal(subtract(9, 4), 5);",
          "",
        ].join("\n"),
      });

      const baseIdentity = {
        task_id: prep.task.task_id,
        merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
        verification_run_id: prep.finalRun.verification_run_id,
        developer_principal_id: "dev-agent-alpha",
        reviewer_principal_id: "rev-agent-beta",
        developer_session_id: "dev-sess-001",
        reviewer_session_id: "rev-sess-002",
        developer_credential_id: "dev-cred-001",
        reviewer_credential_id: "rev-cred-002",
        developer_agent_profile_id: "profile-coder-v1",
        reviewer_agent_profile_id: "profile-reviewer-v1",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
      };

      // Reject matching principal
      assert.throws(
        () =>
          fx.gateway.issueReviewerSessionCredential({
            ...baseIdentity,
            reviewer_principal_id: "DEV-AGENT-ALPHA",
          }),
        (err: unknown) =>
          err instanceof ReviewerIdentityIndependenceError && err.dimension === "principal"
      );

      // Reject matching session
      assert.throws(
        () =>
          fx.gateway.issueReviewerSessionCredential({
            ...baseIdentity,
            reviewer_session_id: "dev-sess-001",
          }),
        (err: unknown) =>
          err instanceof ReviewerIdentityIndependenceError && err.dimension === "session"
      );

      // Reject matching credential
      assert.throws(
        () =>
          fx.gateway.issueReviewerSessionCredential({
            ...baseIdentity,
            reviewer_credential_id: "dev-cred-001",
          }),
        (err: unknown) =>
          err instanceof ReviewerIdentityIndependenceError && err.dimension === "credential"
      );

      // Reject matching agent_profile
      assert.throws(
        () =>
          fx.gateway.issueReviewerSessionCredential({
            ...baseIdentity,
            reviewer_agent_profile_id: "PROFILE-CODER-V1",
          }),
        (err: unknown) =>
          err instanceof ReviewerIdentityIndependenceError && err.dimension === "agent_profile"
      );

      // Reject identical (provider, model)
      assert.throws(
        () =>
          fx.gateway.issueReviewerSessionCredential({
            ...baseIdentity,
            reviewer_provider: "Anthropic",
            reviewer_model: "CLAUDE-SONNET-4",
          }),
        (err: unknown) =>
          err instanceof ReviewerIdentityIndependenceError && err.dimension === "model"
      );

      // Reject non-readonly role request
      assert.throws(
        () =>
          fx.gateway.issueReviewerSessionCredential({
            ...baseIdentity,
            requested_role: "ROLE_DEVELOPER_WRITE",
          }),
        (err: unknown) =>
          err instanceof ReviewerIdentityIndependenceError && err.dimension === "role"
      );

      // Issue valid ROLE_REVIEWER_READONLY credential and verify Git write denial
      const issued = fx.gateway.issueReviewerSessionCredential(baseIdentity);
      assert.equal(issued.claims.role, "ROLE_REVIEWER_READONLY");
      assert.equal(issued.claims.gitWriteAccess, false);

      assert.equal(
        fx.gateway.reviewerCredentialService.authorizeReviewerGitOperation(
          issued.token,
          "read",
          fx.projectId
        ).allowed,
        true
      );
      const deniedPush = fx.gateway.reviewerCredentialService.authorizeReviewerGitOperation(
        issued.token,
        "push",
        fx.projectId
      );
      assert.equal(deniedPush.allowed, false);
      assert.equal(deniedPush.error_code, "ERR_REVIEWER_READONLY_GIT_WRITE_FORBIDDEN");

      // Reviewer token MUST also fail verification if presented as a lease git-push Bearer token
      const pushTokenVerifier = new EphemeralGitPushTokenService();
      const pushCheck = pushTokenVerifier.verifyLeasePushToken(
        issued.token,
        prep.stagingRef
      );
      assert.equal(pushCheck.valid, false);

      // Database store layer must also enforce chk_ra_independent_credential and chk_ra_independent_agent_profile
      await assert.rejects(
        () =>
          fx.store.withRlsTransaction(
            {
              currentProjectId: fx.projectId,
              currentPrincipalId: "operator-alice",
              currentRole: "core_api_service",
            },
            () =>
              fx.store.recordReviewArtifact({
                project_id: fx.projectId,
                task_id: prep.task.task_id,
                merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
                verification_run_id: prep.finalRun.verification_run_id,
                merge_candidate_hash: prep.mergeCandidate.merge_candidate_hash,
                verified_tree_hash: prep.mergeCandidate.verified_tree_hash,
                writer_provider: "anthropic",
                writer_model: "claude-sonnet-4",
                reviewer_provider: "google",
                reviewer_model: "gemini-2.5-pro",
                developer_principal_id: "dev-agent-alpha",
                reviewer_principal_id: "rev-agent-beta",
                developer_session_id: "dev-sess-001",
                reviewer_session_id: "rev-sess-002",
                developer_credential_id: "shared-cred",
                reviewer_credential_id: "shared-cred",
                developer_agent_profile_id: "profile-a",
                reviewer_agent_profile_id: "profile-b",
                verdict: "PASS",
              })
          ),
        (err: unknown) =>
          err instanceof Error && err.message.includes("chk_ra_independent_credential")
      );

      await assert.rejects(
        () =>
          fx.store.withRlsTransaction(
            {
              currentProjectId: fx.projectId,
              currentPrincipalId: "operator-alice",
              currentRole: "core_api_service",
            },
            () =>
              fx.store.recordReviewArtifact({
                project_id: fx.projectId,
                task_id: prep.task.task_id,
                merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
                verification_run_id: prep.finalRun.verification_run_id,
                merge_candidate_hash: prep.mergeCandidate.merge_candidate_hash,
                verified_tree_hash: prep.mergeCandidate.verified_tree_hash,
                writer_provider: "anthropic",
                writer_model: "claude-sonnet-4",
                reviewer_provider: "google",
                reviewer_model: "gemini-2.5-pro",
                developer_principal_id: "dev-agent-alpha",
                reviewer_principal_id: "rev-agent-beta",
                developer_session_id: "dev-sess-001",
                reviewer_session_id: "rev-sess-002",
                developer_credential_id: "dev-cred-001",
                reviewer_credential_id: "rev-cred-002",
                developer_agent_profile_id: "same-profile",
                reviewer_agent_profile_id: "SAME-PROFILE",
                verdict: "PASS",
              })
          ),
        (err: unknown) =>
          err instanceof Error && err.message.includes("chk_ra_independent_agent_profile")
      );
    } finally {
      fx.cleanup();
    }
  });

  it("M4-Gate-2 (Scenario 8 Part 2): Enforces Context Firewall (no scratchpad/CoT/push tokens) & Read-Only Snapshot Sandbox + clean reap", async () => {
    const fx = createM4RealFixture();
    try {
      const prep = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 2 Context Firewall and Read-Only Sandbox",
        agentTestPath: "test/calc.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          'import { subtract } from "../src/calculator.mjs";',
          "assert.equal(subtract(20, 7), 13);",
          "",
        ].join("\n"),
      });

      // Attempt to leak developer scratchpad / CoT / push token -> must fail closed with ERR_REVIEWER_CONTEXT_LEAK
      for (const forbiddenPayload of [
        { developerScratchpad: "internal reasoning step 1" },
        { chainOfThought: "let me bypass tests" },
        { conversationHistory: [{ role: "assistant", content: "secret prompt" }] },
        { workerGitPushToken: "lease-token-xyz" },
      ]) {
        await assert.rejects(
          () =>
            fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
              task_id: prep.task.task_id,
              merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
              verification_run_id: prep.finalRun.verification_run_id,
              reviewer_principal_id: "rev-agent-clean",
              reviewer_agent_profile_id: "profile-reviewer-sec",
              reviewer_provider: "google",
              reviewer_model: "gemini-2.5-pro",
              developer_principal_id: "dev-agent-1",
              developer_session_id: "dev-sess-1",
              developer_credential_id: "dev-cred-1",
              developer_agent_profile_id: "profile-dev-1",
              writer_provider: "anthropic",
              writer_model: "claude-sonnet-4",
              agent_gateway: fx.gateway,
              reviewer_service: fx.reviewerService,
              repo_path: fx.bareRepoDir,
              tier3_test_files: ["test/calc.agent.test.mjs"],
              extra_forbidden_context: forbiddenPayload,
            }),
          (err: unknown) =>
            err instanceof ReviewerContextLeakError && err.code === "ERR_REVIEWER_CONTEXT_LEAK"
        );
      }

      // Clean execution verifies whitelist input, read-only extracted snapshot, and sandbox reap
      let capturedCleanInputKeys: string[] = [];
      let capturedDiffText = "";
      let writeBlockedInsideEvaluatorDir = false;

      const reviewOut = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prep.task.task_id,
        merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
        verification_run_id: prep.finalRun.verification_run_id,
        reviewer_principal_id: "rev-agent-clean",
        reviewer_agent_profile_id: "profile-reviewer-sec",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-agent-1",
        developer_session_id: "dev-sess-1",
        developer_credential_id: "dev-cred-1",
        developer_agent_profile_id: "profile-dev-1",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        reviewer_service: fx.reviewerService,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/calc.agent.test.mjs"],
        probe_read_only_enforcement: true,
        evaluator: (cleanInput) => {
          capturedCleanInputKeys = Object.keys(cleanInput).sort();
          capturedDiffText = cleanInput.diffText;
          if (typeof process.getuid === "function" && process.getuid() !== 0) {
            try {
              writeFileSync(join(cleanInput.extractedSnapshotDir, "src", "tamper.mjs"), "x", "utf8");
            } catch (err: unknown) {
              const code = (err as { code?: string }).code;
              if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
                writeBlockedInsideEvaluatorDir = true;
              }
            }
          } else {
            writeBlockedInsideEvaluatorDir = true;
          }
          return { verdict: "PASS" };
        },
      });

      assert.equal(reviewOut.reviewArtifact.verdict, "PASS");
      assert.equal(reviewOut.reviewArtifact.status, "VALID");
      assert.ok(reviewOut.approvalRequest);
      assert.equal(reviewOut.approvalRequest.status, "PENDING");
      assert.equal(reviewOut.taskStatus, "AwaitingHumanApproval");
      assert.equal(reviewOut.reviewSession.role, "ROLE_REVIEWER_READONLY");
      assert.equal(reviewOut.reviewSession.status, "COMPLETED");
      assert.equal(reviewOut.reviewSession.cleanup_populated_zero_verified, true);
      assert.ok(reviewOut.executionResult.sandboxPid && reviewOut.executionResult.sandboxPid > 0);
      assert.equal(reviewOut.executionResult.readOnlyEnforced, true);
      assert.equal(writeBlockedInsideEvaluatorDir, true);
      assert.match(capturedDiffText, /export function subtract/);
      assert.deepEqual(capturedCleanInputKeys, [
        "baseMainCommitHash",
        "changedFiles",
        "diffText",
        "extractedSnapshotDir",
        "mergeCandidateHash",
        "mergeCandidateId",
        "projectId",
        "taskContract",
        "taskId",
        "tier3Inspection",
        "verificationRunSummary",
        "verifiedTreeHash",
      ]);

      // Failed sessions from Context Firewall checks were recorded cleanly as FAILED (zero dangling ACTIVE sessions)
      const allSessions = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "operator-alice",
          currentRole: "core_api_service",
        },
        () => fx.store.listReviewSessionsForTask(prep.task.task_id)
      );
      assert.equal(allSessions.filter((s) => s.status === "FAILED").length, 4);
      assert.equal(allSessions.filter((s) => s.status === "ACTIVE").length, 0);
    } finally {
      fx.cleanup();
    }
  });

  it("M4-Gate-3: 3D Decision Independence rejects trivial/skipped/disconnected Tier-3 tests via AST inspection and auto-invalidates stale reviews on rerun or new candidate", async () => {
    const fx = createM4RealFixture();
    try {
      // Case A: Trivial assertions (`assert.equal(1, 1)` & `expect(true).toBe(true)`)
      const prepTrivial = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 3A Trivial Assertion Reject",
        agentTestPath: "test/trivial.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          "assert.equal(1, 1);",
          "const expect = (v) => ({ toBe: (e) => assert.equal(v, e) });",
          "expect(true).toBe(true);",
          "",
        ].join("\n"),
      });
      const revTrivial = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prepTrivial.task.task_id,
        merge_candidate_id: prepTrivial.mergeCandidate.merge_candidate_id,
        verification_run_id: prepTrivial.finalRun.verification_run_id,
        reviewer_principal_id: "rev-ast-01",
        reviewer_agent_profile_id: "profile-rev-ast",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-agent-1",
        developer_session_id: "dev-sess-t1",
        developer_credential_id: "dev-cred-t1",
        developer_agent_profile_id: "profile-dev-1",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/trivial.agent.test.mjs"],
      });
      assert.equal(revTrivial.reviewArtifact.verdict, "FAIL");
      assert.equal(revTrivial.approvalRequest, null);
      assert.equal(revTrivial.taskStatus, "ReworkRequired");
      assert.ok(
        revTrivial.executionResult.tier3Inspection.findings.some(
          (f) => f.code === "TRIVIAL_OR_TAUTOLOGICAL_ASSERTION"
        )
      );

      // Case B: Skipped / @Disabled tests
      const prepSkipped = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 3B Skipped Test Reject",
        agentTestPath: "test/skipped.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          'import { describe, it } from "node:test";',
          'import { subtract } from "../src/calculator.mjs";',
          "// @Disabled",
          'describe("calculator", () => {',
          '  it.skip("subtracts numbers", () => { assert.equal(subtract(5, 2), 3); });',
          "});",
          "",
        ].join("\n"),
      });
      const revSkipped = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prepSkipped.task.task_id,
        merge_candidate_id: prepSkipped.mergeCandidate.merge_candidate_id,
        verification_run_id: prepSkipped.finalRun.verification_run_id,
        reviewer_principal_id: "rev-ast-01",
        reviewer_agent_profile_id: "profile-rev-ast",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-agent-1",
        developer_session_id: "dev-sess-t2",
        developer_credential_id: "dev-cred-t2",
        developer_agent_profile_id: "profile-dev-1",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/skipped.agent.test.mjs"],
      });
      assert.equal(revSkipped.reviewArtifact.verdict, "FAIL");
      assert.equal(revSkipped.taskStatus, "ReworkRequired");
      assert.ok(
        revSkipped.executionResult.tier3Inspection.findings.some(
          (f) => f.code === "DISABLED_OR_SKIPPED_TEST"
        )
      );

      // Case C: Disconnected test with zero reference to modified source logic
      const prepDisconnected = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 3C Disconnected Test Reject",
        agentTestPath: "test/unrelated.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          "const items = [10, 20, 30];",
          "assert.equal(items.reduce((acc, n) => acc + n, 0), 60);",
          "",
        ].join("\n"),
      });
      const revDisconnected = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prepDisconnected.task.task_id,
        merge_candidate_id: prepDisconnected.mergeCandidate.merge_candidate_id,
        verification_run_id: prepDisconnected.finalRun.verification_run_id,
        reviewer_principal_id: "rev-ast-01",
        reviewer_agent_profile_id: "profile-rev-ast",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-agent-1",
        developer_session_id: "dev-sess-t3",
        developer_credential_id: "dev-cred-t3",
        developer_agent_profile_id: "profile-dev-1",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/unrelated.agent.test.mjs"],
      });
      assert.equal(revDisconnected.reviewArtifact.verdict, "FAIL");
      assert.ok(
        revDisconnected.executionResult.tier3Inspection.findings.some(
          (f) => f.code === "MISSING_MODIFIED_LOGIC_COVERAGE"
        )
      );

      // Case D: Auto-invalidation on Verifier rerun and 1-byte new MergeCandidate
      const prepValid = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 3D Auto Invalidation",
        agentTestPath: "test/valid.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          'import { subtract } from "../src/calculator.mjs";',
          "assert.equal(subtract(15, 5), 10);",
          "",
        ].join("\n"),
      });
      const rev1 = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prepValid.task.task_id,
        merge_candidate_id: prepValid.mergeCandidate.merge_candidate_id,
        verification_run_id: prepValid.finalRun.verification_run_id,
        reviewer_principal_id: "rev-ast-01",
        reviewer_agent_profile_id: "profile-rev-ast",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-agent-1",
        developer_session_id: "dev-sess-t4",
        developer_credential_id: "dev-cred-t4",
        developer_agent_profile_id: "profile-dev-1",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/valid.agent.test.mjs"],
      });
      assert.equal(rev1.reviewArtifact.status, "VALID");

      // Trigger new verification run on same candidate -> must auto-invalidate rev1 + its ApprovalRequest
      await fx.coreApi.verifyMergeCandidate(fx.projectId, fx.authOp, {
        task_id: prepValid.task.task_id,
        merge_candidate_id: prepValid.mergeCandidate.merge_candidate_id,
        verifier: fx.verifier,
        trusted_acceptance_dir: fx.trustedAcceptanceDir,
        execution_mode: "subprocess",
        tier1_command: {
          command: process.execPath,
          args: [join(fx.trustedAcceptanceDir, "acceptance.test.mjs")],
        },
        tier2_command: { command: process.execPath, args: ["baseline/baseline.test.mjs"] },
        tier3_command: { command: process.execPath, args: ["test/valid.agent.test.mjs"] },
        tier3_test_files: ["test/valid.agent.test.mjs"],
      });

      const oldAfterRerun = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "operator-alice",
          currentRole: "core_api_service",
        },
        () => ({
          ra: fx.store.getReviewArtifactById(rev1.reviewArtifact.review_artifact_id),
          ar: fx.store.getApprovalRequestById(rev1.approvalRequest!.approval_request_id),
        })
      );
      assert.equal(oldAfterRerun.ra?.status, "INVALIDATED_STALE_CANDIDATE");
      assert.equal(oldAfterRerun.ra?.is_invalidated, true);
      assert.equal(oldAfterRerun.ar?.status, "INVALIDATED_STALE_CANDIDATE");
    } finally {
      fx.cleanup();
    }
  });

  it("M4-Gate-4: Approval Center bundle, 8-field lock, ApprovalRequest TTL expiry (409 ERR_APPROVAL_EXPIRED_OR_STALE) & live main stale-base check", async () => {
    const fx = createM4RealFixture({ approvalTtlSeconds: 120 });
    try {
      const prep = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 4 Approval TTL and Stale Base",
        agentTestPath: "test/calc.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          'import { subtract } from "../src/calculator.mjs";',
          "assert.equal(subtract(8, 3), 5);",
          "",
        ].join("\n"),
      });

      const rev = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prep.task.task_id,
        merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
        verification_run_id: prep.finalRun.verification_run_id,
        reviewer_principal_id: "rev-04",
        reviewer_agent_profile_id: "profile-rev-04",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-04",
        developer_session_id: "dev-sess-04",
        developer_credential_id: "dev-cred-04",
        developer_agent_profile_id: "profile-dev-04",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/calc.agent.test.mjs"],
      });

      const bundle = await fx.webConsole.loadApprovalCenterBundle({
        auth: fx.authApprover,
        projectId: fx.projectId,
        taskId: prep.task.task_id,
        repoPath: fx.bareRepoDir,
      });
      assert.equal(bundle.staleBaseDetected, false);
      assert.equal(bundle.isExpiredAtNow, false);
      assert.equal(bundle.remainingTtlMs, 120_000);
      assert.ok(bundle.diffSummary.changedFiles.includes("src/calculator.mjs"));
      assert.match(fx.webConsole.renderApprovalCenterSummaryMarkdown(bundle), /Approval Center/);

      // Tampering even 1 of the 8 cryptographic fields must fail with 23503
      await assert.rejects(
        () =>
          fx.webConsole.approveCandidateWith8FieldBinding({
            auth: fx.authApprover,
            candidate: {
              ...prep.mergeCandidate,
              verified_tree_hash: "f".repeat(40),
            },
            verificationRun: prep.finalRun,
            reviewArtifact: rev.reviewArtifact,
            approvalRequestId: rev.approvalRequest!.approval_request_id,
          }),
        (err: unknown) => err instanceof Error && err.message.includes("composite 8-field")
      );

      // Advance clock +121s past ApprovalRequest.expires_at -> 409 ERR_APPROVAL_EXPIRED_OR_STALE
      fx.advanceClockMs(121_000);
      const expiredBundle = await fx.webConsole.loadApprovalCenterBundle({
        auth: fx.authApprover,
        projectId: fx.projectId,
        taskId: prep.task.task_id,
      });
      assert.equal(expiredBundle.isExpiredAtNow, true);

      await assert.rejects(
        () =>
          fx.webConsole.submitDecisionFromApprovalCenterView({
            auth: fx.authApprover,
            bundle: expiredBundle,
            decision: "APPROVED",
          }),
        (err: unknown) =>
          err instanceof ApprovalExpiredOrStaleError &&
          err.code === "ERR_APPROVAL_EXPIRED_OR_STALE" &&
          err.httpStatus === 409 &&
          err.approvalRequestStatus === "INVALIDATED_EXPIRED"
      );

      const postExpireState = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "approver-bob",
          currentRole: "core_api_service",
        },
        () => ({
          req: fx.store.getApprovalRequestById(rev.approvalRequest!.approval_request_id),
          task: fx.store.getTaskById(prep.task.task_id),
        })
      );
      assert.equal(postExpireState.req?.status, "INVALIDATED_EXPIRED");
      assert.equal(postExpireState.task?.status, "BuildingMergeCandidate");

      // Part B: Stale live Git main check inside Approval Center + submitHumanApproval
      const prepStale = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 4B Stale Main Check",
        agentTestPath: "test/calc2.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          'import { subtract } from "../src/calculator.mjs";',
          "assert.equal(subtract(30, 5), 25);",
          "",
        ].join("\n"),
      });
      const revStale = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prepStale.task.task_id,
        merge_candidate_id: prepStale.mergeCandidate.merge_candidate_id,
        verification_run_id: prepStale.finalRun.verification_run_id,
        reviewer_principal_id: "rev-04b",
        reviewer_agent_profile_id: "profile-rev-04b",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-04b",
        developer_session_id: "dev-sess-04b",
        developer_credential_id: "dev-cred-04b",
        developer_agent_profile_id: "profile-dev-04b",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/calc2.agent.test.mjs"],
      });

      // External commit pushes to real bareRepoDir main while human has modal open
      fx.gitAt(fx.mainWorkDir, ["pull", "origin", "main"]);
      writeFileSync(join(fx.mainWorkDir, "CHANGELOG.md"), "- Concurrent commit\n", "utf8");
      fx.gitAt(fx.mainWorkDir, ["add", "CHANGELOG.md"]);
      fx.gitAt(fx.mainWorkDir, ["commit", "-m", "docs: external main commit"]);
      fx.gitAt(fx.mainWorkDir, ["push", "origin", "main"]);
      const movedMainSha = fx.gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]);

      const staleBundle = await fx.webConsole.loadApprovalCenterBundle({
        auth: fx.authApprover,
        projectId: fx.projectId,
        taskId: prepStale.task.task_id,
        repoPath: fx.bareRepoDir,
      });
      assert.equal(staleBundle.staleBaseDetected, true);
      assert.equal(staleBundle.liveMainCommitHash, movedMainSha);

      await assert.rejects(
        () =>
          fx.webConsole.submitDecisionFromApprovalCenterView({
            auth: fx.authApprover,
            bundle: staleBundle,
            decision: "APPROVED",
            repoPath: fx.bareRepoDir,
          }),
        (err: unknown) =>
          err instanceof ApprovalExpiredOrStaleError &&
          err.code === "ERR_APPROVAL_EXPIRED_OR_STALE" &&
          err.approvalRequestStatus === "INVALIDATED_STALE_BASE"
      );

      const postStale = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "approver-bob",
          currentRole: "core_api_service",
        },
        () => ({
          req: fx.store.getApprovalRequestById(revStale.approvalRequest!.approval_request_id),
          ra: fx.store.getReviewArtifactById(revStale.reviewArtifact.review_artifact_id),
          task: fx.store.getTaskById(prepStale.task.task_id),
        })
      );
      assert.equal(postStale.req?.status, "INVALIDATED_STALE_BASE");
      assert.equal(postStale.ra?.status, "INVALIDATED_STALE_BASE");
      assert.equal(postStale.task?.status, "BuildingMergeCandidate");
      assert.equal(postStale.task?.base_main_commit_hash, movedMainSha);
    } finally {
      fx.cleanup();
    }
  });

  it("M4-Gate-5 (Scenario 9): Real Git post-merge crash after git update-ref recovers cleanly without double-merge across 5 idempotent retries", async () => {
    const fx = createM4RealFixture();
    try {
      const prep = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 5 Post-Merge Crash Reconciliation",
        agentTestPath: "test/calc-crash.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          'import { subtract } from "../src/calculator.mjs";',
          "assert.equal(subtract(50, 18), 32);",
          "",
        ].join("\n"),
      });

      const rev = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prep.task.task_id,
        merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
        verification_run_id: prep.finalRun.verification_run_id,
        reviewer_principal_id: "rev-crash-test",
        reviewer_agent_profile_id: "profile-rev-crash",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-crash-test",
        developer_session_id: "dev-sess-crash",
        developer_credential_id: "dev-cred-crash",
        developer_agent_profile_id: "profile-dev-crash",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/calc-crash.agent.test.mjs"],
      });

      const bundle = await fx.webConsole.loadApprovalCenterBundle({
        auth: fx.authApprover,
        projectId: fx.projectId,
        taskId: prep.task.task_id,
        repoPath: fx.bareRepoDir,
      });
      const approval = await fx.webConsole.submitDecisionFromApprovalCenterView({
        auth: fx.authApprover,
        bundle,
        decision: "APPROVED",
        repoPath: fx.bareRepoDir,
      });

      // Inject DB crash RIGHT AFTER real `git update-ref refs/heads/main <C_candidate> <B_base>` succeeds!
      await assert.rejects(
        () =>
          fx.coreApi.executeCasMerge(fx.projectId, fx.authOp, {
            task_id: prep.task.task_id,
            merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
            approval_id: approval.approval_id,
            require_real_git: true,
            simulateCrashAfterGitUpdateRef: true,
          }),
        (err: unknown) =>
          err instanceof SimulatedPostMergeCrashError &&
          err.code === "ERR_SIMULATED_POST_MERGE_CRASH"
      );

      // Confirm real bare repo main ALREADY moved to C_candidate while DB stays IN_PROGRESS / AtomicCasMerge
      const liveMainAfterCrash = fx.gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]);
      const revCountAfterCrash = fx.gitAt(fx.bareRepoDir, ["rev-list", "--count", "refs/heads/main"]);
      assert.equal(liveMainAfterCrash, prep.mergeCandidate.merge_candidate_hash);

      const midCrashDb = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "operator-alice",
          currentRole: "core_api_service",
        },
        () => ({
          task: fx.store.getTaskById(prep.task.task_id),
          ops: fx.store.listMergeOperationsForTask(prep.task.task_id),
        })
      );
      assert.equal(midCrashDb.task?.status, "AtomicCasMerge");
      assert.equal(midCrashDb.ops.length, 1);
      assert.equal(midCrashDb.ops[0]?.status, "IN_PROGRESS");

      // Execute 5 consecutive retries -> 1st reconciles lost response, retries 2..5 remain idempotent
      for (let attempt = 1; attempt <= 5; attempt++) {
        const res = await fx.coreApi.executeCasMerge(fx.projectId, fx.authOp, {
          task_id: prep.task.task_id,
          merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
          approval_id: approval.approval_id,
          require_real_git: true,
        });
        assert.equal(res.status, "RECONCILED_ALREADY_MERGED");
        assert.equal(res.task_status, "MergedAndCompleted");
        assert.equal(res.merged_commit_hash, prep.mergeCandidate.merge_candidate_hash);
        assert.equal(res.reconciled_after_lost_response, true);
      }

      // Git history count and merge_operations count never duplicated!
      assert.equal(
        fx.gitAt(fx.bareRepoDir, ["rev-list", "--count", "refs/heads/main"]),
        revCountAfterCrash
      );
      const afterRetries = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "operator-alice",
          currentRole: "core_api_service",
        },
        () => ({
          task: fx.store.getTaskById(prep.task.task_id),
          ops: fx.store.listMergeOperationsForTask(prep.task.task_id),
          events: fx.store.listOutboxEventsForProject(),
          req: fx.store.getApprovalRequestById(rev.approvalRequest!.approval_request_id),
        })
      );
      assert.equal(afterRetries.task?.status, "MergedAndCompleted");
      assert.equal(afterRetries.ops.length, 1);
      assert.equal(afterRetries.ops[0]?.status, "MERGED");
      assert.equal(afterRetries.ops[0]?.reconciled_after_lost_response, true);
      assert.equal(afterRetries.ops[0]?.retry_count, 5);
      assert.equal(
        afterRetries.events.filter((e) => e.event_type === "task.merged_reconciled").length,
        1
      );
      assert.equal(
        afterRetries.events.filter((e) => e.event_type === "task.merged").length,
        0
      );
      assert.equal(
        fx.snapshotStore.getManifest(prep.mergeCandidate.snapshot_path!)?.retentionClass,
        "MERGED_PERMANENT"
      );
    } finally {
      fx.cleanup();
    }
  });

  it("M4-Gate-6 (Scenario 10): Real Git true CAS conflict invalidates stale approval & review, rebuilds C_candidate_new on B_new, re-verifies, re-reviews, re-approves & merges with full Candidate-Bound Lineage", async () => {
    const fx = createM4RealFixture();
    try {
      const prep1 = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 6 True CAS Conflict and Rebase",
        agentTestPath: "test/calc-rebase.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          'import { subtract } from "../src/calculator.mjs";',
          "assert.equal(subtract(100, 42), 58);",
          "",
        ].join("\n"),
      });

      const rev1 = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prep1.task.task_id,
        merge_candidate_id: prep1.mergeCandidate.merge_candidate_id,
        verification_run_id: prep1.finalRun.verification_run_id,
        reviewer_principal_id: "rev-cas-01",
        reviewer_agent_profile_id: "profile-rev-cas",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-cas-01",
        developer_session_id: "dev-sess-cas-01",
        developer_credential_id: "dev-cred-cas-01",
        developer_agent_profile_id: "profile-dev-cas",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/calc-rebase.agent.test.mjs"],
      });

      const approval1 = await fx.webConsole.approveCandidateWith8FieldBinding({
        auth: fx.authApprover,
        candidate: prep1.mergeCandidate,
        verificationRun: prep1.finalRun,
        reviewArtifact: rev1.reviewArtifact,
        approvalRequestId: rev1.approvalRequest!.approval_request_id,
        repoPath: fx.bareRepoDir,
      });

      // Another task merges a non-conflicting change B_new onto refs/heads/main BEFORE CAS merge executes!
      fx.gitAt(fx.mainWorkDir, ["pull", "origin", "main"]);
      writeFileSync(join(fx.mainWorkDir, "RELEASE_NOTES.md"), "v1.5.1\n", "utf8");
      fx.gitAt(fx.mainWorkDir, ["add", "RELEASE_NOTES.md"]);
      fx.gitAt(fx.mainWorkDir, ["commit", "-m", "docs: release notes B_new"]);
      fx.gitAt(fx.mainWorkDir, ["push", "origin", "main"]);
      const bNewSha = fx.gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]);

      // Execute CAS merge -> must fail CAS without overwriting B_new and transition to BuildingMergeCandidate
      const conflictRes = await fx.coreApi.executeCasMerge(fx.projectId, fx.authOp, {
        task_id: prep1.task.task_id,
        merge_candidate_id: prep1.mergeCandidate.merge_candidate_id,
        approval_id: approval1.approval_id,
        require_real_git: true,
      });
      assert.equal(conflictRes.status, "CAS_CONFLICT_NEEDS_REBASE");
      assert.equal(conflictRes.task_status, "BuildingMergeCandidate");
      assert.equal(conflictRes.main_ref_commit_hash, bNewSha);
      assert.equal(fx.gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]), bNewSha);

      const midConflict = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "operator-alice",
          currentRole: "core_api_service",
        },
        () => ({
          oldApproval: fx.store.getApprovalById(approval1.approval_id),
          oldRequest: fx.store.getApprovalRequestById(rev1.approvalRequest!.approval_request_id),
          oldReview: fx.store.getReviewArtifactById(rev1.reviewArtifact.review_artifact_id),
          oldCandidate: fx.store.getMergeCandidateById(prep1.mergeCandidate.merge_candidate_id),
          ops: fx.store.listMergeOperationsForTask(prep1.task.task_id),
          task: fx.store.getTaskById(prep1.task.task_id),
        })
      );
      assert.equal(midConflict.oldApproval?.status, "INVALIDATED");
      assert.equal(midConflict.oldRequest?.status, "INVALIDATED_STALE_BASE");
      assert.equal(midConflict.oldReview?.status, "INVALIDATED_STALE_BASE");
      assert.equal(midConflict.oldReview?.is_invalidated, true);
      assert.equal(midConflict.oldCandidate?.is_superseded, true);
      assert.equal(midConflict.ops[0]?.status, "CAS_CONFLICT_ABORTED");
      assert.equal(midConflict.task?.base_main_commit_hash, bNewSha);

      // Rebuild C_candidate_2 against B_new WITHOUT re-running coding agent!
      const rebuilt = await fx.coreApi.rebuildMergeCandidateAfterCasConflict(
        fx.projectId,
        fx.authOp,
        { task_id: prep1.task.task_id }
      );
      assert.equal(rebuilt.ok, true);
      assert.equal(rebuilt.mergeCandidate.base_main_commit_hash, bNewSha);
      assert.notEqual(
        rebuilt.mergeCandidate.merge_candidate_hash,
        prep1.mergeCandidate.merge_candidate_hash
      );
      assert.notEqual(
        rebuilt.mergeCandidate.verified_tree_hash,
        prep1.mergeCandidate.verified_tree_hash
      );

      // Re-verify C_candidate_2 -> Re-review -> Approve -> CAS merge
      const verified2 = await fx.coreApi.verifyMergeCandidate(fx.projectId, fx.authOp, {
        task_id: prep1.task.task_id,
        merge_candidate_id: rebuilt.mergeCandidate.merge_candidate_id,
        verifier: fx.verifier,
        trusted_acceptance_dir: fx.trustedAcceptanceDir,
        execution_mode: "subprocess",
        tier1_command: {
          command: process.execPath,
          args: [join(fx.trustedAcceptanceDir, "acceptance.test.mjs")],
        },
        tier2_command: { command: process.execPath, args: ["baseline/baseline.test.mjs"] },
        tier3_command: { command: process.execPath, args: ["test/calc-rebase.agent.test.mjs"] },
        tier3_test_files: ["test/calc-rebase.agent.test.mjs"],
      });

      const rev2 = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prep1.task.task_id,
        merge_candidate_id: rebuilt.mergeCandidate.merge_candidate_id,
        verification_run_id: verified2.finalRun.verification_run_id,
        reviewer_principal_id: "rev-cas-02",
        reviewer_agent_profile_id: "profile-rev-cas",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-cas-01",
        developer_session_id: "dev-sess-cas-01",
        developer_credential_id: "dev-cred-cas-01",
        developer_agent_profile_id: "profile-dev-cas",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/calc-rebase.agent.test.mjs"],
      });

      // Stale rev1 cannot be bound to C_candidate_2!
      await assert.rejects(
        () =>
          fx.webConsole.approveCandidateWith8FieldBinding({
            auth: fx.authApprover,
            candidate: rebuilt.mergeCandidate,
            verificationRun: verified2.finalRun,
            reviewArtifact: rev1.reviewArtifact,
          }),
        (err: unknown) => err instanceof Error && err.message.includes("composite 8-field")
      );

      const bundle2 = await fx.webConsole.loadApprovalCenterBundle({
        auth: fx.authApprover,
        projectId: fx.projectId,
        taskId: prep1.task.task_id,
        repoPath: fx.bareRepoDir,
      });
      assert.equal(bundle2.staleBaseDetected, false);

      const approval2 = await fx.webConsole.submitDecisionFromApprovalCenterView({
        auth: fx.authApprover,
        bundle: bundle2,
        decision: "APPROVED",
        repoPath: fx.bareRepoDir,
      });

      const merge2 = await fx.coreApi.executeCasMerge(fx.projectId, fx.authOp, {
        task_id: prep1.task.task_id,
        merge_candidate_id: rebuilt.mergeCandidate.merge_candidate_id,
        approval_id: approval2.approval_id,
        require_real_git: true,
      });
      assert.equal(merge2.status, "MERGED_BY_CAS");
      assert.equal(merge2.task_status, "MergedAndCompleted");
      assert.equal(
        fx.gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]),
        rebuilt.mergeCandidate.merge_candidate_hash
      );

      // Verify both RELEASE_NOTES.md (from B_new) and subtract() (from C_agent) exist in final merged main tree!
      const mergedFiles = fx.gitAt(fx.bareRepoDir, [
        "ls-tree",
        "-r",
        "--name-only",
        rebuilt.mergeCandidate.merge_candidate_hash,
      ]);
      assert.match(mergedFiles, /RELEASE_NOTES\.md/);
      assert.match(mergedFiles, /src\/calculator\.mjs/);
      assert.match(mergedFiles, /test\/calc-rebase\.agent\.test\.mjs/);

      // Verify full Candidate-Bound Lineage (M5-AC8 foundation)
      const finalBundle = await fx.webConsole.loadApprovalCenterBundle({
        auth: fx.authApprover,
        projectId: fx.projectId,
        taskId: prep1.task.task_id,
        repoPath: fx.bareRepoDir,
      });
      assert.equal(
        finalBundle.candidateLineage.mainHeadCommitHash,
        rebuilt.mergeCandidate.merge_candidate_hash
      );
      assert.equal(finalBundle.candidateLineage.verifiedImport?.agent_commit_hash, prep1.agentCommitSha);
      assert.equal(
        finalBundle.candidateLineage.mergeCandidate?.merge_candidate_id,
        rebuilt.mergeCandidate.merge_candidate_id
      );
      assert.equal(
        finalBundle.candidateLineage.verificationRun?.verification_run_id,
        verified2.finalRun.verification_run_id
      );
      assert.equal(
        finalBundle.candidateLineage.reviewArtifact?.review_artifact_id,
        rev2.reviewArtifact.review_artifact_id
      );
      assert.equal(finalBundle.candidateLineage.approvalDecisions.length, 2);
      assert.equal(finalBundle.candidateLineage.mergeOperations.length, 2);
    } finally {
      fx.cleanup();
    }
  });

  it("M4-Gate-7: Enforces bounded rework cycle accounting (0 -> 1 -> ManualIntervention) and routes true rebase conflicts to ReworkRequired", async () => {
    const fx = createM4RealFixture();
    try {
      const prep = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 7 Bounded Rework and Merge Conflict",
        max_rework_cycles: 1,
        agentTestPath: "test/trivial-rework.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          "assert.equal(1, 1);",
          "",
        ].join("\n"),
      });

      // Cycle 0 fails Independent Review -> ReworkRequired (rework_count stays 0 until rework lease granted)
      const failRev1 = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prep.task.task_id,
        merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
        verification_run_id: prep.finalRun.verification_run_id,
        reviewer_principal_id: "rev-rework-1",
        reviewer_agent_profile_id: "profile-rev-rework",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-rework-1",
        developer_session_id: "dev-sess-rework-1",
        developer_credential_id: "dev-cred-rework-1",
        developer_agent_profile_id: "profile-dev-rework",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/trivial-rework.agent.test.mjs"],
      });
      assert.equal(failRev1.reviewArtifact.verdict, "FAIL");
      assert.equal(failRev1.taskStatus, "ReworkRequired");

      // Dispatch rework lease (cycle 1 of max 1): rework_count increments 0 -> 1
      const reworkLease = await fx.coreApi.dispatchTaskLease(fx.projectId, fx.authOp, {
        task_id: prep.task.task_id,
        worker_id: "worker-rework-epoch2",
      });
      assert.equal(reworkLease.lease_epoch, 2);

      const midTask = await fx.store.withRlsTransaction(
        {
          currentProjectId: fx.projectId,
          currentPrincipalId: "operator-alice",
          currentRole: "core_api_service",
        },
        () => fx.store.getTaskById(prep.task.task_id)
      );
      assert.equal(midTask?.rework_count, 1);

      // Push same failing trivial test on epoch 2 -> Re-verify -> Independent Review rejects -> ManualIntervention!
      const ref2 = `refs/factory/Verify/${prep.task.task_id}/${reworkLease.lease_epoch}`;
      fx.gitAt(fx.agentWorkDir, ["push", "origin", `${prep.agentCommitSha}:${ref2}`]);
      const build2 = await fx.coreApi.buildAndVerifyMergeCandidateFromGit(fx.projectId, fx.authOp, {
        task_id: prep.task.task_id,
        lease_id: reworkLease.lease_id,
        lease_epoch: reworkLease.lease_epoch,
        staging_ref: ref2,
        agent_commit_hash: prep.agentCommitSha,
        repo_path: fx.bareRepoDir,
        verifier: fx.verifier,
        trusted_acceptance_dir: fx.trustedAcceptanceDir,
        execution_mode: "subprocess",
        tier1_command: {
          command: process.execPath,
          args: [join(fx.trustedAcceptanceDir, "acceptance.test.mjs")],
        },
        tier2_command: { command: process.execPath, args: ["baseline/baseline.test.mjs"] },
        tier3_command: { command: process.execPath, args: ["test/trivial-rework.agent.test.mjs"] },
        tier3_test_files: ["test/trivial-rework.agent.test.mjs"],
      });
      assert.equal(build2.ok, true);

      const failRev2 = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prep.task.task_id,
        merge_candidate_id: build2.mergeCandidate.merge_candidate_id,
        verification_run_id: build2.finalRun.verification_run_id,
        reviewer_principal_id: "rev-rework-2",
        reviewer_agent_profile_id: "profile-rev-rework",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-rework-1",
        developer_session_id: "dev-sess-rework-2",
        developer_credential_id: "dev-cred-rework-2",
        developer_agent_profile_id: "profile-dev-rework",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/trivial-rework.agent.test.mjs"],
      });
      assert.equal(failRev2.reviewArtifact.verdict, "FAIL");
      assert.equal(failRev2.taskStatus, "ManualIntervention");

      // Part B: True code rebase MERGE_CONFLICT during rebuildMergeCandidateAfterCasConflict
      const prepConf = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 7B Rebase Text Conflict",
        agentTestPath: "test/calc-conf.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          'import { subtract } from "../src/calculator.mjs";',
          "assert.equal(subtract(9, 2), 7);",
          "",
        ].join("\n"),
      });
      const revConf = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prepConf.task.task_id,
        merge_candidate_id: prepConf.mergeCandidate.merge_candidate_id,
        verification_run_id: prepConf.finalRun.verification_run_id,
        reviewer_principal_id: "rev-conf",
        reviewer_agent_profile_id: "profile-rev-conf",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-conf",
        developer_session_id: "dev-sess-conf",
        developer_credential_id: "dev-cred-conf",
        developer_agent_profile_id: "profile-dev-conf",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/calc-conf.agent.test.mjs"],
      });
      const appConf = await fx.webConsole.approveCandidateWith8FieldBinding({
        auth: fx.authApprover,
        candidate: prepConf.mergeCandidate,
        verificationRun: prepConf.finalRun,
        reviewArtifact: revConf.reviewArtifact,
        repoPath: fx.bareRepoDir,
      });

      // Push a conflicting change to the SAME lines of src/calculator.mjs onto main!
      fx.gitAt(fx.mainWorkDir, ["pull", "origin", "main"]);
      writeFileSync(
        join(fx.mainWorkDir, "src", "calculator.mjs"),
        [
          "export function add(a, b) {",
          "  return Number(a) + Number(b);",
          "}",
          "",
          "export function multiply(a, b) {",
          "  return a * b;",
          "}",
          "",
          "export function subtract(a, b) {",
          "  throw new Error('different implementation on main');",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );
      fx.gitAt(fx.mainWorkDir, ["add", "src/calculator.mjs"]);
      fx.gitAt(fx.mainWorkDir, ["commit", "-m", "feat: conflicting change on main"]);
      fx.gitAt(fx.mainWorkDir, ["push", "origin", "main"]);

      const casAbort = await fx.coreApi.executeCasMerge(fx.projectId, fx.authOp, {
        task_id: prepConf.task.task_id,
        merge_candidate_id: prepConf.mergeCandidate.merge_candidate_id,
        approval_id: appConf.approval_id,
        require_real_git: true,
      });
      assert.equal(casAbort.status, "CAS_CONFLICT_NEEDS_REBASE");

      const rebuildConf = await fx.coreApi.rebuildMergeCandidateAfterCasConflict(
        fx.projectId,
        fx.authOp,
        { task_id: prepConf.task.task_id }
      );
      assert.equal(rebuildConf.ok, false);
      assert.equal(rebuildConf.reason, "MERGE_CONFLICT");
      assert.equal(rebuildConf.taskStatus, "ReworkRequired");
      assert.ok(rebuildConf.conflictedFiles.includes("src/calculator.mjs"));
    } finally {
      fx.cleanup();
    }
  });

  it("M4-Gate-8 (Review #209183213 Minor #1 & #2): Emits structured WARN_SNAPSHOT_PROMOTION_FAILED on corrupt manifest without rolling back CAS merge, and reports corruptManifestPaths during Snapshot GC", async () => {
    const fx = createM4RealFixture();
    try {
      const prep = await prepareVerifiedCandidate(fx, {
        title: "M4 Gate 8 Observability Minor 1 and 2",
        agentTestPath: "test/obs.agent.test.mjs",
        agentTestSource: [
          'import assert from "node:assert/strict";',
          'import { subtract } from "../src/calculator.mjs";',
          "assert.equal(subtract(12, 7), 5);",
          "",
        ].join("\n"),
      });

      const rev = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: prep.task.task_id,
        merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
        verification_run_id: prep.finalRun.verification_run_id,
        reviewer_principal_id: "rev-obs-01",
        reviewer_agent_profile_id: "profile-rev-obs",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-obs-01",
        developer_session_id: "dev-sess-obs",
        developer_credential_id: "dev-cred-obs",
        developer_agent_profile_id: "profile-dev-obs",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        agent_gateway: fx.gateway,
        repo_path: fx.bareRepoDir,
        tier3_test_files: ["test/obs.agent.test.mjs"],
      });

      const approval = await fx.webConsole.approveCandidateWith8FieldBinding({
        auth: fx.authApprover,
        candidate: prep.mergeCandidate,
        verificationRun: prep.finalRun,
        reviewArtifact: rev.reviewArtifact,
        repoPath: fx.bareRepoDir,
      });

      // Minor #1: Corrupt the candidate's .meta.json manifest BEFORE executeCasMerge
      const metaPath = `${prep.mergeCandidate.snapshot_path!}.meta.json`;
      writeFileSync(metaPath, "{not-valid-json", "utf8");

      const casRes = await fx.coreApi.executeCasMerge(fx.projectId, fx.authOp, {
        task_id: prep.task.task_id,
        merge_candidate_id: prep.mergeCandidate.merge_candidate_id,
        approval_id: approval.approval_id,
        require_real_git: true,
      });
      assert.equal(casRes.status, "MERGED_BY_CAS");
      assert.equal(casRes.task_status, "MergedAndCompleted");
      assert.equal(
        fx.gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]),
        prep.mergeCandidate.merge_candidate_hash
      );
      assert.equal(fx.warnings.length, 1);
      assert.equal(fx.warnings[0]?.code, "WARN_SNAPSHOT_PROMOTION_FAILED");
      assert.equal(fx.warnings[0]?.mergeCandidateId, prep.mergeCandidate.merge_candidate_id);

      // Minor #2: pruneExpiredSnapshots deletes valid expired snapshots & surfaces corruptManifestPaths
      const expiredCandDir = join(fx.snapshotDir, "expired-cand");
      mkdirSync(expiredCandDir, { recursive: true });
      const expiredTarPath = join(expiredCandDir, "snapshot-expired.tar");
      writeFileSync(expiredTarPath, "dummy-tar", "utf8");
      writeFileSync(
        `${expiredTarPath}.meta.json`,
        JSON.stringify({
          snapshotPath: expiredTarPath,
          snapshotSha256: "a".repeat(64),
          snapshotSizeBytes: 9,
          verifiedTreeHash: "b".repeat(40),
          mergeCandidateHash: "expired-cand",
          retentionClass: "EPHEMERAL_14D",
          createdAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-10-15T00:00:00.000Z",
        }),
        "utf8"
      );

      const missingFieldMeta = join(fx.snapshotDir, "bad-cand-1", "snapshot-bad1.tar.meta.json");
      mkdirSync(join(fx.snapshotDir, "bad-cand-1"), { recursive: true });
      writeFileSync(missingFieldMeta, JSON.stringify({ retentionClass: "EPHEMERAL_14D" }), "utf8");

      const badDateMeta = join(fx.snapshotDir, "bad-cand-2", "snapshot-bad2.tar.meta.json");
      mkdirSync(join(fx.snapshotDir, "bad-cand-2"), { recursive: true });
      writeFileSync(
        badDateMeta,
        JSON.stringify({
          snapshotPath: join(fx.snapshotDir, "bad-cand-2", "snapshot-bad2.tar"),
          retentionClass: "EPHEMERAL_14D",
          expiresAt: "not-a-timestamp",
        }),
        "utf8"
      );

      const gcRes = fx.snapshotStore.pruneExpiredSnapshots(new Date("2026-12-01T00:00:00.000Z"));
      assert.deepEqual(gcRes.deletedPaths, [expiredTarPath]);
      assert.equal(existsSync(expiredTarPath), false);
      assert.equal(gcRes.corruptManifestPaths.length, 3);
      assert.ok(gcRes.corruptManifestPaths.includes(metaPath));
      assert.ok(gcRes.corruptManifestPaths.includes(missingFieldMeta));
      assert.ok(gcRes.corruptManifestPaths.includes(badDateMeta));

      // Verify check only reads original readFileSync unchanged if needed
      assert.ok(readFileSync(badDateMeta, "utf8").includes("not-a-timestamp"));
    } finally {
      fx.cleanup();
    }
  });
});
