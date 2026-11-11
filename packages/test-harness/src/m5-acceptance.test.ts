import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, pbkdf2Sync, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import tls from "node:tls";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LiveModelProviderClient,
  ModelProviderConfigurationError,
  WorkspaceCodingAgentAdapter,
  applyWorkspaceEditsSync,
  evaluateIndependentReviewWithLiveModel,
} from "@software-factory/adapter-sdk";
import {
  AgentGatewayHttpServer,
  AgentGatewayService,
  EphemeralGitPushTokenService,
  EphemeralReviewerCredentialService,
  HttpAgentGatewayClient,
  createAgentGatewayRuntime,
} from "@software-factory/agent-gateway";
import {
  CORE_API_AUTH_HEADER,
  CoreApiHttpServer,
  type CoreApiAuthContext,
  CoreApiService,
  type CoreApiVerifyHttpPolicy,
  HttpCoreApiClient,
  HttpCoreApiError,
  createCoreApiRuntime,
  encodeCoreApiAuthHeader,
} from "@software-factory/core-api";
import {
  type ControlPlaneStore,
  PostgresControlPlaneRepository,
  PostgresRlsError,
  PostgresRuntimePool,
  SoftwareFactoryControlPlaneStore,
  buildCandidateBoundLineage,
  buildPostgresPoolConfigFromEnv,
  createControlPlaneStoreFromEnv,
} from "@software-factory/database";
import {
  type ApprovalDecisionRecord,
  type M5AcceptanceCriterionReport,
  type M5EnvironmentCapabilities,
  type M5EvidenceBundle,
  type M5FaultRecoveryScenarioReport,
  type ProcessedWorkerEventRecord,
  type ResourceUsageMetricRecord,
  type ReviewArtifactRecord,
  type VerificationRunRecord,
  canonicalizeJson,
  computeCanonicalPayloadSha256,
  computeEventIdempotencyKey,
  computeTaskExecutionIdempotencyKey,
  sha256Hex,
} from "@software-factory/shared-types";
import type { TaskContractSpec } from "@software-factory/task-contract";
import {
  Docker3TierVerifier,
  ImmutableSourceSnapshotStore,
  probeDockerVerifierSupport,
} from "@software-factory/verifier";
import {
  WebApprovalConsoleHttpServer,
  createControlPlaneStackRuntime,
} from "@software-factory/web";
import {
  LinuxCgroupV2SandboxBackend,
  WnaWorkerDaemon,
  probeLinuxCgroupV2Support,
  probeLinuxNamespaceSupport,
} from "@software-factory/wna";

function findPreReceiveHookSource(): string {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(cursor, "scripts", "git-hooks", "pre-receive");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const fromCwd = resolve(process.cwd(), "scripts", "git-hooks", "pre-receive");
  if (existsSync(fromCwd)) {
    return fromCwd;
  }
  throw new Error("Could not locate scripts/git-hooks/pre-receive");
}

function restoreWritableRecursive(targetDir: string): void {
  if (!existsSync(targetDir)) return;
  try {
    chmodSync(targetDir, 0o700);
  } catch {
    return;
  }
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    const full = join(targetDir, entry.name);
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        restoreWritableRecursive(full);
      } else {
        chmodSync(full, 0o600);
      }
    } catch {
      // best-effort cleanup
    }
  }
}

function gitAt(cwd: string, args: readonly string[], extraEnv?: Readonly<Record<string, string>>): string {
  return execFileSync("git", [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Software Factory Test",
      GIT_AUTHOR_EMAIL: "sf-test@software-factory.local",
      GIT_COMMITTER_NAME: "Software Factory Test",
      GIT_COMMITTER_EMAIL: "sf-test@software-factory.local",
      ...extraEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  }).trim();
}

function initializeBareGitRepoWithHook(rootDir: string, suffix = "main"): {
  readonly bareRepoDir: string;
  readonly mainWorkDir: string;
  readonly trustedAcceptanceDir: string;
  readonly initialMainSha: string;
  readonly initialMainTreeSha: string;
} {
  const bareRepoDir = join(rootDir, `remote-${suffix}.git`);
  const mainWorkDir = join(rootDir, `main-work-${suffix}`);
  const trustedAcceptanceDir = join(rootDir, `trusted-acceptance-${suffix}`);

  mkdirSync(bareRepoDir, { recursive: true });
  mkdirSync(mainWorkDir, { recursive: true });
  mkdirSync(trustedAcceptanceDir, { recursive: true });

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
    JSON.stringify({ name: "m5-sample-app", version: "1.5.0", type: "module" }, null, 2) + "\n",
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
      'import { add, multiply } from "../src/calculator.mjs";',
      "assert.equal(add(2, 3), 5);",
      "assert.equal(multiply(3, 4), 12);",
      'console.log("tier2-baseline-pass");',
      "",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(join(mainWorkDir, "README.md"), "# M5 Sample App\n", "utf8");

  gitAt(mainWorkDir, ["add", "."]);
  gitAt(mainWorkDir, ["commit", "-m", "chore: initial baseline B_base"]);
  gitAt(mainWorkDir, ["push", "-u", "origin", "main"]);

  const initialMainSha = gitAt(bareRepoDir, ["rev-parse", "refs/heads/main"]);
  const initialMainTreeSha = gitAt(bareRepoDir, ["rev-parse", `${initialMainSha}^{tree}`]);

  // Install the real fail-closed pre-receive hook AFTER seeding initial B_base on main
  const hooksDir = join(bareRepoDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookDest = join(hooksDir, "pre-receive");
  copyFileSync(findPreReceiveHookSource(), hookDest);
  chmodSync(hookDest, 0o755);

  writeFileSync(
    join(trustedAcceptanceDir, "acceptance.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { join } from "node:path";',
      'import { pathToFileURL } from "node:url";',
      'const mod = await import(pathToFileURL(join(process.cwd(), "src", "calculator.mjs")).href);',
      'assert.equal(typeof mod.subtract, "function");',
      "assert.equal(mod.subtract(10, 4), 6);",
      'console.log("tier1-trusted-acceptance-pass");',
      "",
    ].join("\n"),
    "utf8"
  );

  return {
    bareRepoDir,
    mainWorkDir,
    trustedAcceptanceDir,
    initialMainSha,
    initialMainTreeSha,
  };
}

/**
 * Advances refs/heads/main on bareRepoDir with a non-conflicting commit without bypassing
 * hooks/pre-receive (simulating another task's CAS merge on main).
 */
function advanceBareMainExternalCommit(options: {
  rootDir: string;
  bareRepoDir: string;
  relativePath: string;
  content: string;
  message: string;
}): { readonly oldMainSha: string; readonly newMainSha: string } {
  const oldMainSha = gitAt(options.bareRepoDir, ["rev-parse", "refs/heads/main"]);
  const tmpClone = mkdtempSync(join(options.rootDir, "ext-main-"));
  try {
    gitAt(options.rootDir, ["clone", options.bareRepoDir, tmpClone]);
    gitAt(tmpClone, ["checkout", "main"]);
    gitAt(tmpClone, ["config", "user.name", "Concurrent Merger"]);
    gitAt(tmpClone, ["config", "user.email", "merger@software-factory.local"]);
    const targetFile = join(tmpClone, options.relativePath);
    mkdirSync(dirname(targetFile), { recursive: true });
    writeFileSync(targetFile, options.content, "utf8");
    gitAt(tmpClone, ["add", options.relativePath]);
    gitAt(tmpClone, ["commit", "-m", options.message]);
    const newMainSha = gitAt(tmpClone, ["rev-parse", "HEAD"]);
    gitAt(options.bareRepoDir, ["fetch", tmpClone, "main"]);
    gitAt(options.bareRepoDir, ["update-ref", "refs/heads/main", newMainSha, oldMainSha]);
    return { oldMainSha, newMainSha };
  } finally {
    rmSync(tmpClone, { recursive: true, force: true });
  }
}

interface M5LiveStackFixture {
  readonly rootDir: string;
  readonly bareRepoDir: string;
  readonly mainWorkDir: string;
  readonly trustedAcceptanceDir: string;
  readonly worktreeBaseDir: string;
  readonly outboxDir: string;
  readonly snapshotDir: string;
  readonly store: SoftwareFactoryControlPlaneStore;
  readonly tokenService: EphemeralGitPushTokenService;
  readonly gatewayService: AgentGatewayService;
  readonly gatewayHttp: AgentGatewayHttpServer;
  readonly gatewayBaseUrl: string;
  readonly preReceiveUrl: string;
  readonly coreApi: CoreApiService;
  readonly coreHttp: CoreApiHttpServer;
  readonly coreClient: HttpCoreApiClient;
  readonly coreBaseUrl: string;
  readonly webHttp: WebApprovalConsoleHttpServer;
  readonly webBaseUrl: string;
  readonly verifier: Docker3TierVerifier;
  readonly useDocker: boolean;
  readonly projectId: string;
  readonly authOp: CoreApiAuthContext;
  readonly authApprover: CoreApiAuthContext;
  readonly authAdmin: CoreApiAuthContext;
  readonly initialMainSha: string;
  readonly contract: TaskContractSpec;
  advanceClockMs(ms: number): void;
  closeAndCleanup(): Promise<void>;
}

async function createM5LiveStackFixture(options?: {
  approvalTtlSeconds?: number;
  verifyPolicy?: CoreApiVerifyHttpPolicy;
  enableTestFaultInjection?: boolean;
  transientFaultHook?: {
    failBeforeCommitSeq?: Set<number>;
    dropAfterCommitSeq?: Set<number>;
  };
}): Promise<M5LiveStackFixture> {
  const rootDir = mkdtempSync(join(tmpdir(), "sf-m5-e2e-"));
  const worktreeBaseDir = join(rootDir, "worktrees");
  const outboxDir = join(rootDir, "outbox");
  const snapshotDir = join(rootDir, "snapshots");
  mkdirSync(worktreeBaseDir, { recursive: true });
  mkdirSync(outboxDir, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });

  const gitInit = initializeBareGitRepoWithHook(rootDir, "m5");

  let nowMs = Date.parse("2026-11-11T10:00:00.000Z");
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
        slug: `m5-project-${randomUUID().slice(0, 8)}`,
        name: "Milestone M5 Live Project",
        repo_bare_path: gitInit.bareRepoDir,
        initial_main_commit_hash: gitInit.initialMainSha,
        initial_main_tree_hash: gitInit.initialMainTreeSha,
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
      store.addProjectMembership({
        project_id: projectId,
        principal_id: "org-admin-zoe",
        member_role: "ORG_ADMIN",
      });
    }
  );

  const snapshotStore = new ImmutableSourceSnapshotStore({ storageDir: snapshotDir });
  const verifier = new Docker3TierVerifier({ snapshotStore });
  const tokenService = new EphemeralGitPushTokenService({ clockFn });
  const reviewerCredService = new EphemeralReviewerCredentialService({ clockFn });
  const gatewayService = new AgentGatewayService({
    store,
    projectId,
    reviewerCredentialService: reviewerCredService,
  });

  const gatewayHttp = new AgentGatewayHttpServer({
    store,
    tokenService,
    transientFaultHook: options?.transientFaultHook,
  });
  const gwInfo = await gatewayHttp.start();

  const coreApi = new CoreApiService(store, {
    clockFn,
    snapshotStore,
  });
  const coreHttp = new CoreApiHttpServer({
    coreApi,
    snapshotStore,
    defaultVerifier: verifier,
    defaultAgentGateway: gatewayService,
    verifyPolicy: options?.verifyPolicy,
    enableTestFaultInjection: options?.enableTestFaultInjection ?? false,
  });
  const coreInfo = await coreHttp.start();

  const webHttp = new WebApprovalConsoleHttpServer({ coreApi });
  const webInfo = await webHttp.start();

  const authOp = coreApi.issueAuthContext({
    projectId,
    principalId: "operator-alice",
    roles: ["DEVELOPER"],
    ttlMs: 3_600_000,
  });
  const authApprover = coreApi.issueAuthContext({
    projectId,
    principalId: "approver-bob",
    roles: ["PROJECT_APPROVER"],
    ttlMs: 3_600_000,
  });
  const authAdmin = coreApi.issueAuthContext({
    projectId,
    principalId: "org-admin-zoe",
    roles: ["ORG_ADMIN"],
    ttlMs: 3_600_000,
  });

  const contract: TaskContractSpec = {
    allowed_files: ["src/**", "test/**"],
    protected_paths: ["baseline/**", "package.json"],
    forbidden_paths: [".github/workflows/**", ".env*"],
    max_changed_files: 10,
    max_deleted_lines: 100,
  };

  const dockerProbe = probeDockerVerifierSupport("node:22-alpine");
  const useDocker = dockerProbe.daemonAvailable && dockerProbe.imageAvailable;

  return {
    rootDir,
    bareRepoDir: gitInit.bareRepoDir,
    mainWorkDir: gitInit.mainWorkDir,
    trustedAcceptanceDir: gitInit.trustedAcceptanceDir,
    worktreeBaseDir,
    outboxDir,
    snapshotDir,
    store,
    tokenService,
    gatewayService,
    gatewayHttp,
    gatewayBaseUrl: gwInfo.baseUrl,
    preReceiveUrl: gwInfo.url,
    coreApi,
    coreHttp,
    coreClient: new HttpCoreApiClient(coreInfo.baseUrl),
    coreBaseUrl: coreInfo.baseUrl,
    webHttp,
    webBaseUrl: webInfo.baseUrl,
    verifier,
    useDocker,
    projectId,
    authOp,
    authApprover,
    authAdmin,
    initialMainSha: gitInit.initialMainSha,
    contract,
    advanceClockMs,
    closeAndCleanup: async () => {
      await Promise.allSettled([webHttp.stop(), coreHttp.stop(), gatewayHttp.close()]);
      restoreWritableRecursive(snapshotDir);
      restoreWritableRecursive(rootDir);
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    },
  };
}

function buildVerifierCommands(useDocker: boolean) {
  const nodeBin = useDocker ? "node" : process.execPath;
  return {
    tier1_command: {
      command: nodeBin,
      args: [
        "-e",
        'import("node:url").then(({ pathToFileURL }) => import("node:path").then(({ join }) => import(pathToFileURL(join(process.env.SF_TRUSTED_ACCEPTANCE_DIR, "acceptance.test.mjs")).href)))',
      ],
    },
    tier2_command: {
      command: nodeBin,
      args: ["baseline/baseline.test.mjs"],
    },
    tier3_command: {
      command: nodeBin,
      args: ["test/calc.agent.test.mjs"],
    },
    tier3_test_files: ["test/calc.agent.test.mjs"],
  };
}

const VALID_CALCULATOR_SUBTRACT_SOURCE = [
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

const VALID_AGENT_TEST_SOURCE = [
  'import assert from "node:assert/strict";',
  'import { subtract } from "../src/calculator.mjs";',
  "assert.equal(subtract(15, 7), 8);",
  'console.log("tier3-agent-test-pass");',
  "",
].join("\n");

function runWorkerDaemonOverHttp(options: {
  fx: M5LiveStackFixture;
  task: Awaited<ReturnType<HttpCoreApiClient["createTask"]>>;
  lease: Awaited<ReturnType<HttpCoreApiClient["dispatchTaskLease"]>>;
  workerId: string;
  simulateCrashAfterPushBeforeCompletedEvent?: boolean;
  forceReconnectSyncReplayCheck?: boolean;
  sandboxBackend?: LinuxCgroupV2SandboxBackend;
}) {
  const { fx, task, lease } = options;
  const workerToken = fx.tokenService.issueLeasePushToken({
    projectId: fx.projectId,
    taskId: task.task_id,
    leaseId: lease.lease_id,
    leaseEpoch: lease.lease_epoch,
    workerId: options.workerId,
  });
  const gitPushToken = fx.tokenService.issueLeasePushToken({
    projectId: fx.projectId,
    taskId: task.task_id,
    leaseId: lease.lease_id,
    leaseEpoch: lease.lease_epoch,
    workerId: options.workerId,
  });
  const gatewayClient = new HttpAgentGatewayClient({
    baseUrl: fx.gatewayBaseUrl,
    bearerToken: workerToken,
  });
  const daemon = new WnaWorkerDaemon({
    gateway: gatewayClient,
    worktreeBaseDir: fx.worktreeBaseDir,
    outboxDir: fx.outboxDir,
    sandboxBackend: options.sandboxBackend ?? new LinuxCgroupV2SandboxBackend(),
  });
  const adapter = new WorkspaceCodingAgentAdapter({
    writerProvider: "anthropic",
    writerModel: "claude-sonnet-4",
    editsResolver: () => [
      { path: "src/calculator.mjs", content: VALID_CALCULATOR_SUBTRACT_SOURCE },
      { path: "test/calc.agent.test.mjs", content: VALID_AGENT_TEST_SOURCE },
    ],
  });
  return daemon.executeLease({
    task,
    lease,
    repoBarePath: fx.bareRepoDir,
    gitPushToken,
    preReceiveUrl: fx.preReceiveUrl,
    adapter,
    stagingRefKind: "staging",
    isolateNamespaces: false,
    dropPrivileges: false,
    simulateCrashAfterPushBeforeCompletedEvent:
      options.simulateCrashAfterPushBeforeCompletedEvent,
    forceReconnectSyncReplayCheck: options.forceReconnectSyncReplayCheck,
  });
}

async function runFullWorkflowToApproval(
  fx: M5LiveStackFixture,
  title: string,
  approvalRequestTtlMs?: number
) {
  const task = await fx.coreClient.createTask(fx.projectId, fx.authOp, {
    title,
    task_contract: fx.contract,
  });
  const workerId = `worker-${task.task_id.slice(0, 8)}`;
  const lease = await fx.coreClient.dispatchTaskLease(fx.projectId, fx.authOp, task.task_id, {
    worker_id: workerId,
  });
  const workerRes = await runWorkerDaemonOverHttp({ fx, task, lease, workerId });
  assert.equal(workerRes.outcome, "COMPLETED");
  assert.ok(workerRes.pushedCommitHash);

  const built = await fx.coreClient.buildCandidate(fx.projectId, fx.authOp, task.task_id, {
    lease_id: lease.lease_id,
    lease_epoch: lease.lease_epoch,
    staging_ref: workerRes.stagingRef,
    agent_commit_hash: workerRes.pushedCommitHash,
    repo_path: fx.bareRepoDir,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("Expected merge candidate build to succeed");

  const cmds = buildVerifierCommands(fx.useDocker);
  const verified = await fx.coreClient.verifyCandidate(fx.projectId, fx.authOp, task.task_id, {
    merge_candidate_id: built.mergeCandidate.merge_candidate_id,
    trusted_acceptance_dir: fx.trustedAcceptanceDir,
    repo_path: fx.bareRepoDir,
    execution_mode: "auto",
    network_disabled: true,
    ...cmds,
  });
  assert.equal(verified.finalRun.verdict, "PASS");

  const reviewed = await fx.coreClient.runIndependentReview(
    fx.projectId,
    fx.authOp,
    task.task_id,
    {
      merge_candidate_id: built.mergeCandidate.merge_candidate_id,
      verification_run_id: verified.finalRun.verification_run_id,
      reviewer_principal_id: `rev-principal-${task.task_id.slice(0, 8)}`,
      reviewer_agent_profile_id: "profile-reviewer-v1",
      reviewer_provider: "google",
      reviewer_model: "gemini-2.5-pro",
      developer_principal_id: "dev-principal-alpha",
      developer_session_id: `dev-sess-${lease.lease_id.slice(0, 8)}`,
      developer_credential_id: `dev-cred-${lease.lease_id.slice(0, 8)}`,
      developer_agent_profile_id: "profile-coder-v1",
      writer_provider: "anthropic",
      writer_model: "claude-sonnet-4",
      repo_path: fx.bareRepoDir,
      tier3_test_files: cmds.tier3_test_files,
      probe_read_only_enforcement: true,
      approval_request_ttl_ms: approvalRequestTtlMs,
    }
  );
  assert.equal(reviewed.reviewArtifact.verdict, "PASS");
  assert.equal(reviewed.taskStatus, "AwaitingHumanApproval");

  return { task, lease, workerRes, built, verified, reviewed };
}

describe("Milestone M5 Acceptance Gate Suite — P0-2 Live E2E, Fault Recovery, Models & PostgreSQL", () => {
  it("M5-Gate-1 (P0-2 Live Vertical Slice): Executes full 8-step HTTP + WNA + Git pre-receive + 3-Tier Verifier + 3D Review + 8-Field Approval + CAS Merge + AC-11a Lineage + AC-12a Metrics + M5 Evidence Bundle", async () => {
    const fx = await createM5LiveStackFixture();
    try {
      // M5-AC1 / M5-AC2 / M5-AC3: Step 1 & 2 over real CoreApiHttpServer + pre-receive main protection
      const task = await fx.coreClient.createTask(fx.projectId, fx.authOp, {
        title: "P0-2 Implement subtract() end-to-end",
        task_contract: fx.contract,
        base_main_commit_hash: fx.initialMainSha,
      });
      assert.equal(task.status, "Ready");

      const workerId = "wna-worker-p02";
      const lease = await fx.coreClient.dispatchTaskLease(
        fx.projectId,
        fx.authOp,
        task.task_id,
        { worker_id: workerId }
      );
      assert.equal(lease.lease_epoch, 1);

      // Negative Security Check: pre-receive hook MUST reject direct worker push to refs/heads/main
      const badToken = fx.tokenService.issueLeasePushToken({
        projectId: fx.projectId,
        taskId: task.task_id,
        leaseId: lease.lease_id,
        leaseEpoch: lease.lease_epoch,
        workerId,
      });
      const rogueDir = mkdtempSync(join(fx.rootDir, "rogue-push-"));
      gitAt(fx.rootDir, ["clone", fx.bareRepoDir, rogueDir]);
      writeFileSync(join(rogueDir, "src", "calculator.mjs"), "// bypass attempt\n", "utf8");
      gitAt(rogueDir, ["add", "src/calculator.mjs"]);
      gitAt(rogueDir, ["commit", "-m", "rogue direct push to main"]);
      const directPushRes = spawnSync(
        "git",
        ["push", fx.bareRepoDir, "HEAD:refs/heads/main"],
        {
          cwd: rogueDir,
          encoding: "utf8",
          env: {
            ...process.env,
            SF_GIT_LEASE_TOKEN: badToken,
            SF_GATEWAY_PRE_RECEIVE_URL: fx.preReceiveUrl,
          },
        }
      );
      assert.notEqual(
        directPushRes.status,
        0,
        "pre-receive hook must reject direct push to refs/heads/main"
      );
      assert.match(directPushRes.stderr ?? "", /forbidden|SF-PRE-RECEIVE/i);

      // Steps 3-4: WnaWorkerDaemon -> LocalOutboxBuffer (0600 .jsonl) -> WorkspaceCodingAgentAdapter -> git push -> pre-receive -> AgentGatewayHttpServer
      const workerRes = await runWorkerDaemonOverHttp({ fx, task, lease, workerId });
      assert.equal(workerRes.outcome, "COMPLETED");
      assert.ok(workerRes.pushedCommitHash);
      assert.ok(workerRes.outboxFilePath);
      assert.equal(statSync(workerRes.outboxFilePath!).mode & 0o777, 0o600);
      assert.equal(workerRes.cleanupEvidence?.populatedZeroVerified, true);
      assert.ok(workerRes.metricsSnapshot);
      assert.ok(
        workerRes.metricsSnapshot!.metricsSource === "cgroup-v2" ||
          workerRes.metricsSnapshot!.metricsSource === "process-rusage" ||
          workerRes.metricsSnapshot!.metricsSource === "wall-clock-only"
      );
      assert.equal(workerRes.recordedMetric?.phase, "DEVELOPER");

      const taskAfterWorker = await fx.coreClient.getTask(fx.projectId, fx.authOp, task.task_id);
      assert.equal(taskAfterWorker.status, "BuildingMergeCandidate");

      // Step 5: Candidate-First Merge Candidate + immutable .tar snapshot via HTTP
      const built = await fx.coreClient.buildCandidate(fx.projectId, fx.authOp, task.task_id, {
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: workerRes.stagingRef,
        agent_commit_hash: workerRes.pushedCommitHash!,
        repo_path: fx.bareRepoDir,
      });
      assert.equal(built.ok, true);
      if (!built.ok) throw new Error("Candidate build failed unexpectedly");
      assert.equal(built.verifiedImport.recovered_by_reconciler, false);

      // Step 6: 3-Tier Verifier over CoreApiHttpServer + VERIFIER metric (`AC-12a`)
      const cmds = buildVerifierCommands(fx.useDocker);
      const verified = await fx.coreClient.verifyCandidate(fx.projectId, fx.authOp, task.task_id, {
        merge_candidate_id: built.mergeCandidate.merge_candidate_id,
        trusted_acceptance_dir: fx.trustedAcceptanceDir,
        repo_path: fx.bareRepoDir,
        execution_mode: "auto",
        network_disabled: true,
        ...cmds,
      });
      assert.equal(verified.finalRun.verdict, "PASS");
      assert.equal(verified.finalRun.overall_status, "PASSED");
      assert.equal(verified.finalRun.tier1_trusted_acceptance_passed, true);
      assert.equal(verified.finalRun.tier2_protected_baseline_passed, true);
      assert.equal(verified.finalRun.tier3_agent_tests_passed, true);
      assert.equal(verified.taskStatus, "UnderIndependentReview");

      // Step 7: 3D Independent Reviewer over CoreApiHttpServer + REVIEWER metric (`AC-12a`)
      const reviewed = await fx.coreClient.runIndependentReview(
        fx.projectId,
        fx.authOp,
        task.task_id,
        {
          merge_candidate_id: built.mergeCandidate.merge_candidate_id,
          verification_run_id: verified.finalRun.verification_run_id,
          reviewer_principal_id: "rev-agent-gemini",
          reviewer_agent_profile_id: "profile-reviewer-v1",
          reviewer_provider: "google",
          reviewer_model: "gemini-2.5-pro",
          developer_principal_id: "dev-agent-claude",
          developer_session_id: `dev-sess-${lease.lease_id}`,
          developer_credential_id: `dev-cred-${lease.lease_id}`,
          developer_agent_profile_id: "profile-coder-v1",
          writer_provider: "anthropic",
          writer_model: "claude-sonnet-4",
          repo_path: fx.bareRepoDir,
          tier3_test_files: cmds.tier3_test_files,
          probe_read_only_enforcement: true,
        }
      );
      assert.equal(reviewed.reviewArtifact.verdict, "PASS");
      assert.equal(reviewed.approvalRequest?.status, "PENDING");
      assert.equal(reviewed.taskStatus, "AwaitingHumanApproval");

      // Step 8: Live Web Approval Console HTTP GET/POST + Negative 8-Field Tamper Check + Atomic CAS Merge
      const htmlResp = await fetch(
        `${fx.webBaseUrl}/projects/${encodeURIComponent(fx.projectId)}/tasks/${encodeURIComponent(
          task.task_id
        )}/approval-center?format=html&repo_path=${encodeURIComponent(fx.bareRepoDir)}`,
        {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(fx.authApprover) },
        }
      );
      assert.equal(htmlResp.status, 200);
      const htmlBody = await htmlResp.text();
      assert.match(htmlBody, /8-Field Cryptographic Lock Payload/);
      assert.ok(htmlBody.includes(built.mergeCandidate.merge_candidate_hash));

      const bundleJsonResp = await fetch(
        `${fx.webBaseUrl}/projects/${encodeURIComponent(fx.projectId)}/tasks/${encodeURIComponent(
          task.task_id
        )}/approval-center?format=json&repo_path=${encodeURIComponent(fx.bareRepoDir)}`,
        {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(fx.authApprover) },
        }
      );
      assert.equal(bundleJsonResp.status, 200);
      const bundleJson = (await bundleJsonResp.json()) as {
        eightFieldLockPayload: Record<string, string | null> | null;
      };
      assert.ok(bundleJson.eightFieldLockPayload);

      // Tamper 1 hex digit in merge_candidate_hash -> MUST fail closed over HTTP (404/422)
      const originalHash = built.mergeCandidate.merge_candidate_hash;
      const tamperedHash =
        (originalHash.startsWith("a") ? "b" : "a") + originalHash.slice(1);
      const tamperedResp = await fetch(
        `${fx.webBaseUrl}/projects/${encodeURIComponent(fx.projectId)}/tasks/${encodeURIComponent(
          task.task_id
        )}/approvals`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(fx.authApprover),
          },
          body: JSON.stringify({
            merge_candidate_id: built.mergeCandidate.merge_candidate_id,
            approval_request_id: reviewed.approvalRequest?.approval_request_id,
            agent_commit_hash: built.mergeCandidate.agent_commit_hash,
            base_main_commit_hash: built.mergeCandidate.base_main_commit_hash,
            verified_tree_hash: built.mergeCandidate.verified_tree_hash,
            merge_candidate_hash: tamperedHash,
            verification_run_id: verified.finalRun.verification_run_id,
            review_artifact_id: reviewed.reviewArtifact.review_artifact_id,
            decision: "APPROVED",
          }),
        }
      );
      assert.ok(
        tamperedResp.status === 404 || tamperedResp.status === 422,
        `Expected tampered 8-field approval to return 404 or 422, got ${tamperedResp.status}`
      );

      // Valid human approval via Web Console HTTP POST
      const approveResp = await fetch(
        `${fx.webBaseUrl}/projects/${encodeURIComponent(fx.projectId)}/tasks/${encodeURIComponent(
          task.task_id
        )}/approvals`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(fx.authApprover),
          },
          body: JSON.stringify({
            decision: "APPROVED",
            feedback: "LGTM - 3D review and 3-tier verification passed.",
            repo_path: fx.bareRepoDir,
          }),
        }
      );
      assert.equal(approveResp.status, 201);
      const approval = (await approveResp.json()) as { approval_id: string; status: string };
      assert.equal(approval.status, "ACTIVE");

      // Atomic CAS merge over HTTP -> real Git refs/heads/main updated
      const casMerge = await fx.coreClient.executeCasMerge(fx.projectId, fx.authOp, task.task_id, {
        merge_candidate_id: built.mergeCandidate.merge_candidate_id,
        approval_id: approval.approval_id,
        repo_path: fx.bareRepoDir,
        require_real_git: true,
      });
      assert.equal(casMerge.status, "MERGED_BY_CAS");
      assert.equal(casMerge.task_status, "MergedAndCompleted");

      const liveMainHead = gitAt(fx.bareRepoDir, ["rev-parse", "refs/heads/main"]);
      assert.equal(liveMainHead, built.mergeCandidate.merge_candidate_hash);

      // Verify fresh checkout of refs/heads/main actually runs add, multiply, AND subtract
      const verifyMainCheckout = join(fx.rootDir, "verify-merged-main");
      gitAt(fx.rootDir, ["clone", fx.bareRepoDir, verifyMainCheckout]);
      const execOut = execFileSync(
        process.execPath,
        [
          "-e",
          'import("./src/calculator.mjs").then((m) => { if (m.add(2,3)!==5 || m.multiply(3,4)!==12 || m.subtract(10,4)!==6) process.exit(1); console.log("MAIN_OK"); })',
        ],
        { cwd: verifyMainCheckout, encoding: "utf8" }
      );
      assert.match(execOut, /MAIN_OK/);

      // Step 9 (`AC-11a` & `AC-12a` & `M5-AC8`): Lineage endpoints + 3-phase Metrics + Signed M5 Evidence Bundle
      const lineage = await fx.coreClient.getCandidateLineage(
        fx.projectId,
        fx.authOp,
        task.task_id,
        { repo_path: fx.bareRepoDir }
      );
      assert.equal(lineage.lineageComplete, true);
      assert.equal(lineage.hashBindingVerified, true);
      assert.equal(lineage.gitLogHeadMatchesCandidate, true);
      assert.deepEqual(lineage.missingLinks, []);
      assert.equal(lineage.processedEventsCount, 4);

      const webLineageMd = await fetch(
        `${fx.webBaseUrl}/projects/${encodeURIComponent(fx.projectId)}/tasks/${encodeURIComponent(
          task.task_id
        )}/lineage?format=md&repo_path=${encodeURIComponent(fx.bareRepoDir)}`,
        {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(fx.authOp) },
        }
      );
      assert.equal(webLineageMd.status, 200);
      assert.match(await webLineageMd.text(), /Candidate-Bound Lineage/);

      const webLineageHtml = await fetch(
        `${fx.webBaseUrl}/projects/${encodeURIComponent(fx.projectId)}/tasks/${encodeURIComponent(
          task.task_id
        )}/lineage?format=html&repo_path=${encodeURIComponent(fx.bareRepoDir)}`,
        {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(fx.authOp) },
        }
      );
      assert.equal(webLineageHtml.status, 200);
      assert.match(await webLineageHtml.text(), /Resource Usage Telemetry/);

      const metrics: ResourceUsageMetricRecord[] = await fx.coreClient.listMetrics(
        fx.projectId,
        fx.authOp,
        task.task_id
      );
      const phases = new Set(metrics.map((m) => m.phase));
      assert.ok(phases.has("DEVELOPER"));
      assert.ok(phases.has("VERIFIER"));
      assert.ok(phases.has("REVIEWER"));

      const cgroupProbe = probeLinuxCgroupV2Support();
      const nsProbe = probeLinuxNamespaceSupport();
      const envCaps: M5EnvironmentCapabilities = {
        platform: process.platform,
        nodeVersion: process.version,
        dockerAvailable: fx.useDocker,
        cgroupV2Available: cgroupProbe.supported,
        linuxNamespacesAvailable: nsProbe.supported,
        postgresLiveTested: buildPostgresPoolConfigFromEnv() !== null,
      };
      const criteria: M5AcceptanceCriterionReport[] = [
        {
          criterionId: "M5-AC1",
          name: "HTTP Control Plane & Worker Gateway",
          status: "PASS",
          summary: "Tasks, leases, events, approvals, and CAS merge executed via live HTTP servers.",
          evidence: { coreBaseUrl: fx.coreBaseUrl, gatewayBaseUrl: fx.gatewayBaseUrl },
        },
        {
          criterionId: "M5-AC2",
          name: "Live WNA Daemon & Workspace Adapter",
          status: "PASS",
          summary: "WnaWorkerDaemon executed WorkspaceCodingAgentAdapter in detached worktree.",
          evidence: { commitHash: workerRes.pushedCommitHash },
        },
        {
          criterionId: "M5-AC3",
          name: "Fail-Closed Pre-Receive Hook",
          status: "PASS",
          summary: "Rejected direct push to main and admitted staging ref push through HTTP gateway.",
          evidence: { stagingRef: workerRes.stagingRef },
        },
        {
          criterionId: "M5-AC4",
          name: "Candidate-First & 3-Tier Verifier",
          status: "PASS",
          summary: "Verified immutable candidate snapshot with Tier 1/2/3 tests.",
          evidence: {
            mergeCandidateHash: built.mergeCandidate.merge_candidate_hash,
            backend: verified.finalRun.execution_backend,
          },
        },
        {
          criterionId: "M5-AC5",
          name: "3D Independent Reviewer",
          status: "PASS",
          summary: "Completed independent read-only review and issued PENDING ApprovalRequest.",
          evidence: { reviewArtifactId: reviewed.reviewArtifact.review_artifact_id },
        },
        {
          criterionId: "M5-AC6",
          name: "8-Field Human Approval & Atomic CAS",
          status: "PASS",
          summary: "Rejected tampered hash, accepted valid approval, updated refs/heads/main atomically.",
          evidence: { mainHead: liveMainHead },
        },
        {
          criterionId: "M5-AC7",
          name: "Fault Recovery Suite",
          status: "PASS",
          summary: "Verified reconnect replay, orphaned push recovery, CAS conflict rebase, and crash reconciliation.",
          evidence: { verifiedIn: "M5-Gate-2" },
        },
        {
          criterionId: "M5-AC8",
          name: "Candidate-Bound Lineage & Resource Metrics",
          status: "PASS",
          summary: "Exported complete lineage and DEVELOPER/VERIFIER/REVIEWER telemetry.",
          evidence: { metricCount: metrics.length },
        },
      ];
      const faultReports: M5FaultRecoveryScenarioReport[] = [
        {
          scenarioId: "M5-AC7a",
          title: "Gateway 503 & dropped ACK WAL reconnect replay",
          passed: true,
          details: "Covered in M5-Gate-2",
          evidence: {},
        },
      ];
      const bundle: M5EvidenceBundle = fx.coreApi.exportM5EvidenceBundle({
        lineage,
        criteria,
        faultRecoveryReports: faultReports,
        environmentCapabilities: envCaps,
      });
      const { bundleSha256, ...unsignedBundle } = bundle;
      assert.equal(sha256Hex(canonicalizeJson(unsignedBundle)), bundleSha256);
      assert.equal(bundle.verticalSliceSummary.taskStatus, "MergedAndCompleted");
      assert.equal(bundle.criteria.every((c) => c.status === "PASS"), true);
    } finally {
      await fx.closeAndCleanup();
    }
  });

  it("M5-Gate-2 (M5-AC7a..M5-AC7d Fault Recovery Suite): Recovers from HTTP gateway 503 + lost ACK, crashed worker push, concurrent main CAS conflict rebase, and Approval TTL expiry + post-merge crash", async () => {
    // --- M5-AC7a: Transient 503 before seq=2 AND lost ACK after commit seq=3 ---
    const fxA = await createM5LiveStackFixture({
      transientFaultHook: {
        failBeforeCommitSeq: new Set([2]),
        dropAfterCommitSeq: new Set([3]),
      },
    });
    try {
      const taskA = await fxA.coreClient.createTask(fxA.projectId, fxA.authOp, {
        title: "M5-AC7a Transient Gateway Fault",
        task_contract: fxA.contract,
      });
      const leaseA = await fxA.coreClient.dispatchTaskLease(
        fxA.projectId,
        fxA.authOp,
        taskA.task_id,
        { worker_id: "worker-ac7a" }
      );
      const resA = await runWorkerDaemonOverHttp({
        fx: fxA,
        task: taskA,
        lease: leaseA,
        workerId: "worker-ac7a",
      });
      assert.equal(resA.outcome, "COMPLETED");
      assert.equal(resA.reconnectSyncInvoked, true);

      const lineageA = await fxA.coreClient.getCandidateLineage(
        fxA.projectId,
        fxA.authOp,
        taskA.task_id
      );
      assert.equal(lineageA.task.status, "BuildingMergeCandidate");
      assert.equal(lineageA.processedEventsCount, 4);
      assert.deepEqual(
        lineageA.processedEvents.map((e) => e.sequence_no),
        [1, 2, 3, 4]
      );
    } finally {
      await fxA.closeAndCleanup();
    }

    // --- M5-AC7b: Worker crash right after push before task.completed -> Reconciler -> Merged without re-running agent ---
    const fxB = await createM5LiveStackFixture();
    try {
      const taskB = await fxB.coreClient.createTask(fxB.projectId, fxB.authOp, {
        title: "M5-AC7b Worker Crash After Push",
        task_contract: fxB.contract,
      });
      const leaseB = await fxB.coreClient.dispatchTaskLease(
        fxB.projectId,
        fxB.authOp,
        taskB.task_id,
        { worker_id: "worker-ac7b" }
      );
      const crashRes = await runWorkerDaemonOverHttp({
        fx: fxB,
        task: taskB,
        lease: leaseB,
        workerId: "worker-ac7b",
        simulateCrashAfterPushBeforeCompletedEvent: true,
      });
      assert.equal(crashRes.outcome, "SIMULATED_CRASH_BEFORE_COMPLETED");
      assert.ok(crashRes.pushedCommitHash);

      const taskBeforeReconcile = await fxB.coreClient.getTask(
        fxB.projectId,
        fxB.authOp,
        taskB.task_id
      );
      assert.equal(taskBeforeReconcile.status, "ExecutingInTarget");

      // Advance clock past lease TTL (35s) and invoke Orphaned Push Reconciler via HTTP
      fxB.advanceClockMs(40_000);
      const recovered = await fxB.coreClient.runOrphanedPushReconciler(fxB.projectId, fxB.authOp);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.task_id, taskB.task_id);
      assert.equal(recovered[0]?.outcome, "RECOVERED_ORPHANED_PUSH");

      const taskAfterReconcile = await fxB.coreClient.getTask(
        fxB.projectId,
        fxB.authOp,
        taskB.task_id
      );
      assert.equal(taskAfterReconcile.status, "BuildingMergeCandidate");

      // Resume downstream candidate build -> verify -> review -> approve -> CAS merge WITHOUT re-running agent
      const builtB = await fxB.coreClient.buildCandidate(fxB.projectId, fxB.authOp, taskB.task_id, {
        lease_id: leaseB.lease_id,
        lease_epoch: leaseB.lease_epoch,
        staging_ref: crashRes.stagingRef,
        agent_commit_hash: crashRes.pushedCommitHash!,
        repo_path: fxB.bareRepoDir,
      });
      assert.equal(builtB.ok, true);
      if (!builtB.ok) throw new Error("Expected recovered candidate build");
      assert.equal(builtB.verifiedImport.recovered_by_reconciler, true);

      const cmdsB = buildVerifierCommands(fxB.useDocker);
      const verB = await fxB.coreClient.verifyCandidate(fxB.projectId, fxB.authOp, taskB.task_id, {
        merge_candidate_id: builtB.mergeCandidate.merge_candidate_id,
        trusted_acceptance_dir: fxB.trustedAcceptanceDir,
        repo_path: fxB.bareRepoDir,
        execution_mode: "auto",
        ...cmdsB,
      });
      const revB = await fxB.coreClient.runIndependentReview(
        fxB.projectId,
        fxB.authOp,
        taskB.task_id,
        {
          merge_candidate_id: builtB.mergeCandidate.merge_candidate_id,
          verification_run_id: verB.finalRun.verification_run_id,
          reviewer_principal_id: "rev-b",
          reviewer_agent_profile_id: "prof-rev-b",
          reviewer_provider: "google",
          reviewer_model: "gemini-2.5-pro",
          developer_principal_id: "dev-b",
          developer_session_id: `dev-sess-${leaseB.lease_id}`,
          developer_credential_id: `dev-cred-${leaseB.lease_id}`,
          developer_agent_profile_id: "prof-dev-b",
          writer_provider: "anthropic",
          writer_model: "claude-sonnet-4",
          repo_path: fxB.bareRepoDir,
          tier3_test_files: cmdsB.tier3_test_files,
        }
      );
      const appB = await fxB.coreClient.submitApproval(
        fxB.projectId,
        fxB.authApprover,
        taskB.task_id,
        {
          merge_candidate_id: builtB.mergeCandidate.merge_candidate_id,
          approval_request_id: revB.approvalRequest?.approval_request_id,
          agent_commit_hash: builtB.mergeCandidate.agent_commit_hash,
          base_main_commit_hash: builtB.mergeCandidate.base_main_commit_hash,
          verified_tree_hash: builtB.mergeCandidate.verified_tree_hash,
          merge_candidate_hash: builtB.mergeCandidate.merge_candidate_hash,
          verification_run_id: verB.finalRun.verification_run_id,
          review_artifact_id: revB.reviewArtifact.review_artifact_id,
          decision: "APPROVED",
          repo_path: fxB.bareRepoDir,
        }
      );
      const casB = await fxB.coreClient.executeCasMerge(fxB.projectId, fxB.authOp, taskB.task_id, {
        merge_candidate_id: builtB.mergeCandidate.merge_candidate_id,
        approval_id: appB.approval_id,
        repo_path: fxB.bareRepoDir,
        require_real_git: true,
      });
      assert.equal(casB.status, "MERGED_BY_CAS");
      assert.equal(
        gitAt(fxB.bareRepoDir, ["rev-parse", "refs/heads/main"]),
        builtB.mergeCandidate.merge_candidate_hash
      );
    } finally {
      await fxB.closeAndCleanup();
    }

    // --- M5-AC7c & M5-AC7d: CAS Conflict Rebase -> Approval TTL Expiry -> Post-Merge Crash Reconciliation ---
    const fxCD = await createM5LiveStackFixture({
      approvalTtlSeconds: 60,
      enableTestFaultInjection: true,
    });
    try {
      // 1. M5-AC7c: Run to APPROVED on B_base, advance refs/heads/main concurrently, detect CAS conflict, rebase & merge
      const flowC = await runFullWorkflowToApproval(fxCD, "M5-AC7c CAS Conflict & Rebase", 60_000);
      const approvalC = await fxCD.coreClient.submitApproval(
        fxCD.projectId,
        fxCD.authApprover,
        flowC.task.task_id,
        {
          merge_candidate_id: flowC.built.mergeCandidate.merge_candidate_id,
          approval_request_id: flowC.reviewed.approvalRequest?.approval_request_id,
          agent_commit_hash: flowC.built.mergeCandidate.agent_commit_hash,
          base_main_commit_hash: flowC.built.mergeCandidate.base_main_commit_hash,
          verified_tree_hash: flowC.built.mergeCandidate.verified_tree_hash,
          merge_candidate_hash: flowC.built.mergeCandidate.merge_candidate_hash,
          verification_run_id: flowC.verified.finalRun.verification_run_id,
          review_artifact_id: flowC.reviewed.reviewArtifact.review_artifact_id,
          decision: "APPROVED",
          repo_path: fxCD.bareRepoDir,
        }
      );
      assert.equal(approvalC.status, "ACTIVE");

      // Advance bare main externally without touching src/calculator.mjs
      const extAdv = advanceBareMainExternalCommit({
        rootDir: fxCD.rootDir,
        bareRepoDir: fxCD.bareRepoDir,
        relativePath: "docs/concurrent.md",
        content: "# Concurrent Commit on Main\n",
        message: "docs: concurrent advance before CAS merge",
      });

      const conflictRes = await fxCD.coreClient.executeCasMerge(
        fxCD.projectId,
        fxCD.authOp,
        flowC.task.task_id,
        {
          merge_candidate_id: flowC.built.mergeCandidate.merge_candidate_id,
          approval_id: approvalC.approval_id,
          repo_path: fxCD.bareRepoDir,
          require_real_git: true,
        }
      );
      assert.equal(conflictRes.status, "CAS_CONFLICT_NEEDS_REBASE");
      assert.equal(conflictRes.task_status, "BuildingMergeCandidate");
      assert.equal(conflictRes.main_ref_commit_hash, extAdv.newMainSha);

      // Rebuild candidate cleanly onto new main, re-verify, re-review, re-approve
      const rebuiltC = await fxCD.coreClient.rebuildCandidate(
        fxCD.projectId,
        fxCD.authOp,
        flowC.task.task_id,
        { repo_path: fxCD.bareRepoDir }
      );
      assert.equal(rebuiltC.ok, true);
      if (!rebuiltC.ok) throw new Error("Expected clean rebase candidate build");
      assert.equal(rebuiltC.mergeCandidate.base_main_commit_hash, extAdv.newMainSha);
      assert.notEqual(
        rebuiltC.mergeCandidate.merge_candidate_id,
        flowC.built.mergeCandidate.merge_candidate_id
      );

      const cmdsC = buildVerifierCommands(fxCD.useDocker);
      const verC2 = await fxCD.coreClient.verifyCandidate(
        fxCD.projectId,
        fxCD.authOp,
        flowC.task.task_id,
        {
          merge_candidate_id: rebuiltC.mergeCandidate.merge_candidate_id,
          trusted_acceptance_dir: fxCD.trustedAcceptanceDir,
          repo_path: fxCD.bareRepoDir,
          execution_mode: "auto",
          ...cmdsC,
        }
      );
      const revC2 = await fxCD.coreClient.runIndependentReview(
        fxCD.projectId,
        fxCD.authOp,
        flowC.task.task_id,
        {
          merge_candidate_id: rebuiltC.mergeCandidate.merge_candidate_id,
          verification_run_id: verC2.finalRun.verification_run_id,
          reviewer_principal_id: "rev-c2",
          reviewer_agent_profile_id: "prof-rev-c2",
          reviewer_provider: "google",
          reviewer_model: "gemini-2.5-pro",
          developer_principal_id: "dev-c",
          developer_session_id: `dev-sess-${flowC.lease.lease_id}`,
          developer_credential_id: `dev-cred-${flowC.lease.lease_id}`,
          developer_agent_profile_id: "prof-dev-c",
          writer_provider: "anthropic",
          writer_model: "claude-sonnet-4",
          repo_path: fxCD.bareRepoDir,
          tier3_test_files: cmdsC.tier3_test_files,
          approval_request_ttl_ms: 10_000,
        }
      );

      // 2. M5-AC7d Part 1: Advance clock past ApprovalRequest 10s TTL -> expect 409 ERR_APPROVAL_EXPIRED_OR_STALE
      fxCD.advanceClockMs(15_000);
      await assert.rejects(
        () =>
          fxCD.coreClient.submitApproval(
            fxCD.projectId,
            fxCD.authApprover,
            flowC.task.task_id,
            {
              merge_candidate_id: rebuiltC.mergeCandidate.merge_candidate_id,
              approval_request_id: revC2.approvalRequest?.approval_request_id,
              agent_commit_hash: rebuiltC.mergeCandidate.agent_commit_hash,
              base_main_commit_hash: rebuiltC.mergeCandidate.base_main_commit_hash,
              verified_tree_hash: rebuiltC.mergeCandidate.verified_tree_hash,
              merge_candidate_hash: rebuiltC.mergeCandidate.merge_candidate_hash,
              verification_run_id: verC2.finalRun.verification_run_id,
              review_artifact_id: revC2.reviewArtifact.review_artifact_id,
              decision: "APPROVED",
              repo_path: fxCD.bareRepoDir,
            }
          ),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 409 &&
          err.body.error_code === "ERR_APPROVAL_EXPIRED_OR_STALE"
      );

      // Rebuild/re-verify/re-review to get fresh non-expired ApprovalRequest, then approve
      const rebuiltD = await fxCD.coreClient.rebuildCandidate(
        fxCD.projectId,
        fxCD.authOp,
        flowC.task.task_id,
        { repo_path: fxCD.bareRepoDir }
      );
      assert.equal(rebuiltD.ok, true);
      if (!rebuiltD.ok) throw new Error("Expected rebuild after expired approval");

      const verD = await fxCD.coreClient.verifyCandidate(
        fxCD.projectId,
        fxCD.authOp,
        flowC.task.task_id,
        {
          merge_candidate_id: rebuiltD.mergeCandidate.merge_candidate_id,
          trusted_acceptance_dir: fxCD.trustedAcceptanceDir,
          repo_path: fxCD.bareRepoDir,
          execution_mode: "auto",
          ...cmdsC,
        }
      );
      const revD = await fxCD.coreClient.runIndependentReview(
        fxCD.projectId,
        fxCD.authOp,
        flowC.task.task_id,
        {
          merge_candidate_id: rebuiltD.mergeCandidate.merge_candidate_id,
          verification_run_id: verD.finalRun.verification_run_id,
          reviewer_principal_id: "rev-d",
          reviewer_agent_profile_id: "prof-rev-d",
          reviewer_provider: "google",
          reviewer_model: "gemini-2.5-pro",
          developer_principal_id: "dev-d",
          developer_session_id: `dev-sess-${flowC.lease.lease_id}`,
          developer_credential_id: `dev-cred-${flowC.lease.lease_id}`,
          developer_agent_profile_id: "prof-dev-d",
          writer_provider: "anthropic",
          writer_model: "claude-sonnet-4",
          repo_path: fxCD.bareRepoDir,
          tier3_test_files: cmdsC.tier3_test_files,
        }
      );
      const freshApproval = await fxCD.coreClient.submitApproval(
        fxCD.projectId,
        fxCD.authApprover,
        flowC.task.task_id,
        {
          merge_candidate_id: rebuiltD.mergeCandidate.merge_candidate_id,
          approval_request_id: revD.approvalRequest?.approval_request_id,
          agent_commit_hash: rebuiltD.mergeCandidate.agent_commit_hash,
          base_main_commit_hash: rebuiltD.mergeCandidate.base_main_commit_hash,
          verified_tree_hash: rebuiltD.mergeCandidate.verified_tree_hash,
          merge_candidate_hash: rebuiltD.mergeCandidate.merge_candidate_hash,
          verification_run_id: verD.finalRun.verification_run_id,
          review_artifact_id: revD.reviewArtifact.review_artifact_id,
          decision: "APPROVED",
          repo_path: fxCD.bareRepoDir,
        }
      );

      // M5-AC7d Part 2: Crash right AFTER git update-ref moved refs/heads/main -> HTTP 500 -> Retry reconciles idempotently
      await assert.rejects(
        () =>
          fxCD.coreClient.executeCasMerge(fxCD.projectId, fxCD.authOp, flowC.task.task_id, {
            merge_candidate_id: rebuiltD.mergeCandidate.merge_candidate_id,
            approval_id: freshApproval.approval_id,
            repo_path: fxCD.bareRepoDir,
            require_real_git: true,
            simulateCrashAfterGitUpdateRef: true,
          }),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 500 &&
          err.body.error_code === "ERR_SIMULATED_POST_MERGE_CRASH"
      );

      assert.equal(
        gitAt(fxCD.bareRepoDir, ["rev-parse", "refs/heads/main"]),
        rebuiltD.mergeCandidate.merge_candidate_hash
      );

      const reconciled = await fxCD.coreClient.executeCasMerge(
        fxCD.projectId,
        fxCD.authOp,
        flowC.task.task_id,
        {
          merge_candidate_id: rebuiltD.mergeCandidate.merge_candidate_id,
          approval_id: freshApproval.approval_id,
          repo_path: fxCD.bareRepoDir,
          require_real_git: true,
        }
      );
      assert.equal(reconciled.status, "RECONCILED_ALREADY_MERGED");
      assert.equal(reconciled.reconciled_after_lost_response, true);
      assert.equal(reconciled.task_status, "MergedAndCompleted");

      // Confirm final main has BOTH concurrent docs/concurrent.md AND subtract()
      const finalCheck = join(fxCD.rootDir, "verify-rebased-main");
      gitAt(fxCD.rootDir, ["clone", fxCD.bareRepoDir, finalCheck]);
      assert.equal(existsSync(join(finalCheck, "docs", "concurrent.md")), true);
      const calcOut = execFileSync(
        process.execPath,
        [
          "-e",
          'import("./src/calculator.mjs").then((m) => { if (m.subtract(20, 8) !== 12) process.exit(1); })',
        ],
        { cwd: finalCheck, encoding: "utf8" }
      );
      assert.equal(typeof calcOut, "string");
    } finally {
      await fxCD.closeAndCleanup();
    }
  });

  it("M5-Gate-3 (M5-MODEL): Enforces fail-closed ModelProviderConfigurationError and executes live Anthropic, OpenAI & Gemini HTTP adapter + reviewer flows", async () => {
    // 1. Fail-closed configuration guards (missing API key -> ERR_MODEL_PROVIDER_NOT_CONFIGURED)
    for (const provider of ["anthropic", "openai", "google"] as const) {
      assert.throws(
        () =>
          new LiveModelProviderClient(
            {
              provider,
              model: "test-model-v1",
              apiKeyEnvVar: "SF_DEFINITELY_UNSET_KEY",
            },
            {}
          ),
        (err: unknown) =>
          err instanceof ModelProviderConfigurationError &&
          err.code === "ERR_MODEL_PROVIDER_NOT_CONFIGURED"
      );
    }

    // 2. Spin up local loopback HTTP mock server implementing Anthropic, OpenAI & Gemini wire formats
    let anthropicCalls = 0;
    let openaiCalls = 0;
    let geminiCalls = 0;
    let anthropicReturnMalformedJson = false;

    const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const c of req) {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    };

    const mockModelServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        await readJson(req);

        if (req.method === "POST" && url.pathname === "/v1/messages") {
          assert.equal(req.headers["x-api-key"], "anthropic-loopback-test-token-001");
          anthropicCalls += 1;
          const payload = anthropicReturnMalformedJson
            ? { content: [{ type: "text", text: "NOT_VALID_JSON_REVIEW" }] }
            : {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      verdict: "FAIL",
                      summaryMarkdown: "Anthropic found security issue.",
                      findings: [{ severity: "HIGH", detail: "Mock security rejection" }],
                    }),
                  },
                ],
                usage: { input_tokens: 10, output_tokens: 12 },
              };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        }

        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
          assert.equal(req.headers.authorization, "Bearer openai-loopback-test-token-001");
          openaiCalls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify([
                      { path: "src/calculator.mjs", content: VALID_CALCULATOR_SUBTRACT_SOURCE },
                      { path: "test/calc.agent.test.mjs", content: VALID_AGENT_TEST_SOURCE },
                    ]),
                  },
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 30 },
            })
          );
          return;
        }

        if (
          req.method === "POST" &&
          url.pathname.startsWith("/v1beta/models/") &&
          url.pathname.endsWith(":generateContent")
        ) {
          assert.equal(req.headers["x-goog-api-key"], "google-loopback-test-token-001");
          geminiCalls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          verdict: "PASS",
                          summaryMarkdown: "Gemini independent review passed cleanly.",
                          findings: [],
                        }),
                      },
                    ],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 18 },
            })
          );
          return;
        }

        res.writeHead(404);
        res.end("not found");
      })();
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      mockModelServer.once("error", rejectListen);
      mockModelServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const addr = mockModelServer.address();
    assert.ok(addr && typeof addr === "object");
    const mockBaseUrl = `http://127.0.0.1:${addr.port}`;

    const fx = await createM5LiveStackFixture();
    try {
      const openaiClient = new LiveModelProviderClient(
        {
          provider: "openai",
          model: "gpt-4.1",
          apiKeyEnvVar: "SF_TEST_OPENAI_KEY",
          baseUrl: mockBaseUrl,
        },
        { SF_TEST_OPENAI_KEY: "openai-loopback-test-token-001" }
      );
      const geminiClient = new LiveModelProviderClient(
        {
          provider: "google",
          model: "gemini-2.5-pro",
          apiKeyEnvVar: "SF_TEST_GEMINI_KEY",
          baseUrl: mockBaseUrl,
        },
        { SF_TEST_GEMINI_KEY: "google-loopback-test-token-001" }
      );
      const anthropicClient = new LiveModelProviderClient(
        {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKeyEnvVar: "SF_TEST_ANTHROPIC_KEY",
          baseUrl: mockBaseUrl,
        },
        { SF_TEST_ANTHROPIC_KEY: "anthropic-loopback-test-token-001" }
      );

      // Run WorkspaceCodingAgentAdapter with OpenAI LiveModelProviderClient (no editsResolver) inside WnaWorkerDaemon
      const task = await fx.coreClient.createTask(fx.projectId, fx.authOp, {
        title: "M5-MODEL OpenAI Agent + Gemini Reviewer",
        task_contract: fx.contract,
      });
      const lease = await fx.coreClient.dispatchTaskLease(fx.projectId, fx.authOp, task.task_id, {
        worker_id: "worker-m5-model",
      });
      const workerToken = fx.tokenService.issueLeasePushToken({
        projectId: fx.projectId,
        taskId: task.task_id,
        leaseId: lease.lease_id,
        leaseEpoch: lease.lease_epoch,
        workerId: "worker-m5-model",
      });
      const gitPushToken = fx.tokenService.issueLeasePushToken({
        projectId: fx.projectId,
        taskId: task.task_id,
        leaseId: lease.lease_id,
        leaseEpoch: lease.lease_epoch,
        workerId: "worker-m5-model",
      });
      const gwClient = new HttpAgentGatewayClient({
        baseUrl: fx.gatewayBaseUrl,
        bearerToken: workerToken,
      });
      const daemon = new WnaWorkerDaemon({
        gateway: gwClient,
        worktreeBaseDir: fx.worktreeBaseDir,
        outboxDir: fx.outboxDir,
      });
      const adapterWithOpenAi = new WorkspaceCodingAgentAdapter({
        modelClient: openaiClient,
      });
      const wnaRes = await daemon.executeLease({
        task,
        lease,
        repoBarePath: fx.bareRepoDir,
        gitPushToken,
        preReceiveUrl: fx.preReceiveUrl,
        adapter: adapterWithOpenAi,
        stagingRefKind: "staging",
        isolateNamespaces: false,
        dropPrivileges: false,
        hostEnvironmentToSanitize: {
          SF_TEST_OPENAI_KEY: "openai-loopback-test-token-001",
          OPENAI_API_KEY: "should-be-stripped",
        },
      });
      assert.equal(wnaRes.outcome, "COMPLETED");
      assert.equal(openaiCalls, 1);

      const built = await fx.coreClient.buildCandidate(fx.projectId, fx.authOp, task.task_id, {
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: wnaRes.stagingRef,
        agent_commit_hash: wnaRes.pushedCommitHash!,
        repo_path: fx.bareRepoDir,
      });
      assert.equal(built.ok, true);
      if (!built.ok) throw new Error("Expected model-generated candidate build");

      const cmds = buildVerifierCommands(fx.useDocker);
      const ver = await fx.coreClient.verifyCandidate(fx.projectId, fx.authOp, task.task_id, {
        merge_candidate_id: built.mergeCandidate.merge_candidate_id,
        trusted_acceptance_dir: fx.trustedAcceptanceDir,
        repo_path: fx.bareRepoDir,
        execution_mode: "auto",
        ...cmds,
      });

      // Evaluate with Gemini LiveModelProviderClient -> PASS inside CoreApiService.runIndependentReview
      const revPass = await fx.coreApi.runIndependentReview(fx.projectId, fx.authOp, {
        task_id: task.task_id,
        merge_candidate_id: built.mergeCandidate.merge_candidate_id,
        verification_run_id: ver.finalRun.verification_run_id,
        reviewer_principal_id: "rev-gemini-live",
        reviewer_agent_profile_id: "prof-gemini-live",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: "dev-openai-live",
        developer_session_id: `dev-sess-${lease.lease_id}`,
        developer_credential_id: `dev-cred-${lease.lease_id}`,
        developer_agent_profile_id: "prof-openai-live",
        writer_provider: "openai",
        writer_model: "gpt-4.1",
        agent_gateway: fx.gatewayService,
        repo_path: fx.bareRepoDir,
        tier3_test_files: cmds.tier3_test_files,
        evaluator: (evalInput) =>
          evaluateIndependentReviewWithLiveModel(geminiClient, {
            taskContract: evalInput.taskContract,
            diffText: evalInput.diffText,
            changedFiles: evalInput.changedFiles,
            verificationRunSummary: evalInput.verificationRunSummary,
          }),
      });
      assert.equal(geminiCalls, 1);
      assert.equal(revPass.reviewArtifact.verdict, "PASS");

      const verificationSummaryForLiveModel = {
        verification_run_id: ver.finalRun.verification_run_id,
        verdict: ver.finalRun.verdict,
        overall_status: ver.finalRun.overall_status ?? ver.finalRun.verdict,
        tier1_trusted_acceptance_passed: ver.finalRun.tier1_trusted_acceptance_passed ?? null,
        tier2_protected_baseline_passed: ver.finalRun.tier2_protected_baseline_passed ?? null,
        tier3_agent_tests_passed: ver.finalRun.tier3_agent_tests_passed ?? null,
      };

      // Evaluate with Anthropic LiveModelProviderClient -> FAIL verdict + malformed JSON fail-closed check
      const anthropicFail = await evaluateIndependentReviewWithLiveModel(anthropicClient, {
        taskContract: fx.contract,
        diffText: "+export const x = 1;",
        changedFiles: ["src/calculator.mjs"],
        verificationRunSummary: verificationSummaryForLiveModel,
      });
      assert.equal(anthropicFail.verdict, "FAIL");
      assert.equal(anthropicCalls, 1);

      anthropicReturnMalformedJson = true;
      const anthropicMalformed = await evaluateIndependentReviewWithLiveModel(anthropicClient, {
        taskContract: fx.contract,
        diffText: "+export const x = 1;",
        changedFiles: ["src/calculator.mjs"],
        verificationRunSummary: verificationSummaryForLiveModel,
      });
      assert.equal(anthropicMalformed.verdict, "FAIL");
      assert.equal(anthropicCalls, 2);
      assert.match(anthropicMalformed.findings[0]?.detail ?? "", /non-JSON/i);
    } finally {
      await new Promise<void>((r) => mockModelServer.close(() => r()));
      await fx.closeAndCleanup();
    }
  });

  it("M5-Gate-4 (M5-PG): Live PostgreSQL 16 Pool (SET LOCAL ROLE app_runtime + DISCARD ALL), RLS, Append-Only resource_usage_metrics, Full Workflow & Short-TTL Reconciler", async (t) => {
    const pgConfig = buildPostgresPoolConfigFromEnv();
    if (!pgConfig) {
      t.skip("PostgreSQL connection env (PGHOST/DATABASE_URL) not configured on local workstation");
      return;
    }

    const pool = new PostgresRuntimePool({
      ...pgConfig,
      maxConnections: 6,
    });
    const repo: ControlPlaneStore = new PostgresControlPlaneRepository(pool);

    const suffix = randomUUID().slice(0, 8);
    const rootDir = mkdtempSync(join(tmpdir(), `sf-m5-pg-${suffix}-`));
    const worktreeBaseDir = join(rootDir, "worktrees");
    const outboxDir = join(rootDir, "outbox");
    const snapshotDir = join(rootDir, "snapshots");
    mkdirSync(worktreeBaseDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });

    let gatewayHttpA: AgentGatewayHttpServer | null = null;
    let coreHttpA: CoreApiHttpServer | null = null;
    let webHttpA: WebApprovalConsoleHttpServer | null = null;

    try {
      const gitA = initializeBareGitRepoWithHook(rootDir, "pg-a");
      const gitB = initializeBareGitRepoWithHook(rootDir, "pg-b");

      let projectAId = "";
      let projectBId = "";

      await repo.withRlsTransaction(
        {
          currentRole: "system_admin_role",
          currentPrincipalId: "pg-test-bootstrap",
        },
        async () => {
          const projA = await repo.createProject({
            slug: `m5-pg-a-${suffix}`,
            name: `M5 PG Project A ${suffix}`,
            repo_bare_path: gitA.bareRepoDir,
            initial_main_commit_hash: gitA.initialMainSha,
            initial_main_tree_hash: gitA.initialMainTreeSha,
            approval_ttl_seconds: 180,
          });
          const projB = await repo.createProject({
            slug: `m5-pg-b-${suffix}`,
            name: `M5 PG Project B ${suffix}`,
            repo_bare_path: gitB.bareRepoDir,
            initial_main_commit_hash: gitB.initialMainSha,
            initial_main_tree_hash: gitB.initialMainTreeSha,
            approval_ttl_seconds: 180,
          });
          projectAId = projA.project_id;
          projectBId = projB.project_id;

          await repo.addProjectMembership({
            project_id: projectAId,
            principal_id: "pg-op-alice",
            member_role: "DEVELOPER",
          });
          await repo.addProjectMembership({
            project_id: projectAId,
            principal_id: "pg-approver-bob",
            member_role: "PROJECT_APPROVER",
          });
          await repo.addProjectMembership({
            project_id: projectBId,
            principal_id: "pg-op-carol",
            member_role: "DEVELOPER",
          });
        }
      );

      // Verify DISCARD ALL resets session and RLS isolates Project A vs Project B
      const contract: TaskContractSpec = {
        allowed_files: ["src/**", "test/**"],
        protected_paths: ["baseline/**", "package.json"],
        forbidden_paths: [".env*"],
        max_changed_files: 10,
        max_deleted_lines: 100,
      };

      await repo.withRlsTransaction(
        {
          currentProjectId: projectBId,
          currentPrincipalId: "pg-op-carol",
          currentRole: "core_api_service",
        },
        async () => {
          await repo.createTask({
            project_id: projectBId,
            title: `Tenant B Secret Task ${suffix}`,
            task_contract: contract,
          });
        }
      );

      const visibleToProjectA = await repo.withRlsTransaction(
        {
          currentProjectId: projectAId,
          currentPrincipalId: "pg-op-alice",
          currentRole: "core_api_service",
        },
        () => repo.selectVisibleTasks()
      );
      assert.equal(
        visibleToProjectA.some((tsk) => tsk.project_id === projectBId),
        false,
        "RLS + DISCARD ALL must never leak Project B rows to Project A"
      );

      // Stand up live HTTP + Worker + CoreApi + Web stack backed by PostgreSQL 16
      const snapshotStore = new ImmutableSourceSnapshotStore({ storageDir: snapshotDir });
      const verifier = new Docker3TierVerifier({ snapshotStore });
      const tokenService = new EphemeralGitPushTokenService();
      const reviewerCredService = new EphemeralReviewerCredentialService();
      const gatewayService = new AgentGatewayService({
        store: repo,
        projectId: projectAId,
        reviewerCredentialService: reviewerCredService,
      });
      gatewayHttpA = new AgentGatewayHttpServer({
        store: repo,
        tokenService,
      });
      const gwInfo = await gatewayHttpA.start();

      const coreApi = new CoreApiService(repo, { snapshotStore });
      coreHttpA = new CoreApiHttpServer({
        coreApi,
        snapshotStore,
        defaultVerifier: verifier,
        defaultAgentGateway: gatewayService,
      });
      const coreInfo = await coreHttpA.start();
      const coreClient = new HttpCoreApiClient(coreInfo.baseUrl);

      webHttpA = new WebApprovalConsoleHttpServer({ coreApi });
      const webInfo = await webHttpA.start();

      const authOp = coreApi.issueAuthContext({
        projectId: projectAId,
        principalId: "pg-op-alice",
        roles: ["DEVELOPER"],
      });
      const authApprover = coreApi.issueAuthContext({
        projectId: projectAId,
        principalId: "pg-approver-bob",
        roles: ["PROJECT_APPROVER"],
      });

      const dockerProbe = probeDockerVerifierSupport("node:22-alpine");
      const useDocker = dockerProbe.daemonAvailable && dockerProbe.imageAvailable;
      const cmds = buildVerifierCommands(useDocker);

      // Part 1: Full E2E workflow on live PostgreSQL 16 up to MERGED_BY_CAS
      const task1 = await coreClient.createTask(projectAId, authOp, {
        title: `PG Live Vertical Slice ${suffix}`,
        task_contract: contract,
      });
      const lease1 = await coreClient.dispatchTaskLease(projectAId, authOp, task1.task_id, {
        worker_id: `pg-worker-${suffix}`,
      });
      const workerToken1 = tokenService.issueLeasePushToken({
        projectId: projectAId,
        taskId: task1.task_id,
        leaseId: lease1.lease_id,
        leaseEpoch: lease1.lease_epoch,
        workerId: `pg-worker-${suffix}`,
      });
      const gitPushToken1 = tokenService.issueLeasePushToken({
        projectId: projectAId,
        taskId: task1.task_id,
        leaseId: lease1.lease_id,
        leaseEpoch: lease1.lease_epoch,
        workerId: `pg-worker-${suffix}`,
      });
      const daemon = new WnaWorkerDaemon({
        gateway: new HttpAgentGatewayClient({
          baseUrl: gwInfo.baseUrl,
          bearerToken: workerToken1,
        }),
        worktreeBaseDir,
        outboxDir,
      });
      const adapter = new WorkspaceCodingAgentAdapter({
        writerProvider: "anthropic",
        writerModel: "claude-sonnet-4",
        editsResolver: () => [
          { path: "src/calculator.mjs", content: VALID_CALCULATOR_SUBTRACT_SOURCE },
          { path: "test/calc.agent.test.mjs", content: VALID_AGENT_TEST_SOURCE },
        ],
      });
      const wnaRes1 = await daemon.executeLease({
        task: task1,
        lease: lease1,
        repoBarePath: gitA.bareRepoDir,
        gitPushToken: gitPushToken1,
        preReceiveUrl: gwInfo.url,
        adapter,
        stagingRefKind: "staging",
        isolateNamespaces: false,
        dropPrivileges: false,
      });
      assert.equal(wnaRes1.outcome, "COMPLETED");

      const built1 = await coreClient.buildCandidate(projectAId, authOp, task1.task_id, {
        lease_id: lease1.lease_id,
        lease_epoch: lease1.lease_epoch,
        staging_ref: wnaRes1.stagingRef,
        agent_commit_hash: wnaRes1.pushedCommitHash!,
        repo_path: gitA.bareRepoDir,
      });
      assert.equal(built1.ok, true);
      if (!built1.ok) throw new Error("Expected PG candidate build");

      const ver1 = await coreClient.verifyCandidate(projectAId, authOp, task1.task_id, {
        merge_candidate_id: built1.mergeCandidate.merge_candidate_id,
        trusted_acceptance_dir: gitA.trustedAcceptanceDir,
        repo_path: gitA.bareRepoDir,
        execution_mode: "auto",
        ...cmds,
      });
      assert.equal(ver1.finalRun.verdict, "PASS");

      const rev1 = await coreClient.runIndependentReview(projectAId, authOp, task1.task_id, {
        merge_candidate_id: built1.mergeCandidate.merge_candidate_id,
        verification_run_id: ver1.finalRun.verification_run_id,
        reviewer_principal_id: `pg-rev-${suffix}`,
        reviewer_agent_profile_id: "prof-pg-rev",
        reviewer_provider: "google",
        reviewer_model: "gemini-2.5-pro",
        developer_principal_id: `pg-dev-${suffix}`,
        developer_session_id: `pg-dev-sess-${lease1.lease_id}`,
        developer_credential_id: `pg-dev-cred-${lease1.lease_id}`,
        developer_agent_profile_id: "prof-pg-dev",
        writer_provider: "anthropic",
        writer_model: "claude-sonnet-4",
        repo_path: gitA.bareRepoDir,
        tier3_test_files: cmds.tier3_test_files,
        probe_read_only_enforcement: true,
      });
      assert.equal(rev1.reviewArtifact.verdict, "PASS");

      const webApproveResp = await fetch(
        `${webInfo.baseUrl}/projects/${encodeURIComponent(projectAId)}/tasks/${encodeURIComponent(
          task1.task_id
        )}/approvals`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover),
          },
          body: JSON.stringify({
            decision: "APPROVED",
            repo_path: gitA.bareRepoDir,
          }),
        }
      );
      assert.equal(webApproveResp.status, 201);
      const app1 = (await webApproveResp.json()) as { approval_id: string };

      const cas1 = await coreClient.executeCasMerge(projectAId, authOp, task1.task_id, {
        merge_candidate_id: built1.mergeCandidate.merge_candidate_id,
        approval_id: app1.approval_id,
        repo_path: gitA.bareRepoDir,
        require_real_git: true,
      });
      assert.equal(cas1.status, "MERGED_BY_CAS");

      const lineage1 = await coreClient.getCandidateLineage(projectAId, authOp, task1.task_id, {
        repo_path: gitA.bareRepoDir,
      });
      assert.equal(lineage1.lineageComplete, true);
      assert.equal(lineage1.gitLogHeadMatchesCandidate, true);

      const pgMetricPhases = new Set(lineage1.resourceUsageMetrics.map((m) => m.phase));
      assert.ok(pgMetricPhases.has("DEVELOPER"));
      assert.ok(pgMetricPhases.has("VERIFIER"));
      assert.ok(pgMetricPhases.has("REVIEWER"));

      // Verify resource_usage_metrics is strictly append-only under app_runtime (42501 on UPDATE/DELETE)
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-op-alice",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                "UPDATE resource_usage_metrics SET wall_time_ms = 0 WHERE task_id = $1::uuid;",
                [task1.task_id]
              )
          ),
        (err: unknown) =>
          (err instanceof PostgresRlsError && err.sqlState === "42501") ||
          (typeof (err as { sqlState?: string }).sqlState === "string" &&
            (err as { sqlState: string }).sqlState === "42501")
      );
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-op-alice",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query("DELETE FROM resource_usage_metrics WHERE task_id = $1::uuid;", [
                task1.task_id,
              ])
          ),
        (err: unknown) =>
          (err instanceof PostgresRlsError && err.sqlState === "42501") ||
          (typeof (err as { sqlState?: string }).sqlState === "string" &&
            (err as { sqlState: string }).sqlState === "42501")
      );

      // Part 2: Live PG short-TTL Orphaned Push Reconciler (respecting CHECK lease_ttl_ms >= heartbeat_interval_ms * 3)
      const task2 = await coreClient.createTask(projectAId, authOp, {
        title: `PG Short-TTL Orphaned Push ${suffix}`,
        task_contract: contract,
      });
      const lease2 = await coreClient.dispatchTaskLease(projectAId, authOp, task2.task_id, {
        worker_id: `pg-worker-orphan-${suffix}`,
        heartbeat_interval_ms: 1000,
        lease_ttl_ms: 5000,
      });
      const wt2 = tokenService.issueLeasePushToken({
        projectId: projectAId,
        taskId: task2.task_id,
        leaseId: lease2.lease_id,
        leaseEpoch: lease2.lease_epoch,
        workerId: `pg-worker-orphan-${suffix}`,
      });
      const gp2 = tokenService.issueLeasePushToken({
        projectId: projectAId,
        taskId: task2.task_id,
        leaseId: lease2.lease_id,
        leaseEpoch: lease2.lease_epoch,
        workerId: `pg-worker-orphan-${suffix}`,
      });
      const daemon2 = new WnaWorkerDaemon({
        gateway: new HttpAgentGatewayClient({
          baseUrl: gwInfo.baseUrl,
          bearerToken: wt2,
        }),
        worktreeBaseDir,
        outboxDir,
      });
      const adapter2 = new WorkspaceCodingAgentAdapter({
        writerProvider: "anthropic",
        writerModel: "claude-sonnet-4",
        editsResolver: () => [
          {
            path: "src/calculator.mjs",
            content:
              VALID_CALCULATOR_SUBTRACT_SOURCE +
              "\nexport function divide(a, b) {\n  return a / b;\n}\n",
          },
          {
            path: "test/calc-orphan.agent.test.mjs",
            content: [
              'import assert from "node:assert/strict";',
              'import { divide } from "../src/calculator.mjs";',
              "assert.equal(divide(12, 3), 4);",
              'console.log("tier3-orphan-agent-test-pass");',
              "",
            ].join("\n"),
          },
        ],
      });
      const crashRes2 = await daemon2.executeLease({
        task: task2,
        lease: lease2,
        repoBarePath: gitA.bareRepoDir,
        gitPushToken: gp2,
        preReceiveUrl: gwInfo.url,
        adapter: adapter2,
        stagingRefKind: "staging",
        isolateNamespaces: false,
        dropPrivileges: false,
        simulateCrashAfterPushBeforeCompletedEvent: true,
      });
      assert.equal(crashRes2.outcome, "SIMULATED_CRASH_BEFORE_COMPLETED");

      // Wait for real PostgreSQL clock_timestamp() to pass 5000ms TTL
      await new Promise((r) => setTimeout(r, 5150));
      const recoveredPg = await coreClient.runOrphanedPushReconciler(projectAId, authOp);
      const matchedRec = recoveredPg.find((r) => r.task_id === task2.task_id);
      assert.ok(matchedRec);
      assert.equal(matchedRec.outcome, "RECOVERED_ORPHANED_PUSH");

      const imports2 = await repo.withRlsTransaction(
        {
          currentProjectId: projectAId,
          currentPrincipalId: "pg-op-alice",
          currentRole: "core_api_service",
        },
        () => repo.getVerifiedImportsForTask(task2.task_id)
      );
      assert.equal(imports2.length, 1);
      assert.equal(imports2[0]?.recovered_by_reconciler, true);

      assert.ok(pool.getStats().discardAllExecuted > 0);

      // Part 3 (M5-FIX-16): getMainRefCommitHash(projectId?) scoping across multiple projects in PG
      const unscopedAdminHash = await repo.withRlsTransaction(
        {
          currentRole: "system_admin_role",
          currentPrincipalId: "pg-test-bootstrap",
        },
        () => repo.getMainRefCommitHash()
      );
      assert.equal(unscopedAdminHash, null);

      const scopedAHash = await repo.withRlsTransaction(
        {
          currentRole: "system_admin_role",
          currentPrincipalId: "pg-test-bootstrap",
        },
        () => repo.getMainRefCommitHash(projectAId)
      );
      assert.equal(scopedAHash, cas1.main_ref_commit_hash);

      const scopedBHash = await repo.withRlsTransaction(
        {
          currentRole: "system_admin_role",
          currentPrincipalId: "pg-test-bootstrap",
        },
        () => repo.getMainRefCommitHash(projectBId)
      );
      assert.equal(scopedBHash, gitB.initialMainSha);

      // Part 4 (M5-FIX-12): Column-level UPDATE grant on projects rejects arbitrary column writes under app_runtime
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-op-alice",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query("UPDATE projects SET slug = $2::text WHERE project_id = $1::uuid;", [
                projectAId,
                `tampered-${suffix}`,
              ])
          ),
        (err: unknown) =>
          (err instanceof PostgresRlsError && err.sqlState === "42501") ||
          (typeof (err as { sqlState?: string }).sqlState === "string" &&
            (err as { sqlState: string }).sqlState === "42501")
      );

      // Part 5 (M5-FIX-15): Unified metric defaults & negative rejection in PostgresControlPlaneRepository
      await assert.rejects(
        () =>
          repo.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: `pg-worker-${suffix}`,
              currentRole: "gateway_service",
            },
            () =>
              repo.recordResourceUsageMetric({
                project_id: projectAId,
                task_id: task1.task_id,
                lease_id: lease1.lease_id,
                lease_epoch: lease1.lease_epoch,
                phase: "DEVELOPER",
                wall_time_ms: -5,
                cpu_usage_usec: 10,
                peak_memory_bytes: 1024,
                sandbox_backend_mode: "real-process",
                metrics_source: "process-rusage",
              })
          ),
        (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
      );

      const defaultedPgMetric = await repo.withRlsTransaction(
        {
          currentProjectId: projectAId,
          currentPrincipalId: `pg-worker-${suffix}`,
          currentRole: "gateway_service",
        },
        () =>
          repo.recordResourceUsageMetric({
            project_id: projectAId,
            task_id: task1.task_id,
            lease_id: lease1.lease_id,
            lease_epoch: lease1.lease_epoch,
            phase: "DEVELOPER",
            wall_time_ms: 12,
            cpu_usage_usec: 20,
            peak_memory_bytes: 2048,
            sandbox_backend_mode: "real-process",
            metrics_source: "process-rusage",
          })
      );
      assert.equal(defaultedPgMetric.attempt_no, lease1.attempt_no);
      assert.equal(defaultedPgMetric.rework_cycle, task1.rework_count);

      // Part 6 (cd84dc7 minor #2): Single-connection pool getCandidateBoundLineage without deadlock/interleaving
      const singleConnPool = new PostgresRuntimePool({
        ...pgConfig,
        maxConnections: 1,
      });
      try {
        const singleRepo = new PostgresControlPlaneRepository(singleConnPool);
        const singleLineage = await singleRepo.withRlsTransaction(
          {
            currentProjectId: projectAId,
            currentPrincipalId: "pg-op-alice",
            currentRole: "core_api_service",
          },
          () => singleRepo.getCandidateBoundLineage(task1.task_id)
        );
        assert.ok(singleLineage);
        assert.equal(singleLineage.lineageComplete, true);
        assert.equal(singleLineage.hashBindingVerified, true);
        assert.ok(singleLineage.resourceUsageMetrics.length >= 3);
      } finally {
        await singleConnPool.close();
      }

      // Part 7 (M5-FIX-03): Validate approval_request_id BEFORE stale/expiry side effects on other candidates
      const synSetup = await repo.withRlsTransaction(
        {
          currentProjectId: projectAId,
          currentPrincipalId: "pg-op-alice",
          currentRole: "core_api_service",
        },
        async () => {
          const tA = await repo.createTask({
            project_id: projectAId,
            title: `PG FIX-03 Target ${suffix}`,
            task_contract: contract,
          });
          const tB = await repo.createTask({
            project_id: projectAId,
            title: `PG FIX-03 Donor ${suffix}`,
            task_contract: contract,
          });
          const lA = await repo.grantTaskLease({
            project_id: projectAId,
            task_id: tA.task_id,
            worker_id: `w-fix03-a-${suffix}`,
          });
          const lB = await repo.grantTaskLease({
            project_id: projectAId,
            task_id: tB.task_id,
            worker_id: `w-fix03-b-${suffix}`,
          });
          return { tA, tB, lA, lB };
        }
      );

      const mkHex = (ch: string) => ch.repeat(40);
      const fix03Built = await repo.withRlsTransaction(
        {
          currentProjectId: projectAId,
          currentPrincipalId: `w-fix03-${suffix}`,
          currentRole: "gateway_service",
        },
        async () => {
          const impA = await repo.pushStagingGitRefWithGatekeeper({
            project_id: projectAId,
            task_id: synSetup.tA.task_id,
            lease_id: synSetup.lA.lease_id,
            lease_epoch: synSetup.lA.lease_epoch,
            staging_ref: `refs/heads/sf/staging/${synSetup.tA.task_id}/${synSetup.lA.lease_epoch}`,
            agent_commit_hash: mkHex("a"),
            verified_tree_hash: mkHex("b"),
            parent_commit_hashes: [synSetup.tA.base_main_commit_hash],
            changes: [
              {
                path: "src/a.mjs",
                mode: "100644",
                size_bytes: 12,
                is_binary: false,
                added_lines: 1,
                deleted_lines: 0,
                blob_sha: mkHex("c"),
              },
            ],
          });
          const impB = await repo.pushStagingGitRefWithGatekeeper({
            project_id: projectAId,
            task_id: synSetup.tB.task_id,
            lease_id: synSetup.lB.lease_id,
            lease_epoch: synSetup.lB.lease_epoch,
            staging_ref: `refs/heads/sf/staging/${synSetup.tB.task_id}/${synSetup.lB.lease_epoch}`,
            agent_commit_hash: mkHex("d"),
            verified_tree_hash: mkHex("e"),
            parent_commit_hashes: [synSetup.tB.base_main_commit_hash],
            changes: [
              {
                path: "src/b.mjs",
                mode: "100644",
                size_bytes: 12,
                is_binary: false,
                added_lines: 1,
                deleted_lines: 0,
                blob_sha: mkHex("f"),
              },
            ],
          });
          assert.equal(impA.allowed, true);
          assert.equal(impB.allowed, true);
          for (const [taskItem, leaseItem] of [
            [synSetup.tA, synSetup.lA],
            [synSetup.tB, synSetup.lB],
          ] as const) {
            const execKey = computeTaskExecutionIdempotencyKey(
              projectAId,
              taskItem.task_id,
              leaseItem.attempt_no
            );
            for (const [seq, evType] of [
              [1, "task.started"],
              [2, "task.completed"],
            ] as const) {
              const evPayload: Record<string, unknown> = {};
              const ack = await repo.submitWorkerEvent({
                schema_version: "1.5",
                project_id: projectAId,
                task_id: taskItem.task_id,
                attempt_no: leaseItem.attempt_no,
                lease_id: leaseItem.lease_id,
                lease_epoch: leaseItem.lease_epoch,
                worker_id: leaseItem.worker_id,
                sequence_no: seq,
                event_type: evType,
                task_execution_idempotency_key: execKey,
                event_idempotency_key: computeEventIdempotencyKey(
                  leaseItem.lease_id,
                  leaseItem.lease_epoch,
                  seq,
                  evType
                ),
                payload_sha256: computeCanonicalPayloadSha256(evPayload),
                emitted_at: new Date().toISOString(),
                payload: evPayload,
              });
              assert.equal(ack.ack_status, "ACCEPTED");
            }
          }
          return { impAId: impA.import_id!, impBId: impB.import_id! };
        }
      );

      const fix03Ready = await repo.withRlsTransaction(
        {
          currentProjectId: projectAId,
          currentPrincipalId: "pg-op-alice",
          currentRole: "core_api_service",
        },
        async () => {
          const mcA = await repo.createMergeCandidate({
            project_id: projectAId,
            task_id: synSetup.tA.task_id,
            import_id: fix03Built.impAId,
            base_main_commit_hash: synSetup.tA.base_main_commit_hash,
            merge_candidate_hash: mkHex("1"),
            verified_tree_hash: mkHex("b"),
          });
          const mcB = await repo.createMergeCandidate({
            project_id: projectAId,
            task_id: synSetup.tB.task_id,
            import_id: fix03Built.impBId,
            base_main_commit_hash: synSetup.tB.base_main_commit_hash,
            merge_candidate_hash: mkHex("2"),
            verified_tree_hash: mkHex("e"),
          });
          const vrA = await repo.recordVerificationRun({
            project_id: projectAId,
            task_id: synSetup.tA.task_id,
            merge_candidate_id: mcA.merge_candidate_id,
            merge_candidate_hash: mcA.merge_candidate_hash,
            verified_tree_hash: mcA.verified_tree_hash,
            verifier_image_digest: "sha256:pg-fix03",
            verdict: "PASS",
            overall_status: "PASSED",
            tier1_trusted_acceptance_passed: true,
            tier2_protected_baseline_passed: true,
            tier2_baseline_tamper_detected: false,
            tier3_agent_tests_passed: true,
            tier3_assertions: [],
            exit_code: 0,
            duration_ms: 5,
            execution_backend: "docker",
            hermetic_network_disabled: true,
            hardlink_cache_forbidden: true,
            report_sha256: mkHex("3") + "a".repeat(24),
          });
          const vrB = await repo.recordVerificationRun({
            project_id: projectAId,
            task_id: synSetup.tB.task_id,
            merge_candidate_id: mcB.merge_candidate_id,
            merge_candidate_hash: mcB.merge_candidate_hash,
            verified_tree_hash: mcB.verified_tree_hash,
            verifier_image_digest: "sha256:pg-fix03",
            verdict: "PASS",
            overall_status: "PASSED",
            tier1_trusted_acceptance_passed: true,
            tier2_protected_baseline_passed: true,
            tier2_baseline_tamper_detected: false,
            tier3_agent_tests_passed: true,
            tier3_assertions: [],
            exit_code: 0,
            duration_ms: 5,
            execution_backend: "docker",
            hermetic_network_disabled: true,
            hardlink_cache_forbidden: true,
            report_sha256: mkHex("4") + "b".repeat(24),
          });
          const raA = await repo.recordReviewArtifact({
            project_id: projectAId,
            task_id: synSetup.tA.task_id,
            merge_candidate_id: mcA.merge_candidate_id,
            verification_run_id: vrA.verification_run_id,
            merge_candidate_hash: mcA.merge_candidate_hash,
            verified_tree_hash: mcA.verified_tree_hash,
            writer_provider: "anthropic",
            writer_model: "claude-sonnet-4",
            reviewer_provider: "google",
            reviewer_model: "gemini-2.5-pro",
            developer_principal_id: `dev-a-${suffix}`,
            reviewer_principal_id: `rev-a-${suffix}`,
            developer_session_id: `dev-sa-${suffix}`,
            reviewer_session_id: `rev-sa-${suffix}`,
            developer_credential_id: `dev-ca-${suffix}`,
            reviewer_credential_id: `rev-ca-${suffix}`,
            developer_agent_profile_id: "p-dev-a",
            reviewer_agent_profile_id: "p-rev-a",
            verdict: "PASS",
            approval_request_ttl_ms: 60_000,
          });
          const raB = await repo.recordReviewArtifact({
            project_id: projectAId,
            task_id: synSetup.tB.task_id,
            merge_candidate_id: mcB.merge_candidate_id,
            verification_run_id: vrB.verification_run_id,
            merge_candidate_hash: mcB.merge_candidate_hash,
            verified_tree_hash: mcB.verified_tree_hash,
            writer_provider: "anthropic",
            writer_model: "claude-sonnet-4",
            reviewer_provider: "google",
            reviewer_model: "gemini-2.5-pro",
            developer_principal_id: `dev-b-${suffix}`,
            reviewer_principal_id: `rev-b-${suffix}`,
            developer_session_id: `dev-sb-${suffix}`,
            reviewer_session_id: `rev-sb-${suffix}`,
            developer_credential_id: `dev-cb-${suffix}`,
            reviewer_credential_id: `rev-cb-${suffix}`,
            developer_agent_profile_id: "p-dev-b",
            reviewer_agent_profile_id: "p-rev-b",
            verdict: "PASS",
            approval_request_ttl_ms: 80,
          });
          const reqsB = await repo.listApprovalRequestsForTask(synSetup.tB.task_id);
          return { mcA, vrA, raA, raB, reqB: reqsB[0]! };
        }
      );

      // Let candidate B's approval_request expire, then pass it alongside candidate A's metadata:
      await new Promise((r) => setTimeout(r, 140));
      await assert.rejects(
        () =>
          repo.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-approver-bob",
              currentRole: "core_api_service",
            },
            () =>
              repo.submitHumanApproval({
                project_id: projectAId,
                task_id: synSetup.tA.task_id,
                merge_candidate_id: fix03Ready.mcA.merge_candidate_id,
                approval_request_id: fix03Ready.reqB.approval_request_id,
                agent_commit_hash: fix03Ready.mcA.agent_commit_hash,
                base_main_commit_hash: fix03Ready.mcA.base_main_commit_hash,
                verified_tree_hash: fix03Ready.mcA.verified_tree_hash,
                merge_candidate_hash: fix03Ready.mcA.merge_candidate_hash,
                verification_run_id: fix03Ready.vrA.verification_run_id,
                review_artifact_id: fix03Ready.raA.review_artifact_id,
                approver_principal_id: "pg-approver-bob",
                decision: "APPROVED",
                current_main_commit_hash: cas1.main_ref_commit_hash,
              })
          ),
        (err: unknown) =>
          err instanceof PostgresRlsError && (err.sqlState === "23514" || err.sqlState === "23503")
      );
      const reqBAfterAttempt = await repo.withRlsTransaction(
        {
          currentProjectId: projectAId,
          currentPrincipalId: "pg-op-alice",
          currentRole: "core_api_service",
        },
        () => repo.listApprovalRequestsForTask(synSetup.tB.task_id)
      );
      assert.equal(
        reqBAfterAttempt[0]?.status,
        "PENDING",
        "Cross-candidate expired approval_request_id must not mutate candidate B's approval request"
      );

      // Part 8 (M5-FIX-18): Pre-receive timeout rolls back SQL via SAVEPOINT without persisting verified_code_imports
      const synProj = await repo.withRlsTransaction(
        {
          currentRole: "system_admin_role",
          currentPrincipalId: "pg-test-bootstrap",
        },
        async () => {
          const p = await repo.createProject({
            slug: `m5-pg-syn-savepoint-${suffix}`,
            name: `M5 PG Savepoint ${suffix}`,
            repo_bare_path: join(rootDir, `missing-bare-${suffix}.git`),
            initial_main_commit_hash: mkHex("9"),
            initial_main_tree_hash: mkHex("8"),
            approval_ttl_seconds: 120,
          });
          await repo.addProjectMembership({
            project_id: p.project_id,
            principal_id: "pg-op-alice",
            member_role: "DEVELOPER",
          });
          return p;
        }
      );
      const synTaskLease = await repo.withRlsTransaction(
        {
          currentProjectId: synProj.project_id,
          currentPrincipalId: "pg-op-alice",
          currentRole: "core_api_service",
        },
        async () => {
          const t = await repo.createTask({
            project_id: synProj.project_id,
            title: `PG Savepoint Task ${suffix}`,
            task_contract: contract,
          });
          const l = await repo.grantTaskLease({
            project_id: synProj.project_id,
            task_id: t.task_id,
            worker_id: `w-savepoint-${suffix}`,
          });
          return { t, l };
        }
      );
      const synToken = tokenService.issueLeasePushToken({
        projectId: synProj.project_id,
        taskId: synTaskLease.t.task_id,
        leaseId: synTaskLease.l.lease_id,
        leaseEpoch: synTaskLease.l.lease_epoch,
        workerId: synTaskLease.l.worker_id,
      });
      const prevDeadline = gatewayHttpA.deadlineMs;
      const prevHook = gatewayHttpA.authorizeCheckHook;
      gatewayHttpA.deadlineMs = 40;
      gatewayHttpA.authorizeCheckHook = async () => {
        await new Promise((r) => setTimeout(r, 120));
      };
      try {
        const preRes = await fetch(`${gwInfo.baseUrl}/internal/v1/git/pre-receive-verify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${synToken}`,
          },
          body: JSON.stringify({
            old_sha: "0".repeat(40),
            new_sha: mkHex("7"),
            ref_name: `refs/heads/sf/staging/${synTaskLease.t.task_id}/${synTaskLease.l.lease_epoch}`,
            verified_tree_hash: mkHex("6"),
            parent_commit_hashes: [synProj.main_ref_commit_hash],
            changes: [
              {
                path: "src/savepoint.mjs",
                mode: "100644",
                size_bytes: 16,
                is_binary: false,
                added_lines: 2,
                deleted_lines: 0,
                blob_sha: mkHex("5"),
              },
            ],
          }),
        });
        assert.equal(preRes.status, 504);
      } finally {
        gatewayHttpA.deadlineMs = prevDeadline;
        gatewayHttpA.authorizeCheckHook = prevHook;
      }
      const importsAfterTimeout = await repo.withRlsTransaction(
        {
          currentProjectId: synProj.project_id,
          currentPrincipalId: "pg-op-alice",
          currentRole: "core_api_service",
        },
        () => repo.getVerifiedImportsForTask(synTaskLease.t.task_id)
      );
      assert.equal(
        importsAfterTimeout.length,
        0,
        "Timed-out pre-receive SQL must roll back via SAVEPOINT"
      );

      // Part 9 (M5-FIX-11): Production server runtime factories wired to live PostgresRuntimePool + HTTP
      const stackRuntime = await createControlPlaneStackRuntime({
        poolConfig: pgConfig,
        requirePostgres: true,
        withGatewayHttp: true,
      });
      const gwRuntime = await createAgentGatewayRuntime({
        poolConfig: pgConfig,
        requirePostgres: true,
      });
      try {
        assert.equal(stackRuntime.mode, "postgres");
        assert.ok(stackRuntime.pool !== null);
        assert.equal(gwRuntime.mode, "postgres");
        assert.ok(gwRuntime.pool !== null);

        const coreHealth = await fetch(`${stackRuntime.coreApiRuntime!.coreApiEndpoint!.baseUrl}/health`);
        assert.equal(coreHealth.status, 200);
        const webHealth = await fetch(`${stackRuntime.webEndpoint!.baseUrl}/health`);
        assert.equal(webHealth.status, 200);
        const gwHealth = await fetch(`${gwRuntime.endpoint!.baseUrl}/health`);
        assert.equal(gwHealth.status, 200);

        const prodClient = new HttpCoreApiClient(stackRuntime.coreApiRuntime!.coreApiEndpoint!.baseUrl);
        const prodOpAuth = stackRuntime.coreApiRuntime!.authenticator.issueAuthContext({
          projectId: projectAId,
          principalId: "pg-op-alice",
          roles: ["DEVELOPER"],
        });
        const prodApproverAuth = stackRuntime.coreApiRuntime!.authenticator.issueAuthContext({
          projectId: projectAId,
          principalId: "pg-approver-bob",
          roles: ["PROJECT_APPROVER"],
        });
        const createdViaProdRuntime = await prodClient.createTask(projectAId, prodOpAuth, {
          title: `M5-FIX-11 Live Prod PG Bootstrap Task ${suffix}`,
          task_contract: contract,
        });
        assert.equal(createdViaProdRuntime.project_id, projectAId);

        const lineageRes = await fetch(
          `${stackRuntime.webEndpoint!.baseUrl}/projects/${encodeURIComponent(
            projectAId
          )}/tasks/${encodeURIComponent(createdViaProdRuntime.task_id)}/lineage?format=json`,
          {
            headers: {
              [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(prodOpAuth),
            },
          }
        );
        assert.equal(lineageRes.status, 200);

        const forbiddenAcRes = await fetch(
          `${stackRuntime.webEndpoint!.baseUrl}/projects/${encodeURIComponent(
            projectAId
          )}/tasks/${encodeURIComponent(createdViaProdRuntime.task_id)}/approval-center?format=json`,
          {
            headers: {
              [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(prodOpAuth),
            },
          }
        );
        assert.equal(forbiddenAcRes.status, 403);

        const acRes = await fetch(
          `${stackRuntime.webEndpoint!.baseUrl}/projects/${encodeURIComponent(
            projectAId
          )}/tasks/${encodeURIComponent(createdViaProdRuntime.task_id)}/approval-center?format=json`,
          {
            headers: {
              [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(prodApproverAuth),
            },
          }
        );
        assert.equal(acRes.status, 200);
      } finally {
        await Promise.all([stackRuntime.close(), gwRuntime.close()]);
      }
      assert.equal(stackRuntime.pool!.getStats().totalConnections, 0);
      assert.equal(gwRuntime.pool!.getStats().totalConnections, 0);
    } finally {
      await Promise.allSettled([
        webHttpA?.stop(),
        coreHttpA?.stop(),
        gatewayHttpA?.close(),
        pool.close(),
      ]);
      restoreWritableRecursive(snapshotDir);
      restoreWritableRecursive(rootDir);
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  });

  it("M5-Gate-5 (M5-FIX-05, M5-FIX-19, cd84dc7#1): Enforces PostgreSQL wire TLS (SSLRequest/verify-full/prefer/require), rejects cleartext/MD5 by default, and enforces wire timeouts, buffer/SCRAM caps & clean close", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "sf-pg-tls-cert-"));
    const openSockets = new Set<net.Socket | tls.TLSSocket>();
    let server: net.Server | null = null;
    try {
      const keyPath = join(certDir, "server.key");
      const certPath = join(certDir, "server.crt");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "pipe" }
      );
      const serverKeyPem = readFileSync(keyPath, "utf8");
      const serverCertPem = readFileSync(certPath, "utf8");

      const behavior = {
        sslMode: "accept" as "accept" | "reject",
        authMode: "scram" as "scram" | "cleartext" | "md5",
        scramIterations: 4096,
        stallQueryMs: 0,
        sendOversizedFrame: false,
        tlsConnectionsAccepted: 0,
        receivedTerminateCount: 0,
      };
      const testPassword = "sf-scram-test-password";

      const encodeMsg = (type: string, body: Buffer): Buffer => {
        const hdr = Buffer.allocUnsafe(5);
        hdr.writeUInt8(type.charCodeAt(0), 0);
        hdr.writeInt32BE(4 + body.length, 1);
        return Buffer.concat([hdr, body]);
      };

      const startWireSession = (
        stream: net.Socket | tls.TLSSocket
      ): void => {
        let buf = Buffer.alloc(0);
        let started = false;
        let clientFirstBare = "";
        let serverFirstMsg = "";
        const salt = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

        const sendReadyOk = () => {
          const authOk = Buffer.alloc(4);
          authOk.writeInt32BE(0, 0);
          stream.write(
            Buffer.concat([
              encodeMsg("R", authOk),
              encodeMsg("Z", Buffer.from("I")),
            ])
          );
        };

        const sendRowSelect1 = () => {
          if (behavior.sendOversizedFrame) {
            const hugeHdr = Buffer.allocUnsafe(5);
            hugeHdr.writeUInt8("D".charCodeAt(0), 0);
            hugeHdr.writeInt32BE(64 * 1024, 1);
            stream.write(Buffer.concat([hugeHdr, Buffer.alloc(4096, 0x41)]));
            return;
          }
          // RowDescription: 1 col "ok" (tableOid=0, attr=0, typeOid=23, size=4, mod=-1, fmt=0)
          const nameBuf = Buffer.from("ok\0", "utf8");
          const descBody = Buffer.allocUnsafe(2 + nameBuf.length + 18);
          descBody.writeInt16BE(1, 0);
          nameBuf.copy(descBody, 2);
          let off = 2 + nameBuf.length;
          descBody.writeInt32BE(0, off);
          descBody.writeInt16BE(0, off + 4);
          descBody.writeInt32BE(23, off + 6);
          descBody.writeInt16BE(4, off + 10);
          descBody.writeInt32BE(-1, off + 12);
          descBody.writeInt16BE(0, off + 16);

          const dataBody = Buffer.allocUnsafe(2 + 4 + 1);
          dataBody.writeInt16BE(1, 0);
          dataBody.writeInt32BE(1, 2);
          dataBody.write("1", 6, "utf8");

          stream.write(
            Buffer.concat([
              encodeMsg("T", descBody),
              encodeMsg("D", dataBody),
              encodeMsg("C", Buffer.from("SELECT 1\0")),
              encodeMsg("Z", Buffer.from("I")),
            ])
          );
        };

        const handlePacket = (type: string, payload: Buffer) => {
          if (type === "X") {
            behavior.receivedTerminateCount += 1;
            stream.end();
            return;
          }
          if (type === "p") {
            if (behavior.authMode === "cleartext" || behavior.authMode === "md5") {
              sendReadyOk();
              return;
            }
            if (!serverFirstMsg) {
              // SASLInitialResponse: mech\0 + int32 len + client-first
              const nulIdx = payload.indexOf(0);
              const len = payload.readInt32BE(nulIdx + 1);
              const clientFirst = payload.toString("utf8", nulIdx + 5, nulIdx + 5 + len);
              clientFirstBare = clientFirst.replace(/^n,,/, "");
              const nonceMatch = clientFirstBare.match(/r=([^,]+)/);
              const cNonce = nonceMatch?.[1] ?? "nonce";
              serverFirstMsg = `r=${cNonce}srv987,s=${salt.toString("base64")},i=${behavior.scramIterations}`;
              const scramContinue = Buffer.concat([
                Buffer.from([0, 0, 0, 11]),
                Buffer.from(serverFirstMsg, "utf8"),
              ]);
              stream.write(encodeMsg("R", scramContinue));
              return;
            }
            // SASLResponse: c=...,r=...,p=...
            const clientFinal = payload.toString("utf8");
            const withoutProof = clientFinal.replace(/,p=[^,]+$/, "");
            const authMessage = `${clientFirstBare},${serverFirstMsg},${withoutProof}`;
            const salted = pbkdf2Sync(testPassword, salt, behavior.scramIterations, 32, "sha256");
            const serverKey = createHmac("sha256", salted).update("Server Key").digest();
            const serverSig = createHmac("sha256", serverKey).update(authMessage).digest();
            const saslFinal = Buffer.concat([
              Buffer.from([0, 0, 0, 12]),
              Buffer.from(`v=${serverSig.toString("base64")}`, "utf8"),
            ]);
            const authOk = Buffer.alloc(4);
            authOk.writeInt32BE(0, 0);
            stream.write(
              Buffer.concat([
                encodeMsg("R", saslFinal),
                encodeMsg("R", authOk),
                encodeMsg("Z", Buffer.from("I")),
              ])
            );
            return;
          }
          if (type === "Q") {
            const respond = () => sendRowSelect1();
            if (behavior.stallQueryMs > 0) {
              setTimeout(respond, behavior.stallQueryMs).unref();
            } else {
              respond();
            }
            return;
          }
          if (type === "P") {
            // Queue response after Sync arrives
            return;
          }
          if (type === "S") {
            if (behavior.stallQueryMs > 0) {
              setTimeout(sendRowSelect1, behavior.stallQueryMs).unref();
            } else {
              sendRowSelect1();
            }
          }
        };

        stream.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (!started) {
            if (buf.length < 8) return;
            const len = buf.readInt32BE(0);
            if (buf.length < len) return;
            buf = buf.subarray(len);
            started = true;
            if (behavior.authMode === "cleartext") {
              const body = Buffer.alloc(4);
              body.writeInt32BE(3, 0);
              stream.write(encodeMsg("R", body));
            } else if (behavior.authMode === "md5") {
              const body = Buffer.alloc(8);
              body.writeInt32BE(5, 0);
              Buffer.from([1, 2, 3, 4]).copy(body, 4);
              stream.write(encodeMsg("R", body));
            } else {
              const saslBody = Buffer.concat([
                Buffer.from([0, 0, 0, 10]),
                Buffer.from("SCRAM-SHA-256\0\0", "utf8"),
              ]);
              stream.write(encodeMsg("R", saslBody));
            }
          }
          while (started && buf.length >= 5) {
            const msgType = String.fromCharCode(buf.readUInt8(0));
            const msgLen = buf.readInt32BE(1);
            if (buf.length < 1 + msgLen) break;
            const payload = buf.subarray(5, 1 + msgLen);
            buf = buf.subarray(1 + msgLen);
            handlePacket(msgType, payload);
          }
        });
      };

      server = net.createServer((rawSocket) => {
        openSockets.add(rawSocket);
        rawSocket.on("close", () => openSockets.delete(rawSocket));
        let preBuf = Buffer.alloc(0);
        const onPreData = (chunk: Buffer) => {
          preBuf = Buffer.concat([preBuf, chunk]);
          if (preBuf.length < 8) return;
          const pktLen = preBuf.readInt32BE(0);
          const code = preBuf.readInt32BE(4);
          if (pktLen === 8 && code === 80877103) {
            preBuf = preBuf.subarray(8);
            rawSocket.off("data", onPreData);
            if (behavior.sslMode === "reject") {
              rawSocket.write(Buffer.from("N"));
              startWireSession(rawSocket);
              return;
            }
            behavior.tlsConnectionsAccepted += 1;
            rawSocket.write(Buffer.from("S"));
            const tlsSock = new tls.TLSSocket(rawSocket, {
              isServer: true,
              key: serverKeyPem,
              cert: serverCertPem,
            });
            openSockets.add(tlsSock);
            tlsSock.on("close", () => openSockets.delete(tlsSock));
            tlsSock.on("error", () => {
              // expected on untrusted client cert rejection tests
            });
            startWireSession(tlsSock);
            return;
          }
          // Plain startup without SSLRequest (e.g. sslMode="disable")
          rawSocket.off("data", onPreData);
          startWireSession(rawSocket);
          rawSocket.emit("data", preBuf);
        };
        rawSocket.on("data", onPreData);
      });

      await new Promise<void>((res, rej) => {
        server!.once("error", rej);
        server!.listen(0, "127.0.0.1", () => res());
      });
      const srvAddr = server.address();
      assert.ok(srvAddr && typeof srvAddr === "object");
      const mockPort = srvAddr.port;

      // 1. Remote sslMode="disable" rejected fail-closed
      const remoteDisableCfg = buildPostgresPoolConfigFromEnv({
        DATABASE_URL: "postgresql://db.example.com:5432/factory?sslmode=disable",
      });
      assert.ok(remoteDisableCfg);
      const remotePool = new PostgresRuntimePool(remoteDisableCfg);
      await assert.rejects(
        () => remotePool.queryInActiveTx("SELECT 1;"),
        (err: unknown) => err instanceof Error && /Refusing insecure sslmode=disable/i.test(err.message)
      );
      await remotePool.close();

      // 2. Real TLS SSLRequest -> 'S' + verify-full with CA cert succeeds and closes with 'X'
      const tlsPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "verify-full",
        sslServername: "localhost",
        sslRootCertPath: certPath,
      });
      const tlsRow = await tlsPool.queryInActiveTx<{ ok: number }>("SELECT $1::int AS ok;", [1]);
      assert.equal(tlsRow.rows[0]?.ok, 1);
      assert.equal(behavior.tlsConnectionsAccepted, 1);
      await tlsPool.close();
      for (let i = 0; i < 40 && behavior.receivedTerminateCount === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(behavior.receivedTerminateCount, 1);

      // 3. verify-full without trusting self-signed CA rejects TLS certificate
      const untrustedPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "verify-full",
        sslServername: "localhost",
      });
      await assert.rejects(() => untrustedPool.queryInActiveTx("SELECT 1;"));
      await untrustedPool.close();

      // 4. sslMode="verify-full" rejects mismatched hostname even when CA matches
      const wrongHostPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "verify-full",
        sslServername: "wrong.example.com",
        sslCaPem: serverCertPem,
      });
      await assert.rejects(() => wrongHostPool.queryInActiveTx("SELECT 1;"));
      await wrongHostPool.close();

      // 5. Server returns 'N': require fails closed, prefer falls back cleanly
      behavior.sslMode = "reject";
      const requirePool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "require",
      });
      await assert.rejects(
        () => requirePool.queryInActiveTx("SELECT 1;"),
        (err: unknown) => err instanceof Error && /refused TLS/i.test(err.message)
      );
      await requirePool.close();

      const preferPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "prefer",
      });
      const preferRes = await preferPool.queryInActiveTx<{ ok: number }>("SELECT $1::int AS ok;", [1]);
      assert.equal(preferRes.rows[0]?.ok, 1);
      await preferPool.close();

      // 6. Reject cleartext & MD5 auth by default; allow cleartext only with explicit opt-in
      behavior.sslMode = "accept";
      behavior.authMode = "md5";
      const md5RejectedPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "verify-ca",
        sslCaPem: serverCertPem,
      });
      await assert.rejects(
        () => md5RejectedPool.queryInActiveTx("SELECT 1;"),
        (err: unknown) => err instanceof Error && /legacy MD5 authentication.*rejected by default/i.test(err.message)
      );
      await md5RejectedPool.close();

      behavior.authMode = "cleartext";
      const clearRejectedPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "verify-ca",
        sslCaPem: serverCertPem,
      });
      await assert.rejects(
        () => clearRejectedPool.queryInActiveTx("SELECT 1;"),
        (err: unknown) => err instanceof Error && /cleartext password authentication.*rejected by default/i.test(err.message)
      );
      await clearRejectedPool.close();

      const clearOptInPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "verify-ca",
        sslCaPem: serverCertPem,
        allowInsecureCleartextAuth: true,
      });
      const clearRes = await clearOptInPool.queryInActiveTx<{ ok: number }>("SELECT $1::int AS ok;", [1]);
      assert.equal(clearRes.rows[0]?.ok, 1);
      await clearOptInPool.close();

      // 7. Wire caps & timeouts (M5-FIX-19)
      behavior.authMode = "scram";
      behavior.scramIterations = 50_000;
      const scramCapPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "verify-ca",
        sslCaPem: serverCertPem,
        maxScramIterations: 4096,
      });
      await assert.rejects(
        () => scramCapPool.queryInActiveTx("SELECT 1;"),
        (err: unknown) => err instanceof Error && /outside allowed bounds/i.test(err.message)
      );
      await scramCapPool.close();
      behavior.scramIterations = 4096;

      behavior.stallQueryMs = 300;
      const qTimeoutPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "verify-ca",
        sslCaPem: serverCertPem,
        queryTimeoutMs: 60,
      });
      await assert.rejects(
        () => qTimeoutPool.queryInActiveTx("SELECT $1::int AS ok;", [1]),
        (err: unknown) => err instanceof Error && /timed out/i.test(err.message)
      );
      await qTimeoutPool.close();
      behavior.stallQueryMs = 0;

      // Acquire timeout when single pool connection is held
      const acquireTimeoutPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "verify-ca",
        sslCaPem: serverCertPem,
        maxConnections: 1,
        acquireTimeoutMs: 60,
      });
      await acquireTimeoutPool.withRlsTransaction({ currentRole: "anonymous" }, async () => {
        await assert.rejects(
          () =>
            acquireTimeoutPool.withRlsTransaction({ currentRole: "core_api_service" }, () =>
              Promise.resolve(1)
            ),
          (err: unknown) => err instanceof Error && /acquire timeout/i.test(err.message)
        );
      });
      await acquireTimeoutPool.close();

      // Receive buffer overflow limit
      behavior.sendOversizedFrame = true;
      const bufCapPool = new PostgresRuntimePool({
        host: "127.0.0.1",
        port: mockPort,
        database: "factory",
        user: "app_user",
        password: testPassword,
        sslMode: "verify-ca",
        sslCaPem: serverCertPem,
        maxRecvBufferBytes: 4096,
      });
      await assert.rejects(
        () => bufCapPool.queryInActiveTx("SELECT $1::int AS ok;", [1]),
        (err: unknown) =>
          err instanceof Error && /(exceeded maxRecvBufferBytes|outside allowed range)/i.test(err.message)
      );
      await bufCapPool.close();
    } finally {
      for (const sock of openSockets) {
        sock.destroy();
      }
      if (server) {
        await new Promise<void>((r) => server!.close(() => r()));
      }
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  it("M5-Gate-6 (M5-FIX-06, M5-FIX-07, M5-FIX-13, M5-FIX-14): Hardens HTTP /verify, blocks fault injection by default, binds pre-receive inspection to disk Git, and rejects stale current_main_commit_hash", async () => {
    // 1. Default CoreApiHttpServer blocks unsafe /verify overrides and simulateCrashAfterGitUpdateRef
    const fx = await createM5LiveStackFixture();
    try {
      const flow = await runFullWorkflowToApproval(fx, "M5-Gate-6 Security Hardening");
      const task = await fx.coreClient.createTask(fx.projectId, fx.authOp, {
        title: "M5-FIX-06 Subprocess & Allowlist Check",
        task_contract: fx.contract,
      });
      const lease = await fx.coreClient.dispatchTaskLease(fx.projectId, fx.authOp, task.task_id, {
        worker_id: "w-fix06",
      });
      const workerRes = await runWorkerDaemonOverHttp({ fx, task, lease, workerId: "w-fix06" });
      assert.equal(workerRes.outcome, "COMPLETED");
      const built = await fx.coreClient.buildCandidate(fx.projectId, fx.authOp, task.task_id, {
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: workerRes.stagingRef,
        agent_commit_hash: workerRes.pushedCommitHash!,
        repo_path: fx.bareRepoDir,
      });
      assert.equal(built.ok, true);
      if (!built.ok) throw new Error("Expected buildCandidate success");

      const cmds = buildVerifierCommands(false);
      const unsafePayloads: Array<Record<string, unknown>> = [
        { execution_mode: "subprocess", ...cmds },
        { execution_mode: "sandbox", ...cmds },
        { execution_mode: "auto", require_docker: false, ...cmds },
        { execution_mode: "auto", network_disabled: false, ...cmds },
        { execution_mode: "auto", docker_image: "ubuntu:latest", ...cmds },
        { execution_mode: "auto", extra_env: { EVIL_VAR: "1" }, ...cmds },
        {
          execution_mode: "auto",
          tier1_command: { command: "/bin/sh", args: ["-c", "echo pwned"] },
          tier2_command: cmds.tier2_command,
          tier3_command: cmds.tier3_command,
        },
      ];
      for (const payload of unsafePayloads) {
        for (const callerAuth of [fx.authOp, fx.authAdmin]) {
          const verInput = {
            merge_candidate_id: built.mergeCandidate.merge_candidate_id,
            trusted_acceptance_dir: fx.trustedAcceptanceDir,
            repo_path: fx.bareRepoDir,
            ...payload,
          } as unknown as Parameters<HttpCoreApiClient["verifyCandidate"]>[3];
          await assert.rejects(
            () => fx.coreClient.verifyCandidate(fx.projectId, callerAuth, task.task_id, verInput),
            (err: unknown) =>
              err instanceof HttpCoreApiError &&
              err.statusCode === 403 &&
              err.body.error_code === "ERR_FORBIDDEN_RLS"
          );
        }
      }

      // M5-FIX-07: Default CoreApiHttpServer blocks simulateCrashAfterGitUpdateRef on /cas-merge
      const approval = await fx.coreClient.submitApproval(
        fx.projectId,
        fx.authApprover,
        flow.task.task_id,
        {
          merge_candidate_id: flow.built.mergeCandidate.merge_candidate_id,
          approval_request_id: flow.reviewed.approvalRequest?.approval_request_id,
          agent_commit_hash: flow.built.mergeCandidate.agent_commit_hash,
          base_main_commit_hash: flow.built.mergeCandidate.base_main_commit_hash,
          verified_tree_hash: flow.built.mergeCandidate.verified_tree_hash,
          merge_candidate_hash: flow.built.mergeCandidate.merge_candidate_hash,
          verification_run_id: flow.verified.finalRun.verification_run_id,
          review_artifact_id: flow.reviewed.reviewArtifact.review_artifact_id,
          decision: "APPROVED",
          repo_path: fx.bareRepoDir,
        }
      );
      await assert.rejects(
        () =>
          fx.coreClient.executeCasMerge(fx.projectId, fx.authOp, flow.task.task_id, {
            merge_candidate_id: flow.built.mergeCandidate.merge_candidate_id,
            approval_id: approval.approval_id,
            repo_path: fx.bareRepoDir,
            simulateCrashAfterGitUpdateRef: true,
          }),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 403 &&
          err.body.error_code === "ERR_FORBIDDEN_RLS"
      );

      // M5-FIX-13: Tampered pre-receive metadata vs real bare repo on disk -> 403 ERR_GATEKEEPER_TAMPERED_IMPORT
      const preTok = fx.tokenService.issueLeasePushToken({
        projectId: fx.projectId,
        taskId: task.task_id,
        leaseId: lease.lease_id,
        leaseEpoch: lease.lease_epoch,
        workerId: "w-fix06",
      });
      const spoofTreeRes = await fetch(`${fx.gatewayBaseUrl}/internal/v1/git/pre-receive-verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${preTok}`,
        },
        body: JSON.stringify({
          old_sha: "0".repeat(40),
          new_sha: workerRes.pushedCommitHash,
          ref_name: workerRes.stagingRef,
          repo_path: fx.bareRepoDir,
          verified_tree_hash: "f".repeat(40),
        }),
      });
      assert.equal(spoofTreeRes.status, 403);
      const spoofTreeBody = (await spoofTreeRes.json()) as { error_code: string };
      assert.equal(spoofTreeBody.error_code, "ERR_GATEKEEPER_TAMPERED_IMPORT");

      const spoofRepoRes = await fetch(`${fx.gatewayBaseUrl}/internal/v1/git/pre-receive-verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${preTok}`,
        },
        body: JSON.stringify({
          old_sha: "0".repeat(40),
          new_sha: workerRes.pushedCommitHash,
          ref_name: workerRes.stagingRef,
          repo_path: join(fx.rootDir, "rogue-repo.git"),
        }),
      });
      assert.equal(spoofRepoRes.status, 403);
      const spoofRepoBody = (await spoofRepoRes.json()) as { error_code: string };
      assert.equal(spoofRepoBody.error_code, "ERR_GATEKEEPER_TAMPERED_IMPORT");

      // M5-FIX-13 (synthetic non-disk repo): Reject missing verified_tree_hash and reject verified_tree_hash === new_sha
      const synProject = await fx.store.withRlsTransaction(
        {
          currentRole: "system_admin_role",
          currentPrincipalId: "bootstrap-admin",
        },
        () => {
          const p = fx.store.createProject({
            slug: `m5-syn-pre-${randomUUID().slice(0, 6)}`,
            name: "Synthetic Non-Disk Project",
            repo_bare_path: join(fx.rootDir, "nonexistent-bare.git"),
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
            approval_ttl_seconds: 120,
          });
          fx.store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "operator-alice",
            member_role: "DEVELOPER",
          });
          return p;
        }
      );
      const synAuthOp = fx.coreApi.issueAuthContext({
        projectId: synProject.project_id,
        principalId: "operator-alice",
        roles: ["DEVELOPER"],
      });
      const synTask = await fx.coreClient.createTask(synProject.project_id, synAuthOp, {
        title: "Synthetic Pre-Receive Non-Disk Task",
        task_contract: fx.contract,
      });
      const synLease = await fx.coreClient.dispatchTaskLease(synProject.project_id, synAuthOp, synTask.task_id, {
        worker_id: "w-syn-pre",
      });
      const synPreTok = fx.tokenService.issueLeasePushToken({
        projectId: synProject.project_id,
        taskId: synTask.task_id,
        leaseId: synLease.lease_id,
        leaseEpoch: synLease.lease_epoch,
        workerId: "w-syn-pre",
      });
      const missingTreeRes = await fetch(`${fx.gatewayBaseUrl}/internal/v1/git/pre-receive-verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${synPreTok}`,
        },
        body: JSON.stringify({
          old_sha: "0".repeat(40),
          new_sha: "a".repeat(40),
          ref_name: `refs/heads/sf/staging/${synTask.task_id}/${synLease.lease_epoch}`,
        }),
      });
      assert.equal(missingTreeRes.status, 403);
      assert.equal(
        ((await missingTreeRes.json()) as { error_code: string }).error_code,
        "ERR_GATEKEEPER_MISSING_INSPECTION_METADATA"
      );

      const equalTreeRes = await fetch(`${fx.gatewayBaseUrl}/internal/v1/git/pre-receive-verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${synPreTok}`,
        },
        body: JSON.stringify({
          old_sha: "0".repeat(40),
          new_sha: "a".repeat(40),
          ref_name: `refs/heads/sf/staging/${synTask.task_id}/${synLease.lease_epoch}`,
          verified_tree_hash: "a".repeat(40),
          parent_commit_hashes: ["1".repeat(40)],
          changes: [
            {
              path: "src/calculator.mjs",
              mode: "100644",
              size_bytes: 12,
              is_binary: false,
              added_lines: 1,
              deleted_lines: 0,
              blob_sha: "b".repeat(40),
            },
          ],
        }),
      });
      assert.equal(equalTreeRes.status, 403);
      assert.equal(
        ((await equalTreeRes.json()) as { error_code: string }).error_code,
        "ERR_GATEKEEPER_TAMPERED_IMPORT"
      );

      // M5-FIX-14: submitHumanApproval rejects stale caller current_main_commit_hash against moved disk Git HEAD
      const flowStale = await runFullWorkflowToApproval(fx, "M5-FIX-14 Disk HEAD Check");
      advanceBareMainExternalCommit({
        rootDir: fx.rootDir,
        bareRepoDir: fx.bareRepoDir,
        relativePath: "docs/ext-move.md",
        content: "# Moved Main\n",
        message: "docs: move main externally",
      });
      await assert.rejects(
        () =>
          fx.coreClient.submitApproval(
            fx.projectId,
            fx.authApprover,
            flowStale.task.task_id,
            {
              merge_candidate_id: flowStale.built.mergeCandidate.merge_candidate_id,
              approval_request_id: flowStale.reviewed.approvalRequest?.approval_request_id,
              agent_commit_hash: flowStale.built.mergeCandidate.agent_commit_hash,
              base_main_commit_hash: flowStale.built.mergeCandidate.base_main_commit_hash,
              verified_tree_hash: flowStale.built.mergeCandidate.verified_tree_hash,
              merge_candidate_hash: flowStale.built.mergeCandidate.merge_candidate_hash,
              verification_run_id: flowStale.verified.finalRun.verification_run_id,
              review_artifact_id: flowStale.reviewed.reviewArtifact.review_artifact_id,
              decision: "APPROVED",
              repo_path: fx.bareRepoDir,
              current_main_commit_hash: fx.initialMainSha,
            }
          ),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 422 &&
          err.body.sqlState === "23514"
      );
    } finally {
      await fx.closeAndCleanup();
    }

    // 2. When verifyPolicy.allowAdminVerifyOverrides === true, ORG_ADMIN succeeds while DEVELOPER is still blocked
    const fxAdmin = await createM5LiveStackFixture({
      verifyPolicy: { allowAdminVerifyOverrides: true },
    });
    try {
      const task = await fxAdmin.coreClient.createTask(fxAdmin.projectId, fxAdmin.authOp, {
        title: "M5-FIX-06 Admin Override Check",
        task_contract: fxAdmin.contract,
      });
      const lease = await fxAdmin.coreClient.dispatchTaskLease(fxAdmin.projectId, fxAdmin.authOp, task.task_id, {
        worker_id: "w-fix06-admin",
      });
      const workerRes = await runWorkerDaemonOverHttp({
        fx: fxAdmin,
        task,
        lease,
        workerId: "w-fix06-admin",
      });
      assert.equal(workerRes.outcome, "COMPLETED");
      const built = await fxAdmin.coreClient.buildCandidate(fxAdmin.projectId, fxAdmin.authOp, task.task_id, {
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: workerRes.stagingRef,
        agent_commit_hash: workerRes.pushedCommitHash!,
        repo_path: fxAdmin.bareRepoDir,
      });
      assert.equal(built.ok, true);
      if (!built.ok) throw new Error("Expected buildCandidate success");
      const cmds = buildVerifierCommands(false);
      await assert.rejects(
        () =>
          fxAdmin.coreClient.verifyCandidate(fxAdmin.projectId, fxAdmin.authOp, task.task_id, {
            merge_candidate_id: built.mergeCandidate.merge_candidate_id,
            trusted_acceptance_dir: fxAdmin.trustedAcceptanceDir,
            repo_path: fxAdmin.bareRepoDir,
            execution_mode: "subprocess",
            ...cmds,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );
      const adminVer = await fxAdmin.coreClient.verifyCandidate(
        fxAdmin.projectId,
        fxAdmin.authAdmin,
        task.task_id,
        {
          merge_candidate_id: built.mergeCandidate.merge_candidate_id,
          trusted_acceptance_dir: fxAdmin.trustedAcceptanceDir,
          repo_path: fxAdmin.bareRepoDir,
          execution_mode: "subprocess",
          ...cmds,
        }
      );
      assert.equal(adminVer.finalRun.verdict, "PASS");
    } finally {
      await fxAdmin.closeAndCleanup();
    }
  });

  it("M5-Gate-7 (M5-FIX-08, M5-FIX-09, M5-FIX-10, M5-FIX-17): Enforces WNA task.failed flush on execution errors, blocks policy/empty edits in adapter & applyWorkspaceEditsSync, and enforces https:// + array model content", async () => {
    // 1. M5-FIX-17: Enforce https:// on non-loopback baseUrl while allowing loopback http:// and explicit opt-in
    assert.throws(
      () =>
        new LiveModelProviderClient({
          provider: "openai",
          model: "gpt-4.1",
          apiKey: "sk-test-token",
          baseUrl: "http://api.openai.com",
        }),
      (err: unknown) => err instanceof ModelProviderConfigurationError
    );
    assert.throws(
      () =>
        new LiveModelProviderClient({
          provider: "anthropic",
          model: "claude-sonnet-4",
          apiKey: "ant-test-token",
          baseUrl: "http://10.0.0.5:8080",
        }),
      (err: unknown) => err instanceof ModelProviderConfigurationError
    );
    assert.throws(
      () =>
        new LiveModelProviderClient({
          provider: "openai",
          model: "gpt-4.1",
          apiKey: "sk-test-token",
          baseUrl: "https://evil.example.com",
          allowedHosts: ["api.openai.com"],
        }),
      (err: unknown) => err instanceof ModelProviderConfigurationError
    );
    assert.doesNotThrow(
      () =>
        new LiveModelProviderClient({
          provider: "openai",
          model: "gpt-4.1",
          apiKey: "sk-test-token",
          baseUrl: "https://api.openai.com",
          allowedHosts: ["api.openai.com"],
        })
    );
    assert.doesNotThrow(
      () =>
        new LiveModelProviderClient({
          provider: "openai",
          model: "gpt-4.1",
          apiKey: "sk-test-token",
          baseUrl: "http://10.0.0.5:8080",
          allowInsecureHttpBaseUrl: true,
        })
    );

    // 2. M5-FIX-10: OpenAI array content (tool-only array fails closed without throwing; multi-part text works)
    let openaiResponseBody: Record<string, unknown> = {
      choices: [{ message: { content: [{ type: "tool_call", id: "call_1" }] } }],
    };
    const mockOpenAi = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openaiResponseBody));
    });
    await new Promise<void>((r) => mockOpenAi.listen(0, "127.0.0.1", () => r()));
    const addr = mockOpenAi.address();
    assert.ok(addr && typeof addr === "object");

    const fx = await createM5LiveStackFixture();
    try {
      const openaiClient = new LiveModelProviderClient({
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "openai-array-test-key",
        baseUrl: `http://127.0.0.1:${addr.port}`,
      });

      const toolOnlyReview = await evaluateIndependentReviewWithLiveModel(openaiClient, {
        taskContract: fx.contract,
        diffText: "+export const y = 2;",
        changedFiles: ["src/calculator.mjs"],
        verificationRunSummary: {
          verification_run_id: randomUUID(),
          verdict: "PASS",
          overall_status: "PASS",
          tier1_trusted_acceptance_passed: true,
          tier2_protected_baseline_passed: true,
          tier3_agent_tests_passed: true,
        },
      });
      assert.equal(toolOnlyReview.verdict, "FAIL");

      openaiResponseBody = {
        choices: [
          {
            message: {
              content: [
                { type: "text", text: '{"verdict":"PASS","summaryMarkdown":"Multipart array ok",' },
                { type: "output_text", text: '"findings":[]}' },
              ],
            },
          },
        ],
      };
      const multipartReview = await evaluateIndependentReviewWithLiveModel(openaiClient, {
        taskContract: fx.contract,
        diffText: "+export const y = 2;",
        changedFiles: ["src/calculator.mjs"],
        verificationRunSummary: {
          verification_run_id: randomUUID(),
          verdict: "PASS",
          overall_status: "PASS",
          tier1_trusted_acceptance_passed: true,
          tier2_protected_baseline_passed: true,
          tier3_agent_tests_passed: true,
        },
      });
      assert.equal(multipartReview.verdict, "PASS");

      // M5-FIX-09: applyWorkspaceEditsSync rejects empty edits and forbidden paths fail-closed
      assert.throws(
        () => applyWorkspaceEditsSync(fx.mainWorkDir, [], "empty commit", fx.contract),
        /non-empty array/i
      );
      assert.throws(
        () =>
          applyWorkspaceEditsSync(
            fx.mainWorkDir,
            [{ path: ".env", content: "SECRET=leaked\n" }],
            "forbidden commit",
            fx.contract
          ),
        /rejected by TaskContract/i
      );

      // M5-FIX-09 + M5-FIX-08: Adapter rejects forbidden path (.env), empty [], and malformed JSON,
      // and WnaWorkerDaemon cleanly transitions task -> ReworkRequired and revokes lease via task.failed!
      const badPayloads: Array<unknown> = [
        [],
        [{ path: ".env", content: "LEAK=1\n" }],
        [{ path: ".github/workflows/ci.yml", content: "name: pwn\n" }],
        [{ path: "outside/hack.mjs", content: "export const a = 1;\n" }],
        [{ path: "../escape.mjs", content: "export const b = 1;\n" }],
        [
          { path: "src/CaseFile.mjs", content: "export const a = 1;\n" },
          { path: "src/casefile.mjs", content: "export const b = 2;\n" },
        ],
      ];

      for (const badEdits of badPayloads) {
        openaiResponseBody = {
          choices: [{ message: { content: JSON.stringify(badEdits) } }],
        };
        const tBad = await fx.coreClient.createTask(fx.projectId, fx.authOp, {
          title: "M5-FIX-08/09 Bad Model Edits",
          task_contract: fx.contract,
        });
        const lBad = await fx.coreClient.dispatchTaskLease(fx.projectId, fx.authOp, tBad.task_id, {
          worker_id: "w-bad-edits",
        });
        const wt = fx.tokenService.issueLeasePushToken({
          projectId: fx.projectId,
          taskId: tBad.task_id,
          leaseId: lBad.lease_id,
          leaseEpoch: lBad.lease_epoch,
          workerId: "w-bad-edits",
        });
        const pt = fx.tokenService.issueLeasePushToken({
          projectId: fx.projectId,
          taskId: tBad.task_id,
          leaseId: lBad.lease_id,
          leaseEpoch: lBad.lease_epoch,
          workerId: "w-bad-edits",
        });
        const daemon = new WnaWorkerDaemon({
          gateway: new HttpAgentGatewayClient({ baseUrl: fx.gatewayBaseUrl, bearerToken: wt }),
          worktreeBaseDir: fx.worktreeBaseDir,
          outboxDir: fx.outboxDir,
        });
        const badRes = await daemon.executeLease({
          task: tBad,
          lease: lBad,
          repoBarePath: fx.bareRepoDir,
          gitPushToken: pt,
          preReceiveUrl: fx.preReceiveUrl,
          adapter: new WorkspaceCodingAgentAdapter({ modelClient: openaiClient }),
          stagingRefKind: "staging",
          isolateNamespaces: false,
          dropPrivileges: false,
        });
        assert.equal(badRes.outcome, "FAILED");
        assert.ok(badRes.error);

        const taskAfter = await fx.coreClient.getTask(fx.projectId, fx.authOp, tBad.task_id);
        assert.equal(taskAfter.status, "ReworkRequired");
        const lineageAfter = await fx.coreClient.getCandidateLineage(
          fx.projectId,
          fx.authOp,
          tBad.task_id
        );
        assert.equal(lineageAfter.taskLeases[0]?.status, "REVOKED");
      }

      // M5-FIX-08: Pre-receive push failure flushes task.failed and reaps sandbox instead of stranding lease
      const tPushFail = await fx.coreClient.createTask(fx.projectId, fx.authOp, {
        title: "M5-FIX-08 Push Failure Flush",
        task_contract: fx.contract,
      });
      const lPushFail = await fx.coreClient.dispatchTaskLease(fx.projectId, fx.authOp, tPushFail.task_id, {
        worker_id: "w-push-fail",
      });
      const wtPush = fx.tokenService.issueLeasePushToken({
        projectId: fx.projectId,
        taskId: tPushFail.task_id,
        leaseId: lPushFail.lease_id,
        leaseEpoch: lPushFail.lease_epoch,
        workerId: "w-push-fail",
      });
      const daemonPushFail = new WnaWorkerDaemon({
        gateway: new HttpAgentGatewayClient({ baseUrl: fx.gatewayBaseUrl, bearerToken: wtPush }),
        worktreeBaseDir: fx.worktreeBaseDir,
        outboxDir: fx.outboxDir,
      });
      const prevDeadline = fx.gatewayHttp.deadlineMs;
      const prevHook = fx.gatewayHttp.authorizeCheckHook;
      fx.gatewayHttp.deadlineMs = 15;
      fx.gatewayHttp.authorizeCheckHook = async () => {
        await new Promise((r) => setTimeout(r, 80));
      };
      try {
        const pushFailRes = await daemonPushFail.executeLease({
          task: tPushFail,
          lease: lPushFail,
          repoBarePath: fx.bareRepoDir,
          gitPushToken: wtPush,
          preReceiveUrl: fx.preReceiveUrl,
          adapter: new WorkspaceCodingAgentAdapter({
            editsResolver: () => [
              { path: "src/calculator.mjs", content: VALID_CALCULATOR_SUBTRACT_SOURCE },
            ],
          }),
          stagingRefKind: "staging",
          isolateNamespaces: false,
          dropPrivileges: false,
        });
        assert.equal(pushFailRes.outcome, "FAILED");
        assert.ok(pushFailRes.cleanupEvidence);
      } finally {
        fx.gatewayHttp.deadlineMs = prevDeadline;
        fx.gatewayHttp.authorizeCheckHook = prevHook;
      }
      const taskPushAfter = await fx.coreClient.getTask(fx.projectId, fx.authOp, tPushFail.task_id);
      assert.equal(taskPushAfter.status, "ReworkRequired");
      const lineagePushAfter = await fx.coreClient.getCandidateLineage(
        fx.projectId,
        fx.authOp,
        tPushFail.task_id
      );
      assert.equal(lineagePushAfter.taskLeases[0]?.status, "REVOKED");
    } finally {
      await new Promise<void>((r) => mockOpenAi.close(() => r()));
      await fx.closeAndCleanup();
    }
  });

  it("M5-Gate-8 (M5-FIX-04, M5-FIX-11, M5-FIX-15, M5-FIX-16, cd84dc7#3): Enforces runtime bootstrap config, lineage verdict checks, unified metrics, project-scoped hash & strict reviewer session UUID", async () => {
    // 1. M5-FIX-11: createControlPlaneStoreFromEnv + production stack bootstrap fallbacks & fail-closed requirePostgres
    assert.throws(
      () => createControlPlaneStoreFromEnv({ env: {}, requirePostgres: true }),
      /PostgreSQL runtime is required/i
    );
    const memHandle = createControlPlaneStoreFromEnv({ env: {} });
    assert.equal(memHandle.mode, "memory");
    assert.equal(memHandle.pool, null);
    await memHandle.close();

    const coreRt = await createCoreApiRuntime({ env: {} });
    const gwRt = await createAgentGatewayRuntime({ env: {} });
    const stackRt = await createControlPlaneStackRuntime({ env: {} });
    try {
      assert.equal(coreRt.mode, "memory");
      assert.equal(gwRt.mode, "memory");
      assert.equal(stackRt.mode, "memory");
      const coreHealth = await fetch(`${coreRt.coreApiEndpoint!.baseUrl}/health`);
      assert.equal(coreHealth.status, 200);
      const gwHealth = await fetch(`${gwRt.endpoint!.baseUrl}/health`);
      assert.equal(gwHealth.status, 200);
      const webHealth = await fetch(`${stackRt.webEndpoint!.baseUrl}/health`);
      assert.equal(webHealth.status, 200);
    } finally {
      await Promise.all([stackRt.close(), gwRt.close(), coreRt.close()]);
    }

    // 2. M5-FIX-16 + M5-FIX-15 in SoftwareFactoryControlPlaneStore
    const memStore = new SoftwareFactoryControlPlaneStore();
    const { pA, pB, tA, lA } = await memStore.withRlsTransaction(
      { currentRole: "system_admin_role", currentPrincipalId: "admin" },
      async () => {
        const projA = memStore.createProject({
          slug: "fix16-a",
          name: "Project A",
          repo_bare_path: "/tmp/a.git",
          initial_main_commit_hash: "1".repeat(40),
          initial_main_tree_hash: "2".repeat(40),
        });
        const projB = memStore.createProject({
          slug: "fix16-b",
          name: "Project B",
          repo_bare_path: "/tmp/b.git",
          initial_main_commit_hash: "3".repeat(40),
          initial_main_tree_hash: "4".repeat(40),
        });
        memStore.addProjectMembership({
          project_id: projA.project_id,
          principal_id: "op-a",
          member_role: "DEVELOPER",
        });
        return memStore.withRlsTransaction(
          {
            currentProjectId: projA.project_id,
            currentPrincipalId: "op-a",
            currentRole: "core_api_service",
          },
          async () => {
            const t = memStore.createTask({
              project_id: projA.project_id,
              title: "Metric Default Task",
              task_contract: { allowed_files: ["src/**"] },
            });
            const l = await memStore.grantTaskLease({
              project_id: projA.project_id,
              task_id: t.task_id,
              worker_id: "w-m15",
            });
            return { pA: projA, pB: projB, tA: t, lA: l };
          }
        );
      }
    );

    await memStore.withRlsTransaction(
      { currentRole: "system_admin_role", currentPrincipalId: "admin" },
      () => {
        assert.equal(memStore.getMainRefCommitHash(), null);
        assert.equal(memStore.getMainRefCommitHash(pA.project_id), "1".repeat(40));
        assert.equal(memStore.getMainRefCommitHash(pB.project_id), "3".repeat(40));
      }
    );

    await assert.rejects(
      () =>
        memStore.withRlsTransaction(
          {
            currentProjectId: pA.project_id,
            currentPrincipalId: "w-m15",
            currentRole: "gateway_service",
          },
          () =>
            memStore.recordResourceUsageMetric({
              project_id: pA.project_id,
              task_id: tA.task_id,
              lease_id: lA.lease_id,
              lease_epoch: lA.lease_epoch,
              phase: "DEVELOPER",
              wall_time_ms: -1,
              cpu_usage_usec: 10,
              peak_memory_bytes: 10,
              sandbox_backend_mode: "real-process",
              metrics_source: "process-rusage",
            })
        ),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );
    const defaultedMemMetric = await memStore.withRlsTransaction(
      {
        currentProjectId: pA.project_id,
        currentPrincipalId: "w-m15",
        currentRole: "gateway_service",
      },
      () =>
        memStore.recordResourceUsageMetric({
          project_id: pA.project_id,
          task_id: tA.task_id,
          lease_id: lA.lease_id,
          lease_epoch: lA.lease_epoch,
          phase: "DEVELOPER",
          wall_time_ms: 15,
          cpu_usage_usec: 25,
          peak_memory_bytes: 512,
          sandbox_backend_mode: "real-process",
          metrics_source: "process-rusage",
        })
    );
    assert.equal(defaultedMemMetric.attempt_no, lA.attempt_no);
    assert.equal(defaultedMemMetric.rework_cycle, tA.rework_count);

    // 3. M5-FIX-04: buildCandidateBoundLineage rejects FAIL verdict, REJECTED approval, and superseded candidate
    const nowLineageIso = new Date().toISOString();
    const baseProcessedEvent: ProcessedWorkerEventRecord = {
      event_id: "ev-1",
      project_id: pA.project_id,
      task_id: tA.task_id,
      lease_id: lA.lease_id,
      lease_epoch: 1,
      sequence_no: 1,
      event_type: "task.completed",
      event_idempotency_key: "ik-1",
      payload_sha256: "0".repeat(64),
      payload_json: {},
      processed_at: nowLineageIso,
    };
    const baseVerifiedImport = {
      import_id: "imp-1",
      project_id: pA.project_id,
      task_id: tA.task_id,
      lease_id: lA.lease_id,
      lease_epoch: 1,
      agent_commit_hash: "a".repeat(40),
      verified_tree_hash: "b".repeat(40),
      staging_ref: "refs/heads/sf/staging/t/1",
      changed_files_count: 1,
      deleted_lines_count: 0,
      recovered_by_reconciler: false,
      created_at: nowLineageIso,
    };
    const baseMergeCandidate = {
      merge_candidate_id: "mc-1",
      project_id: pA.project_id,
      task_id: tA.task_id,
      import_id: "imp-1",
      agent_commit_hash: "a".repeat(40),
      base_main_commit_hash: "1".repeat(40),
      merge_candidate_hash: "5".repeat(40),
      verified_tree_hash: "b".repeat(40),
      is_superseded: false,
      snapshot_path: null,
      snapshot_sha256: null,
      snapshot_size_bytes: null,
      snapshot_retention_class: "MERGED_PERMANENT" as const,
      created_at: nowLineageIso,
    };
    const baseVerificationRun: VerificationRunRecord = {
      verification_run_id: "vr-1",
      project_id: pA.project_id,
      task_id: tA.task_id,
      merge_candidate_id: "mc-1",
      merge_candidate_hash: "5".repeat(40),
      verified_tree_hash: "b".repeat(40),
      verifier_image_digest: "sha256:x",
      verdict: "PASS",
      overall_status: "PASSED",
      tier1_trusted_acceptance_passed: true,
      tier2_protected_baseline_passed: true,
      tier2_baseline_tamper_detected: false,
      tampered_baseline_paths: [],
      tier3_agent_tests_passed: true,
      tier3_assertions: [],
      exit_code: 0,
      duration_ms: 10,
      execution_backend: "docker",
      hermetic_network_disabled: true,
      hardlink_cache_forbidden: true,
      report_sha256: "c".repeat(64),
      created_at: nowLineageIso,
    };
    const baseReviewSession = {
      review_session_id: "rs-1",
      project_id: pA.project_id,
      task_id: tA.task_id,
      merge_candidate_id: "mc-1",
      verification_run_id: "vr-1",
      reviewer_principal_id: "r",
      reviewer_credential_id: "rc",
      reviewer_agent_profile_id: "rp",
      reviewer_provider: "google",
      reviewer_model: "gemini-2.5-pro",
      role: "ROLE_REVIEWER_READONLY" as const,
      sandbox_backend_mode: "real-process",
      sandbox_pid: null,
      sandbox_cgroup_path: null,
      cleanup_populated_zero_verified: true,
      status: "COMPLETED" as const,
      started_at: nowLineageIso,
      completed_at: nowLineageIso,
    };
    const baseReviewArtifact: ReviewArtifactRecord = {
      review_artifact_id: "ra-1",
      project_id: pA.project_id,
      task_id: tA.task_id,
      merge_candidate_id: "mc-1",
      verification_run_id: "vr-1",
      merge_candidate_hash: "5".repeat(40),
      verified_tree_hash: "b".repeat(40),
      writer_provider: "anthropic",
      writer_model: "claude-sonnet-4",
      reviewer_provider: "google",
      reviewer_model: "gemini-2.5-pro",
      developer_principal_id: "d",
      reviewer_principal_id: "r",
      developer_session_id: "ds",
      reviewer_session_id: "rs",
      developer_credential_id: "dc",
      reviewer_credential_id: "rc",
      developer_agent_profile_id: "dp",
      reviewer_agent_profile_id: "rp",
      review_session_id: "rs-1",
      verdict: "PASS",
      status: "VALID",
      is_invalidated: false,
      invalidated_reason: null,
      findings_json: [],
      created_at: nowLineageIso,
    };
    const baseApprovalRequest = {
      approval_request_id: "ar-1",
      project_id: pA.project_id,
      task_id: tA.task_id,
      merge_candidate_id: "mc-1",
      agent_commit_hash: "a".repeat(40),
      base_main_commit_hash: "1".repeat(40),
      merge_candidate_hash: "5".repeat(40),
      verified_tree_hash: "b".repeat(40),
      verification_run_id: "vr-1",
      review_artifact_id: "ra-1",
      status: "APPROVED" as const,
      expires_at: nowLineageIso,
      created_at: nowLineageIso,
      updated_at: nowLineageIso,
    };
    const baseApprovalDecision: ApprovalDecisionRecord = {
      approval_id: "ad-1",
      project_id: pA.project_id,
      task_id: tA.task_id,
      merge_candidate_id: "mc-1",
      approval_request_id: "ar-1",
      agent_commit_hash: "a".repeat(40),
      base_main_commit_hash: "1".repeat(40),
      verified_tree_hash: "b".repeat(40),
      merge_candidate_hash: "5".repeat(40),
      verification_run_id: "vr-1",
      review_artifact_id: "ra-1",
      approver_principal_id: "approver",
      decision: "APPROVED",
      status: "CONSUMED",
      invalidated_reason: null,
      approved_at: nowLineageIso,
      expires_at: nowLineageIso,
      consumed_at: nowLineageIso,
    };
    const baseMergeOp = {
      merge_op_id: "mo-1",
      project_id: pA.project_id,
      task_id: tA.task_id,
      merge_candidate_id: "mc-1",
      approval_id: "ad-1",
      merge_idempotency_key: "mk-1",
      base_main_commit_hash: "1".repeat(40),
      merge_candidate_hash: "5".repeat(40),
      verified_tree_hash: "b".repeat(40),
      status: "MERGED" as const,
      reconciled_after_lost_response: false,
      retry_count: 0,
      last_error: null,
      created_at: nowLineageIso,
      completed_at: nowLineageIso,
    };
    const validLineageInput = {
      task: {
        ...tA,
        status: "MergedAndCompleted" as const,
        active_merge_candidate_id: "mc-1",
        merged_commit_hash: "5".repeat(40),
      },
      mainHeadCommitHash: "5".repeat(40),
      taskLeases: [lA],
      processedEvents: [baseProcessedEvent],
      resourceUsageMetrics: [defaultedMemMetric],
      imports: [baseVerifiedImport],
      allMergeCandidates: [baseMergeCandidate],
      verificationRuns: [baseVerificationRun],
      reviewSessions: [baseReviewSession],
      reviewArtifacts: [baseReviewArtifact],
      approvalRequests: [baseApprovalRequest],
      approvalDecisions: [baseApprovalDecision],
      mergeOperations: [baseMergeOp],
    };

    const okLineage = buildCandidateBoundLineage(validLineageInput);
    assert.equal(okLineage.hashBindingVerified, true);
    assert.equal(okLineage.lineageComplete, true);
    assert.equal(okLineage.gitLogHeadMatchesCandidate, true);

    const supersededLineage = buildCandidateBoundLineage({
      ...validLineageInput,
      allMergeCandidates: [{ ...baseMergeCandidate, is_superseded: true }],
    });
    assert.equal(supersededLineage.hashBindingVerified, false);
    assert.equal(supersededLineage.lineageComplete, false);
    assert.equal(supersededLineage.gitLogHeadMatchesCandidate, false);

    const failVerLineage = buildCandidateBoundLineage({
      ...validLineageInput,
      verificationRuns: [{ ...baseVerificationRun, verdict: "FAIL", overall_status: "FAILED_ACCEPTANCE" }],
    });
    assert.equal(failVerLineage.hashBindingVerified, false);
    assert.equal(failVerLineage.lineageComplete, false);

    const failRevLineage = buildCandidateBoundLineage({
      ...validLineageInput,
      reviewArtifacts: [{ ...baseReviewArtifact, verdict: "FAIL" }],
    });
    assert.equal(failRevLineage.hashBindingVerified, false);
    assert.equal(failRevLineage.lineageComplete, false);

    const rejectedAppLineage = buildCandidateBoundLineage({
      ...validLineageInput,
      approvalDecisions: [{ ...baseApprovalDecision, decision: "REJECTED" }],
    });
    assert.equal(rejectedAppLineage.hashBindingVerified, false);
    assert.equal(rejectedAppLineage.lineageComplete, false);

    // 4. cd84dc7 minor #3: CoreApiService.runIndependentReview fails closed if reviewerSessionId is not a UUID
    const fxMinor3 = await createM5LiveStackFixture();
    try {
      const task = await fxMinor3.coreClient.createTask(fxMinor3.projectId, fxMinor3.authOp, {
        title: "cd84dc7 Minor #3 Non-UUID Session Check",
        task_contract: fxMinor3.contract,
      });
      const lease = await fxMinor3.coreClient.dispatchTaskLease(fxMinor3.projectId, fxMinor3.authOp, task.task_id, {
        worker_id: "w-minor3",
      });
      const wnaRes = await runWorkerDaemonOverHttp({
        fx: fxMinor3,
        task,
        lease,
        workerId: "w-minor3",
      });
      const built = await fxMinor3.coreClient.buildCandidate(fxMinor3.projectId, fxMinor3.authOp, task.task_id, {
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: wnaRes.stagingRef,
        agent_commit_hash: wnaRes.pushedCommitHash!,
        repo_path: fxMinor3.bareRepoDir,
      });
      assert.equal(built.ok, true);
      if (!built.ok) throw new Error("Expected candidate");
      const cmds = buildVerifierCommands(fxMinor3.useDocker);
      const verified = await fxMinor3.coreClient.verifyCandidate(fxMinor3.projectId, fxMinor3.authOp, task.task_id, {
        merge_candidate_id: built.mergeCandidate.merge_candidate_id,
        trusted_acceptance_dir: fxMinor3.trustedAcceptanceDir,
        repo_path: fxMinor3.bareRepoDir,
        execution_mode: "auto",
        ...cmds,
      });
      await assert.rejects(
        () =>
          fxMinor3.coreApi.runIndependentReview(fxMinor3.projectId, fxMinor3.authOp, {
            task_id: task.task_id,
            merge_candidate_id: built.mergeCandidate.merge_candidate_id,
            verification_run_id: verified.finalRun.verification_run_id,
            reviewer_principal_id: "rev-minor3",
            reviewer_session_id: "non-uuid-session-id",
            reviewer_agent_profile_id: "prof-rev-minor3",
            reviewer_provider: "google",
            reviewer_model: "gemini-2.5-pro",
            developer_principal_id: "dev-minor3",
            developer_session_id: "dev-sess-minor3",
            developer_credential_id: "dev-cred-minor3",
            developer_agent_profile_id: "prof-dev-minor3",
            writer_provider: "anthropic",
            writer_model: "claude-sonnet-4",
            agent_gateway: fxMinor3.gatewayService,
            repo_path: fxMinor3.bareRepoDir,
            tier3_test_files: cmds.tier3_test_files,
          }),
        (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
      );
    } finally {
      await fxMinor3.closeAndCleanup();
    }
  });
});
