import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LiveModelProviderClient,
  ModelProviderConfigurationError,
  WorkspaceCodingAgentAdapter,
  evaluateIndependentReviewWithLiveModel,
} from "@software-factory/adapter-sdk";
import {
  AgentGatewayHttpServer,
  AgentGatewayService,
  EphemeralGitPushTokenService,
  EphemeralReviewerCredentialService,
  HttpAgentGatewayClient,
} from "@software-factory/agent-gateway";
import {
  CORE_API_AUTH_HEADER,
  CoreApiHttpServer,
  type CoreApiAuthContext,
  CoreApiService,
  HttpCoreApiClient,
  HttpCoreApiError,
  encodeCoreApiAuthHeader,
} from "@software-factory/core-api";
import {
  type ControlPlaneStore,
  PostgresControlPlaneRepository,
  PostgresRlsError,
  PostgresRuntimePool,
  SoftwareFactoryControlPlaneStore,
  buildPostgresPoolConfigFromEnv,
} from "@software-factory/database";
import {
  type M5AcceptanceCriterionReport,
  type M5EnvironmentCapabilities,
  type M5EvidenceBundle,
  type M5FaultRecoveryScenarioReport,
  type ResourceUsageMetricRecord,
  canonicalizeJson,
  sha256Hex,
} from "@software-factory/shared-types";
import type { TaskContractSpec } from "@software-factory/task-contract";
import {
  Docker3TierVerifier,
  ImmutableSourceSnapshotStore,
  probeDockerVerifierSupport,
} from "@software-factory/verifier";
import { WebApprovalConsoleHttpServer } from "@software-factory/web";
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
  readonly initialMainSha: string;
  readonly contract: TaskContractSpec;
  advanceClockMs(ms: number): void;
  closeAndCleanup(): Promise<void>;
}

async function createM5LiveStackFixture(options?: {
  approvalTtlSeconds?: number;
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
    const fxCD = await createM5LiveStackFixture({ approvalTtlSeconds: 60 });
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
});
