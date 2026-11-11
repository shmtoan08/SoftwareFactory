import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { types } from "node:util";
import {
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type BaselineSpecFreezeRecord,
  type CandidateBoundLineage,
  type CostSessionRecord,
  type M5AcceptanceCriterionReport,
  type M5EnvironmentCapabilities,
  type M5EvidenceBundle,
  type M5FaultRecoveryScenarioReport,
  type MergeCandidateRecord,
  type MergeOperationRecord,
  type ModelCallLedgerRecord,
  type ModelPricingRate,
  type ProductPipelineBundle,
  type ProductPipelineSessionRecord,
  type ResourceUsageMetricRecord,
  type ReviewArtifactRecord,
  type ReviewSessionRecord,
  type Stage1DiscoveryItemRecord,
  type Stage4ConsistencyReport,
  type StageApprovalGateRecord,
  type StageApprovalGateStage,
  type StageArtifactRecord,
  type TaskLeaseRecord,
  type TaskRecord,
  type TaskStatus,
  type VerificationRunRecord,
  type VerifiedCodeImportRecord,
  canonicalizeJson,
  sha256Hex,
} from "@software-factory/shared-types";
import {
  type ManagedModelProviderExecutor,
  type ModelProviderConfig,
  type PromptRegistry,
} from "@software-factory/adapter-sdk";
import {
  type GitTreeImportCandidateInput,
  type TaskContractSpec,
  inspectRealGitCommitForImport,
} from "@software-factory/task-contract";
import {
  type CasMergeResult,
  type ControlPlaneStore,
  PostgresRlsError,
  type ProjectMemberRole,
  type ProjectMembershipRecord,
  type RecordResourceUsageMetricInput,
} from "@software-factory/database";
import {
  ProductPipelineService,
  type Stage1ExtractOutcome,
  type StageExecutionOutcome,
} from "@software-factory/product-pipeline";
import {
  type BuildMergeCandidateResult,
  Docker3TierVerifier,
  ImmutableSourceSnapshotStore,
  type RetryableVerificationResult,
  SnapshotIntegrityError,
  type TierCommandSpec,
  buildRealGitMergeCandidate,
} from "@software-factory/verifier";
import {
  type IndependentReviewEvaluator,
  type IndependentReviewExecutionResult,
  IndependentReviewerService,
} from "@software-factory/reviewer";
import type {
  AgentGatewayService,
  IssuedReviewerSessionCredential,
} from "@software-factory/agent-gateway";
import { LinuxCgroupV2SandboxBackend } from "@software-factory/wna";

export interface CoreApiWarning {
  readonly code: string;
  readonly message: string;
  readonly taskId?: string;
  readonly mergeCandidateId?: string;
  readonly error?: string;
  readonly occurredAt: string;
}

export interface ApprovalCenterBundle {
  readonly project: {
    readonly project_id: string;
    readonly slug: string;
    readonly approval_ttl_seconds: number;
    readonly main_ref_commit_hash: string;
  };
  readonly task: TaskRecord;
  readonly activeCandidate: MergeCandidateRecord | null;
  readonly latestVerificationRun: VerificationRunRecord | null;
  readonly latestReviewSession: ReviewSessionRecord | null;
  readonly latestReviewArtifact: ReviewArtifactRecord | null;
  readonly activeApprovalRequest: ApprovalRequestRecord | null;
  readonly approvalDecisions: readonly ApprovalDecisionRecord[];
  readonly mergeOperations: readonly MergeOperationRecord[];
  readonly resourceUsageMetrics?: readonly ResourceUsageMetricRecord[];
  readonly liveMainCommitHash: string | null;
  readonly staleBaseDetected: boolean;
  readonly isExpiredAtNow: boolean;
  readonly remainingTtlMs: number | null;
  readonly diffSummary: {
    readonly changedFiles: readonly string[];
    readonly diffText: string;
  };
  readonly eightFieldLockPayload: {
    readonly project_id: string;
    readonly task_id: string;
    readonly merge_candidate_id: string;
    readonly approval_request_id: string | null;
    readonly agent_commit_hash: string;
    readonly base_main_commit_hash: string;
    readonly verified_tree_hash: string;
    readonly merge_candidate_hash: string;
    readonly verification_run_id: string;
    readonly review_artifact_id: string;
  } | null;
  readonly candidateLineage: {
    readonly mainHeadCommitHash: string | null;
    readonly verifiedImport: VerifiedCodeImportRecord | null;
    readonly mergeCandidate: MergeCandidateRecord | null;
    readonly verificationRun: VerificationRunRecord | null;
    readonly reviewSession: ReviewSessionRecord | null;
    readonly reviewArtifact: ReviewArtifactRecord | null;
    readonly approvalRequest: ApprovalRequestRecord | null;
    readonly approvalDecisions: readonly ApprovalDecisionRecord[];
    readonly mergeOperations: readonly MergeOperationRecord[];
  };
  readonly fullLineage?: CandidateBoundLineage;
}

export interface CoreApiAuthContext {
  readonly projectId: string;
  readonly principalId: string;
  readonly roles: readonly ProjectMemberRole[];
  readonly sessionId: string;
  readonly tokenId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signatureHex: string;
}

const READ_ROLES: readonly ProjectMemberRole[] = [
  "AUDITOR",
  "DEVELOPER",
  "PROJECT_APPROVER",
  "ORG_ADMIN",
];
const MUTATION_ROLES: readonly ProjectMemberRole[] = [
  "DEVELOPER",
  "PROJECT_APPROVER",
  "ORG_ADMIN",
];
const APPROVAL_ROLES: readonly ProjectMemberRole[] = ["PROJECT_APPROVER", "ORG_ADMIN"];

/**
 * Cryptographic HMAC-SHA256 AuthN/AuthZ token authenticator for `CoreApiService` (`FIX-23`).
 * Prevents callers from spoofing raw string principals or forging unauthenticated `CoreApiAuthContext` objects.
 */
export class CoreApiTokenAuthenticator {
  private readonly signingSecret: string;
  private readonly clockFn: () => Date;

  constructor(options?: { signingSecret?: string; clockFn?: () => Date }) {
    if (options?.signingSecret !== undefined) {
      if (options.signingSecret.trim().length === 0) {
        throw new Error("CoreApiTokenAuthenticator signingSecret must be a non-empty string");
      }
      this.signingSecret = options.signingSecret;
    } else {
      this.signingSecret = randomBytes(32).toString("hex");
    }
    this.clockFn = options?.clockFn ?? (() => new Date());
  }

  private signPayload(fields: {
    tokenId: string;
    projectId: string;
    principalId: string;
    roles: readonly ProjectMemberRole[];
    sessionId: string;
    issuedAt: string;
    expiresAt: string;
  }): string {
    const normalizedRoles = [...fields.roles].sort().join(",");
    const canonical = `${fields.tokenId}:${fields.projectId}:${fields.principalId}:${normalizedRoles}:${fields.sessionId}:${fields.issuedAt}:${fields.expiresAt}`;
    return createHmac("sha256", this.signingSecret).update(canonical, "utf8").digest("hex");
  }

  public issueAuthContext(input: {
    projectId: string;
    principalId: string;
    roles: readonly ProjectMemberRole[];
    sessionId?: string;
    ttlMs?: number;
  }): CoreApiAuthContext {
    if (!input.projectId.trim() || !input.principalId.trim()) {
      throw new PostgresRlsError("42501", "projectId and principalId are required to issue AuthContext");
    }
    if (input.roles.length === 0) {
      throw new PostgresRlsError("42501", "At least one ProjectMemberRole is required in AuthContext");
    }
    const nowDate = this.clockFn();
    const ttlMs = input.ttlMs ?? 3_600_000;
    if (ttlMs <= 0) {
      throw new PostgresRlsError("42501", "AuthContext ttlMs must be positive");
    }
    const tokenId = randomUUID();
    const sessionId = input.sessionId ?? `sess-${randomUUID()}`;
    const issuedAt = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + ttlMs).toISOString();
    const roles = Object.freeze([...input.roles]);
    const signatureHex = this.signPayload({
      tokenId,
      projectId: input.projectId,
      principalId: input.principalId,
      roles,
      sessionId,
      issuedAt,
      expiresAt,
    });

    return Object.freeze({
      projectId: input.projectId,
      principalId: input.principalId,
      roles,
      sessionId,
      tokenId,
      issuedAt,
      expiresAt,
      signatureHex,
    });
  }

  public verifyAuthContext(
    auth: unknown,
    targetProjectId: string,
    requiredRoles: readonly ProjectMemberRole[]
  ): CoreApiAuthContext {
    if (!auth || typeof auth !== "object") {
      throw new PostgresRlsError(
        "42501",
        "Authentication failed: missing signed CoreApiAuthContext (raw principal strings are rejected)"
      );
    }

    const candidate = auth as Partial<CoreApiAuthContext>;
    if (
      typeof candidate.projectId !== "string" ||
      !candidate.projectId.trim() ||
      typeof candidate.principalId !== "string" ||
      !candidate.principalId.trim() ||
      typeof candidate.sessionId !== "string" ||
      !candidate.sessionId.trim() ||
      typeof candidate.tokenId !== "string" ||
      !candidate.tokenId.trim() ||
      typeof candidate.issuedAt !== "string" ||
      typeof candidate.expiresAt !== "string" ||
      typeof candidate.signatureHex !== "string" ||
      !Array.isArray(candidate.roles) ||
      candidate.roles.length === 0
    ) {
      throw new PostgresRlsError(
        "42501",
        "Authentication failed: malformed CoreApiAuthContext token structure"
      );
    }

    if (candidate.projectId !== targetProjectId) {
      throw new PostgresRlsError(
        "42501",
        `Authorization failed: AuthContext project ${candidate.projectId} does not match target project ${targetProjectId}`
      );
    }

    const nowMs = this.clockFn().getTime();
    const issuedMs = Date.parse(candidate.issuedAt);
    const expiresMs = Date.parse(candidate.expiresAt);
    if (Number.isNaN(issuedMs) || Number.isNaN(expiresMs) || expiresMs <= nowMs) {
      throw new PostgresRlsError("42501", "Authentication failed: CoreApiAuthContext has expired");
    }
    if (issuedMs > nowMs + 60_000) {
      throw new PostgresRlsError(
        "42501",
        "Authentication failed: CoreApiAuthContext issued_at is too far in the future"
      );
    }

    if (!/^[0-9a-f]{64}$/i.test(candidate.signatureHex)) {
      throw new PostgresRlsError("42501", "Authentication failed: invalid token signature format");
    }

    const expectedHex = this.signPayload({
      tokenId: candidate.tokenId,
      projectId: candidate.projectId,
      principalId: candidate.principalId,
      roles: candidate.roles,
      sessionId: candidate.sessionId,
      issuedAt: candidate.issuedAt,
      expiresAt: candidate.expiresAt,
    });

    const expectedBuf = Buffer.from(expectedHex, "hex");
    const actualBuf = Buffer.from(candidate.signatureHex, "hex");
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      throw new PostgresRlsError(
        "42501",
        "Authentication failed: forged or tampered CoreApiAuthContext signature"
      );
    }

    const hasRequiredTokenRole = candidate.roles.some((r) => requiredRoles.includes(r));
    if (!hasRequiredTokenRole) {
      throw new PostgresRlsError(
        "42501",
        `Authorization failed: principal ${candidate.principalId} roles [${candidate.roles.join(
          ", "
        )}] lack required roles [${requiredRoles.join(", ")}]`
      );
    }

    return candidate as CoreApiAuthContext;
  }
}

/**
 * CoreApiService (MVP-SPEC-01, MVP-SPEC-02, MVP-SPEC-04)
 * Orchestrates Control Plane operations within authenticated and authorized `core_api_service` RLS transactions:
 * Task creation, Lease grant/revoke, Trusted Import validation, Candidate-First creation,
 * Ephemeral Verifier recording, 3D Independent Reviewer artifact recording,
 * 8-Field Human Approval, and Atomic CAS Merge + Post-Merge Reconciler.
 */
export class CoreApiService {
  private readonly store: ControlPlaneStore;
  public readonly authenticator: CoreApiTokenAuthenticator;
  public readonly snapshotStore: ImmutableSourceSnapshotStore | null;
  public readonly pipelineService: ProductPipelineService;
  public readonly warnings: CoreApiWarning[] = [];
  private readonly onWarning?: (warning: CoreApiWarning) => void;

  constructor(
    store: ControlPlaneStore,
    options?: {
      authenticator?: CoreApiTokenAuthenticator;
      authSigningSecret?: string;
      clockFn?: () => Date;
      snapshotStore?: ImmutableSourceSnapshotStore;
      onWarning?: (warning: CoreApiWarning) => void;
      promptRegistry?: PromptRegistry;
      defaultModelConfig?: ModelProviderConfig;
      defaultModelExecutor?: ManagedModelProviderExecutor;
      modelPricingOverrides?: Readonly<Record<string, ModelPricingRate>>;
      pipelineService?: ProductPipelineService;
      env?: NodeJS.ProcessEnv;
    }
  ) {
    this.store = store;
    this.snapshotStore = options?.snapshotStore ?? null;
    this.onWarning = options?.onWarning;
    this.authenticator =
      options?.authenticator ??
      new CoreApiTokenAuthenticator({
        signingSecret: options?.authSigningSecret,
        clockFn:
          options?.clockFn ??
          (() => {
            if (types.isAsyncFunction(this.store.clockTimestampIso)) {
              return new Date();
            }
            const iso = this.store.clockTimestampIso();
            if (typeof iso === "string") {
              return new Date(iso);
            }
            if (iso && typeof (iso as Promise<unknown>).catch === "function") {
              void (iso as Promise<unknown>).catch(() => {});
            }
            return new Date();
          }),
      });
    this.pipelineService =
      options?.pipelineService ??
      new ProductPipelineService({
        store: this.store,
        promptRegistry: options?.promptRegistry,
        defaultModelConfig: options?.defaultModelConfig,
        defaultModelExecutor: options?.defaultModelExecutor,
        pricingOverrides: options?.modelPricingOverrides,
        env: options?.env,
      });
  }

  private emitWarning(warning: CoreApiWarning): void {
    this.warnings.push(warning);
    this.onWarning?.(warning);
  }

  private isRealGitRepoOnDisk(repoPath: string | null | undefined, gitDir?: string): boolean {
    if (!repoPath || !existsSync(repoPath)) {
      return false;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(gitDir ? { GIT_DIR: gitDir } : {}),
    };
    const check = spawnSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoPath,
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    return check.status === 0;
  }

  private createRealGitCasBridge(repoPath: string, gitDir?: string): {
    readonly getCurrentMainHead: () => string;
    readonly atomicCompareAndSwapMainRef: (
      expectedOldSha: string,
      newCandidateSha: string
    ) => boolean;
  } {
    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(gitDir ? { GIT_DIR: gitDir } : {}),
    };
    return {
      getCurrentMainHead: () =>
        execFileSync("git", ["rev-parse", "--verify", "refs/heads/main^{commit}"], {
          cwd: repoPath,
          env: gitEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
        }).trim(),
      atomicCompareAndSwapMainRef: (expectedOldSha: string, newCandidateSha: string) => {
        const res = spawnSync(
          "git",
          ["update-ref", "refs/heads/main", newCandidateSha, expectedOldSha],
          {
            cwd: repoPath,
            env: gitEnv,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          }
        );
        return res.status === 0;
      },
    };
  }

  public issueAuthContext(input: {
    projectId: string;
    principalId: string;
    roles: readonly ProjectMemberRole[];
    sessionId?: string;
    ttlMs?: number;
  }): CoreApiAuthContext {
    return this.authenticator.issueAuthContext(input);
  }

  private assertMembershipRole(
    verified: CoreApiAuthContext,
    membership: ProjectMembershipRecord | null,
    targetProjectId: string,
    requiredRoles: readonly ProjectMemberRole[]
  ): CoreApiAuthContext {
    if (
      !membership ||
      !requiredRoles.includes(membership.member_role) ||
      !verified.roles.includes(membership.member_role)
    ) {
      throw new PostgresRlsError(
        "42501",
        `Authorization failed: principal ${verified.principalId} (${
          membership ? `role=${membership.member_role}` : "no project membership"
        }) is not permitted for action in project ${targetProjectId}`
      );
    }
    return verified;
  }

  private withAuthorizedRlsTransaction<T>(
    auth: CoreApiAuthContext,
    targetProjectId: string,
    requiredRoles: readonly ProjectMemberRole[],
    fn: (verified: CoreApiAuthContext) => Promise<T> | T
  ): Promise<T> {
    let verified: CoreApiAuthContext;
    try {
      verified = this.authenticator.verifyAuthContext(auth, targetProjectId, requiredRoles);
    } catch (error) {
      return Promise.reject(error);
    }

    return this.store.withRlsTransaction(
      {
        currentProjectId: targetProjectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () => {
        const membershipOrPromise = this.store.getProjectMembership(
          targetProjectId,
          verified.principalId
        );
        if (
          membershipOrPromise &&
          typeof (membershipOrPromise as PromiseLike<unknown>).then === "function"
        ) {
          return (membershipOrPromise as Promise<ProjectMembershipRecord | null>).then(
            (membership) => {
              this.assertMembershipRole(verified, membership, targetProjectId, requiredRoles);
              return fn(verified);
            }
          );
        }
        this.assertMembershipRole(
          verified,
          membershipOrPromise as ProjectMembershipRecord | null,
          targetProjectId,
          requiredRoles
        );
        return fn(verified);
      }
    );
  }

  private async authorize(
    auth: CoreApiAuthContext,
    targetProjectId: string,
    requiredRoles: readonly ProjectMemberRole[]
  ): Promise<CoreApiAuthContext> {
    const verified = this.authenticator.verifyAuthContext(auth, targetProjectId, requiredRoles);
    const membership = await this.store.withRlsTransaction(
      {
        currentProjectId: targetProjectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () => this.store.getProjectMembership(targetProjectId, verified.principalId)
    );
    return this.assertMembershipRole(verified, membership, targetProjectId, requiredRoles);
  }

  public authorizeAction(
    auth: CoreApiAuthContext,
    targetProjectId: string,
    requiredRoles: readonly ProjectMemberRole[]
  ): Promise<CoreApiAuthContext> {
    return this.authorize(auth, targetProjectId, requiredRoles);
  }

  public createTask(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      title: string;
      task_contract: TaskContractSpec;
      base_main_commit_hash?: string;
      max_rework_cycles?: number;
    }
  ): Promise<TaskRecord> {
    return this.withAuthorizedRlsTransaction(auth, projectId, MUTATION_ROLES, () =>
      this.store.createTask({
        project_id: projectId,
        title: input.title,
        task_contract: input.task_contract,
        base_main_commit_hash: input.base_main_commit_hash,
        max_rework_cycles: input.max_rework_cycles,
      })
    );
  }

  public getTask(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string
  ): Promise<TaskRecord | null> {
    return this.withAuthorizedRlsTransaction(auth, projectId, READ_ROLES, () =>
      this.store.getTaskById(taskId)
    );
  }

  public listTasks(projectId: string, auth: CoreApiAuthContext): Promise<TaskRecord[]> {
    return this.withAuthorizedRlsTransaction(auth, projectId, READ_ROLES, () =>
      this.store.selectVisibleTasks()
    );
  }

  public dispatchTaskLease(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      worker_id: string;
      heartbeat_interval_ms?: number;
      lease_ttl_ms?: number;
    }
  ): Promise<TaskLeaseRecord> {
    return this.withAuthorizedRlsTransaction(auth, projectId, MUTATION_ROLES, () =>
      this.store.grantTaskLease({
        project_id: projectId,
        ...input,
      })
    );
  }

  public revokeTaskLease(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      lease_id: string;
      reason: string;
      requeueTask?: boolean;
    }
  ): Promise<TaskLeaseRecord> {
    return this.withAuthorizedRlsTransaction(auth, projectId, MUTATION_ROLES, () =>
      this.store.revokeTaskLease({
        project_id: projectId,
        ...input,
      })
    );
  }

  public async importAndBuildCandidate(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      lease_id: string;
      lease_epoch: number;
      staging_ref: string;
      candidate_input: GitTreeImportCandidateInput;
      base_main_commit_hash: string;
      merge_candidate_hash: string;
    }
  ): Promise<{
    verifiedImport: VerifiedCodeImportRecord;
    mergeCandidate: MergeCandidateRecord;
  }> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const verifiedImport = await this.store.recordVerifiedCodeImport({
          project_id: projectId,
          task_id: input.task_id,
          lease_id: input.lease_id,
          lease_epoch: input.lease_epoch,
          staging_ref: input.staging_ref,
          candidate_input: input.candidate_input,
        });
        const mergeCandidate = await this.store.createMergeCandidate({
          project_id: projectId,
          task_id: input.task_id,
          import_id: verifiedImport.import_id,
          base_main_commit_hash: input.base_main_commit_hash,
          merge_candidate_hash: input.merge_candidate_hash,
          verified_tree_hash: verifiedImport.verified_tree_hash,
        });
        return { verifiedImport, mergeCandidate };
      }
    );
  }

  public async recordVerificationAndIndependentReview(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      merge_candidate_id: string;
      merge_candidate_hash: string;
      verified_tree_hash: string;
      verifier_image_digest: string;
      verification_verdict: "PASS" | "FAIL";
      exit_code: number;
      duration_ms: number;
      report_sha256: string;
      writer_provider: string;
      writer_model: string;
      reviewer_provider: string;
      reviewer_model: string;
      developer_principal_id: string;
      reviewer_principal_id: string;
      developer_session_id: string;
      reviewer_session_id: string;
      review_verdict: "PASS" | "FAIL";
      findings_json?: ReadonlyArray<Record<string, unknown>>;
    }
  ): Promise<{
    verificationRun: VerificationRunRecord;
    reviewArtifact: ReviewArtifactRecord;
  }> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const verificationRun = await this.store.recordVerificationRun({
          project_id: projectId,
          task_id: input.task_id,
          merge_candidate_id: input.merge_candidate_id,
          merge_candidate_hash: input.merge_candidate_hash,
          verified_tree_hash: input.verified_tree_hash,
          verifier_image_digest: input.verifier_image_digest,
          verdict: input.verification_verdict,
          exit_code: input.exit_code,
          duration_ms: input.duration_ms,
          report_sha256: input.report_sha256,
        });

        const reviewArtifact = await this.store.recordReviewArtifact({
          project_id: projectId,
          task_id: input.task_id,
          merge_candidate_id: input.merge_candidate_id,
          verification_run_id: verificationRun.verification_run_id,
          merge_candidate_hash: input.merge_candidate_hash,
          verified_tree_hash: input.verified_tree_hash,
          writer_provider: input.writer_provider,
          writer_model: input.writer_model,
          reviewer_provider: input.reviewer_provider,
          reviewer_model: input.reviewer_model,
          developer_principal_id: input.developer_principal_id,
          reviewer_principal_id: input.reviewer_principal_id,
          developer_session_id: input.developer_session_id,
          reviewer_session_id: input.reviewer_session_id,
          verdict: input.review_verdict,
          findings_json: input.findings_json,
        });

        return { verificationRun, reviewArtifact };
      }
    );
  }

  public async submitHumanApproval(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      merge_candidate_id: string;
      approval_request_id?: string;
      agent_commit_hash: string;
      base_main_commit_hash: string;
      verified_tree_hash: string;
      merge_candidate_hash: string;
      verification_run_id: string;
      review_artifact_id: string;
      decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
      feedback?: string;
      ttl_ms?: number;
      repo_path?: string;
      git_dir?: string;
      current_main_commit_hash?: string;
    }
  ): Promise<ApprovalDecisionRecord> {
    const verified = await this.authorize(auth, projectId, APPROVAL_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const project = await this.store.getProjectById(projectId);
        const repoPath = input.repo_path ?? project?.repo_bare_path;
        let liveMainSha = input.current_main_commit_hash;
        if (this.isRealGitRepoOnDisk(repoPath, input.git_dir)) {
          const diskMainSha = this.createRealGitCasBridge(repoPath!, input.git_dir).getCurrentMainHead();
          if (liveMainSha && liveMainSha !== diskMainSha) {
            throw new PostgresRlsError(
              "23514",
              `Caller-supplied current_main_commit_hash (${liveMainSha}) does not match live Git refs/heads/main HEAD (${diskMainSha})`
            );
          }
          liveMainSha = diskMainSha;
        }
        return this.store.submitHumanApproval({
          project_id: projectId,
          approver_principal_id: verified.principalId,
          task_id: input.task_id,
          merge_candidate_id: input.merge_candidate_id,
          approval_request_id: input.approval_request_id,
          agent_commit_hash: input.agent_commit_hash,
          base_main_commit_hash: input.base_main_commit_hash,
          verified_tree_hash: input.verified_tree_hash,
          merge_candidate_hash: input.merge_candidate_hash,
          verification_run_id: input.verification_run_id,
          review_artifact_id: input.review_artifact_id,
          decision: input.decision,
          feedback: input.feedback,
          ttl_ms: input.ttl_ms,
          current_main_commit_hash: liveMainSha,
        });
      }
    );
  }

  public async buildMergeCandidateFromGit(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      lease_id: string;
      lease_epoch: number;
      staging_ref: string;
      agent_commit_hash: string;
      repo_path: string;
      git_dir?: string;
      candidate_input?: GitTreeImportCandidateInput;
      snapshot_store?: ImmutableSourceSnapshotStore;
    }
  ): Promise<
    | {
        readonly ok: true;
        readonly verifiedImport: VerifiedCodeImportRecord;
        readonly mergeCandidate: MergeCandidateRecord;
        readonly candidateBuild: Extract<BuildMergeCandidateResult, { ok: true }>;
      }
    | {
        readonly ok: false;
        readonly reason: "MERGE_CONFLICT";
        readonly verifiedImport: VerifiedCodeImportRecord;
        readonly taskStatus: TaskStatus;
        readonly conflictedFiles: readonly string[];
        readonly conflictSummary: string;
      }
  > {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    const snapshotStore = input.snapshot_store ?? this.snapshotStore ?? undefined;

    const { verifiedImport, clockIso } = await this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const task = await this.store.getTaskById(input.task_id);
        if (!task) {
          throw new PostgresRlsError("23503", `Task ${input.task_id} not found in project`);
        }

        const existingImports = await this.store.getVerifiedImportsForTask(input.task_id);
        let foundImport = existingImports.find(
          (rec) =>
            rec.lease_id === input.lease_id &&
            rec.lease_epoch === input.lease_epoch &&
            rec.agent_commit_hash === input.agent_commit_hash
        );

        if (!foundImport) {
          const candidateInput =
            input.candidate_input ??
            inspectRealGitCommitForImport({
              repoPath: input.repo_path,
              gitDir: input.git_dir,
              expectedBaseMainCommitHash: task.base_main_commit_hash,
              agentCommitHash: input.agent_commit_hash,
              contract: task.task_contract_json as unknown as TaskContractSpec,
            });
          foundImport = await this.store.recordVerifiedCodeImport({
            project_id: projectId,
            task_id: input.task_id,
            lease_id: input.lease_id,
            lease_epoch: input.lease_epoch,
            staging_ref: input.staging_ref,
            candidate_input: candidateInput,
          });
        }

        return {
          verifiedImport: foundImport,
          clockIso: await this.store.clockTimestampIso(),
        };
      }
    );

    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.git_dir ? { GIT_DIR: input.git_dir } : {}),
    };
    const candidateRef = `refs/factory/candidates/${input.task_id}`;
    let previousCandidateRefSha: string | null = null;
    try {
      previousCandidateRefSha =
        execFileSync("git", ["rev-parse", "--verify", "--quiet", candidateRef], {
          cwd: input.repo_path,
          env: gitEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
        }).trim() || null;
    } catch {
      previousCandidateRefSha = null;
    }

    const buildResult = buildRealGitMergeCandidate({
      repoPath: input.repo_path,
      gitDir: input.git_dir,
      taskId: input.task_id,
      agentCommitHash: input.agent_commit_hash,
      candidateRef,
      snapshotStore,
      createdAt: new Date(clockIso),
    });

    if (!buildResult.ok) {
      return this.store.withRlsTransaction(
        {
          currentProjectId: projectId,
          currentPrincipalId: verified.principalId,
          currentRole: "core_api_service",
        },
        async () => {
          const conflictRes = await this.store.markMergeConflictReworkRequired({
            project_id: projectId,
            task_id: input.task_id,
            import_id: verifiedImport.import_id,
            agent_commit_hash: input.agent_commit_hash,
            base_main_commit_hash: buildResult.baseMainCommitHash,
            conflicted_files: buildResult.conflictedFiles,
            conflict_summary: buildResult.conflictSummary,
          });
          return {
            ok: false as const,
            reason: "MERGE_CONFLICT" as const,
            verifiedImport,
            taskStatus: conflictRes.task_status,
            conflictedFiles: conflictRes.conflicted_files,
            conflictSummary: buildResult.conflictSummary,
          };
        }
      );
    }

    try {
      const mergeCandidate = await this.store.withRlsTransaction(
        {
          currentProjectId: projectId,
          currentPrincipalId: verified.principalId,
          currentRole: "core_api_service",
        },
        () =>
          this.store.createMergeCandidate({
            project_id: projectId,
            task_id: input.task_id,
            import_id: verifiedImport.import_id,
            base_main_commit_hash: buildResult.baseMainCommitHash,
            merge_candidate_hash: buildResult.mergeCandidateHash,
            verified_tree_hash: buildResult.verifiedTreeHash,
            snapshot_path: buildResult.snapshotPath ?? null,
            snapshot_sha256: buildResult.snapshotSha256 ?? null,
            snapshot_size_bytes: buildResult.snapshotSizeBytes ?? null,
            snapshot_retention_class: buildResult.snapshotRetentionClass ?? "EPHEMERAL_14D",
          })
      );

      return {
        ok: true,
        verifiedImport,
        mergeCandidate,
        candidateBuild: buildResult,
      };
    } catch (err) {
      // Compensate Git ref & newly created snapshot so DB errors leave zero orphan artifacts
      try {
        if (previousCandidateRefSha) {
          execFileSync("git", ["update-ref", buildResult.candidateRef, previousCandidateRefSha], {
            cwd: input.repo_path,
            env: gitEnv,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          });
        } else {
          execFileSync("git", ["update-ref", "-d", buildResult.candidateRef], {
            cwd: input.repo_path,
            env: gitEnv,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          });
        }
      } catch {
        // best-effort Git ref compensation
      }
      if (snapshotStore && buildResult.snapshotCreated && buildResult.snapshotPath) {
        try {
          snapshotStore.deleteSnapshot(buildResult.snapshotPath);
        } catch {
          // best-effort snapshot cleanup
        }
      }
      throw err;
    }
  }

  public async verifyMergeCandidate(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      merge_candidate_id: string;
      verifier: Docker3TierVerifier;
      trusted_acceptance_dir: string;
      expected_trusted_policy_sha256?: string;
      repo_path?: string;
      base_baseline_dir?: string;
      deps_cache_dir?: string;
      docker_image?: string;
      execution_mode?: "auto" | "docker" | "sandbox" | "subprocess";
      require_docker?: boolean;
      network_disabled?: boolean;
      step_timeout_ms?: number;
      max_infra_retries?: number;
      tier1_command: TierCommandSpec;
      tier2_command?: TierCommandSpec;
      tier3_command?: TierCommandSpec;
      tier3_test_files?: readonly string[];
      extra_env?: Readonly<Record<string, string>>;
      infra_error_hook?: (attemptIndex: number) => boolean;
    }
  ): Promise<{
    readonly finalRun: VerificationRunRecord;
    readonly allRuns: readonly VerificationRunRecord[];
    readonly retryResult: RetryableVerificationResult;
    readonly taskStatus: TaskStatus;
  }> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);

    const { task, candidate, resolvedRepoPath } = await this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const project = await this.store.getProjectById(projectId);
        const t = await this.store.getTaskById(input.task_id);
        const mc = await this.store.getMergeCandidateById(input.merge_candidate_id);
        if (!t || !mc || mc.task_id !== t.task_id) {
          throw new PostgresRlsError(
            "23503",
            `Task ${input.task_id} or MergeCandidate ${input.merge_candidate_id} not found`
          );
        }
        if (!mc.snapshot_path || !mc.snapshot_sha256) {
          throw new PostgresRlsError(
            "23514",
            `MergeCandidate ${mc.merge_candidate_id} is missing immutable snapshot_path/snapshot_sha256 required by M3 Verifier`
          );
        }
        const resolvedRepoPath =
          input.repo_path ??
          (project && this.isRealGitRepoOnDisk(project.repo_bare_path, undefined)
            ? project.repo_bare_path
            : undefined);
        return { task: t, candidate: mc, resolvedRepoPath };
      }
    );

    const recordedRuns: VerificationRunRecord[] = [];
    const retryResult = await input.verifier.verifyCandidateWithRetries({
      projectId,
      taskId: task.task_id,
      mergeCandidateId: candidate.merge_candidate_id,
      mergeCandidateHash: candidate.merge_candidate_hash,
      verifiedTreeHash: candidate.verified_tree_hash,
      baseMainCommitHash: candidate.base_main_commit_hash,
      taskContract: task.task_contract_json as unknown as TaskContractSpec,
      snapshotPath: candidate.snapshot_path!,
      snapshotSha256: candidate.snapshot_sha256!,
      trustedAcceptanceDir: input.trusted_acceptance_dir,
      expectedTrustedPolicySha256: input.expected_trusted_policy_sha256,
      repoPath: resolvedRepoPath,
      baseBaselineDir: input.base_baseline_dir,
      depsCacheDir: input.deps_cache_dir,
      dockerImage: input.docker_image,
      executionMode: input.execution_mode,
      requireDocker: input.require_docker,
      networkDisabled: input.network_disabled,
      stepTimeoutMs: input.step_timeout_ms,
      maxInfraRetries: input.max_infra_retries,
      tier1Command: input.tier1_command,
      tier2Command: input.tier2_command,
      tier3Command: input.tier3_command,
      tier3TestFiles: input.tier3_test_files,
      extraEnv: input.extra_env,
      infraErrorHook: input.infra_error_hook,
      onAttemptRecorded: (attempt, isFinal) => {
        const run = this.store.withRlsTransaction(
          {
            currentProjectId: projectId,
            currentPrincipalId: verified.principalId,
            currentRole: "core_api_service",
          },
          () =>
            this.store.recordVerificationRun({
              project_id: projectId,
              task_id: candidate.task_id,
              merge_candidate_id: candidate.merge_candidate_id,
              merge_candidate_hash: candidate.merge_candidate_hash,
              verified_tree_hash: candidate.verified_tree_hash,
              verifier_image_digest: attempt.verifierImageDigest,
              verdict: attempt.verdict,
              overall_status: attempt.overallStatus,
              tier1_trusted_acceptance_passed: attempt.tier1TrustedAcceptancePassed,
              tier2_protected_baseline_passed: attempt.tier2ProtectedBaselinePassed,
              tier2_baseline_tamper_detected: attempt.tier2BaselineTamperDetected,
              tampered_baseline_paths: attempt.tamperedBaselinePaths,
              tier3_agent_tests_passed: attempt.tier3AgentTestsPassed,
              tier3_assertions: attempt.tier3Assertions,
              infra_retry_count: attempt.attemptIndex,
              execution_backend: attempt.executionBackend,
              hermetic_network_disabled: attempt.hermeticNetworkDisabled,
              hardlink_cache_forbidden: attempt.hardlinkCacheForbidden,
              is_docker_isolated: attempt.isDockerIsolated,
              trusted_policy_sha256: attempt.trustedPolicySha256,
              keep_verifying_on_infra_retry:
                attempt.overallStatus === "INFRA_ERROR" && !isFinal,
              exit_code: attempt.exitCode,
              duration_ms: attempt.durationMs,
              report_sha256: attempt.reportSha256,
            })
        );
        return Promise.resolve(run).then((persisted) => {
          recordedRuns.push(persisted);
        });
      },
    });

    const finalRun = recordedRuns[recordedRuns.length - 1]!;
    const updatedTask = await this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const t = await this.store.getTaskById(task.task_id);
        const leases = await this.store.listTaskLeasesForTask(task.task_id);
        const latestLease = leases[leases.length - 1] ?? null;
        const totalWallTimeMs = Math.max(
          0,
          Math.round(
            retryResult.attempts.reduce((sum, a) => sum + a.durationMs, 0) || finalRun.duration_ms
          )
        );
        await this.store.recordResourceUsageMetric({
          project_id: projectId,
          task_id: task.task_id,
          lease_id: t?.active_lease_id ?? latestLease?.lease_id ?? null,
          lease_epoch: t?.active_lease_epoch ?? latestLease?.lease_epoch ?? 0,
          attempt_no: Math.max(1, t?.current_attempt_no ?? 1),
          rework_cycle: t?.rework_count ?? 0,
          phase: "VERIFIER",
          wall_time_ms: totalWallTimeMs,
          cpu_usage_usec: 0,
          peak_memory_bytes: 0,
          sandbox_backend_mode: finalRun.execution_backend ?? "host-subprocess",
          metrics_source: "wall-clock-only",
        });
        return t;
      }
    );

    return {
      finalRun,
      allRuns: recordedRuns,
      retryResult,
      taskStatus: updatedTask!.status,
    };
  }

  public async buildAndVerifyMergeCandidateFromGit(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      lease_id: string;
      lease_epoch: number;
      staging_ref: string;
      agent_commit_hash: string;
      repo_path: string;
      git_dir?: string;
      candidate_input?: GitTreeImportCandidateInput;
      snapshot_store?: ImmutableSourceSnapshotStore;
      verifier: Docker3TierVerifier;
      trusted_acceptance_dir: string;
      expected_trusted_policy_sha256?: string;
      base_baseline_dir?: string;
      deps_cache_dir?: string;
      docker_image?: string;
      execution_mode?: "auto" | "docker" | "sandbox" | "subprocess";
      require_docker?: boolean;
      network_disabled?: boolean;
      step_timeout_ms?: number;
      max_infra_retries?: number;
      tier1_command: TierCommandSpec;
      tier2_command?: TierCommandSpec;
      tier3_command?: TierCommandSpec;
      tier3_test_files?: readonly string[];
      extra_env?: Readonly<Record<string, string>>;
      infra_error_hook?: (attemptIndex: number) => boolean;
    }
  ): Promise<
    | {
        readonly ok: false;
        readonly reason: "MERGE_CONFLICT";
        readonly verifiedImport: VerifiedCodeImportRecord;
        readonly taskStatus: TaskStatus;
        readonly conflictedFiles: readonly string[];
        readonly conflictSummary: string;
      }
    | {
        readonly ok: true;
        readonly verifiedImport: VerifiedCodeImportRecord;
        readonly mergeCandidate: MergeCandidateRecord;
        readonly finalRun: VerificationRunRecord;
        readonly allRuns: readonly VerificationRunRecord[];
        readonly retryResult: RetryableVerificationResult;
        readonly taskStatus: TaskStatus;
      }
  > {
    const built = await this.buildMergeCandidateFromGit(projectId, auth, {
      task_id: input.task_id,
      lease_id: input.lease_id,
      lease_epoch: input.lease_epoch,
      staging_ref: input.staging_ref,
      agent_commit_hash: input.agent_commit_hash,
      repo_path: input.repo_path,
      git_dir: input.git_dir,
      candidate_input: input.candidate_input,
      snapshot_store: input.snapshot_store ?? input.verifier.snapshotStore,
    });

    if (!built.ok) {
      return built;
    }

    const verifiedRes = await this.verifyMergeCandidate(projectId, auth, {
      task_id: input.task_id,
      merge_candidate_id: built.mergeCandidate.merge_candidate_id,
      verifier: input.verifier,
      trusted_acceptance_dir: input.trusted_acceptance_dir,
      expected_trusted_policy_sha256: input.expected_trusted_policy_sha256,
      repo_path: input.repo_path,
      base_baseline_dir: input.base_baseline_dir,
      deps_cache_dir: input.deps_cache_dir,
      docker_image: input.docker_image,
      execution_mode: input.execution_mode,
      require_docker: input.require_docker,
      network_disabled: input.network_disabled,
      step_timeout_ms: input.step_timeout_ms,
      max_infra_retries: input.max_infra_retries,
      tier1_command: input.tier1_command,
      tier2_command: input.tier2_command,
      tier3_command: input.tier3_command,
      tier3_test_files: input.tier3_test_files,
      extra_env: input.extra_env,
      infra_error_hook: input.infra_error_hook,
    });

    return {
      ok: true,
      verifiedImport: built.verifiedImport,
      mergeCandidate: built.mergeCandidate,
      finalRun: verifiedRes.finalRun,
      allRuns: verifiedRes.allRuns,
      retryResult: verifiedRes.retryResult,
      taskStatus: verifiedRes.taskStatus,
    };
  }

  public async runIndependentReview(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      merge_candidate_id: string;
      verification_run_id: string;
      reviewer_principal_id: string;
      reviewer_session_id?: string;
      reviewer_credential_id?: string;
      reviewer_agent_profile_id: string;
      reviewer_provider: string;
      reviewer_model: string;
      developer_principal_id: string;
      developer_session_id: string;
      developer_credential_id: string;
      developer_agent_profile_id: string;
      writer_provider: string;
      writer_model: string;
      requested_role?: string;
      agent_gateway: AgentGatewayService;
      reviewer_service?: IndependentReviewerService;
      snapshot_store?: ImmutableSourceSnapshotStore;
      sandbox_backend?: LinuxCgroupV2SandboxBackend;
      repo_path?: string;
      git_dir?: string;
      tier3_test_files?: readonly string[];
      evaluator?: IndependentReviewEvaluator;
      probe_read_only_enforcement?: boolean;
      approval_request_ttl_ms?: number;
      extra_forbidden_context?: Readonly<Record<string, unknown>>;
    }
  ): Promise<{
    readonly reviewSession: ReviewSessionRecord;
    readonly reviewArtifact: ReviewArtifactRecord;
    readonly approvalRequest: ApprovalRequestRecord | null;
    readonly executionResult: IndependentReviewExecutionResult;
    readonly taskStatus: TaskStatus;
    readonly issuedCredential: IssuedReviewerSessionCredential;
  }> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);

    const { task, candidate, verificationRun, project } = await this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const p = await this.store.getProjectById(projectId);
        const t = await this.store.getTaskById(input.task_id);
        const mc = await this.store.getMergeCandidateById(input.merge_candidate_id);
        const runs = await this.store.listVerificationRunsForTask(input.task_id);
        const vr = runs.find((r) => r.verification_run_id === input.verification_run_id);
        if (
          !p ||
          !t ||
          !mc ||
          !vr ||
          mc.task_id !== t.task_id ||
          vr.merge_candidate_id !== mc.merge_candidate_id
        ) {
          throw new PostgresRlsError(
            "23503",
            `Task ${input.task_id}, candidate ${input.merge_candidate_id}, or verification run ${input.verification_run_id} not found`
          );
        }
        if (!mc.snapshot_path || !mc.snapshot_sha256) {
          throw new PostgresRlsError(
            "23514",
            `MergeCandidate ${mc.merge_candidate_id} is missing snapshot_path/snapshot_sha256 required for 3D Independent Review`
          );
        }
        return { project: p, task: t, candidate: mc, verificationRun: vr };
      }
    );

    const issuedCredential = input.agent_gateway.issueReviewerSessionCredential({
      project_id: projectId,
      task_id: task.task_id,
      merge_candidate_id: candidate.merge_candidate_id,
      verification_run_id: verificationRun.verification_run_id,
      requested_role: input.requested_role,
      developer_principal_id: input.developer_principal_id,
      reviewer_principal_id: input.reviewer_principal_id,
      developer_session_id: input.developer_session_id,
      reviewer_session_id: input.reviewer_session_id,
      developer_credential_id: input.developer_credential_id,
      reviewer_credential_id: input.reviewer_credential_id,
      developer_agent_profile_id: input.developer_agent_profile_id,
      reviewer_agent_profile_id: input.reviewer_agent_profile_id,
      writer_provider: input.writer_provider,
      writer_model: input.writer_model,
      reviewer_provider: input.reviewer_provider,
      reviewer_model: input.reviewer_model,
    });

    const snapshotStore = input.snapshot_store ?? this.snapshotStore ?? undefined;
    const reviewerSandbox =
      input.sandbox_backend ??
      (!input.reviewer_service ? new LinuxCgroupV2SandboxBackend() : undefined);
    const reviewerService =
      input.reviewer_service ??
      new IndependentReviewerService({
        snapshotStore,
        sandboxBackend: reviewerSandbox,
      });

    const reviewSessionId = issuedCredential.claims.reviewerSessionId;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reviewSessionId)
    ) {
      throw new PostgresRlsError(
        "23514",
        `Issued reviewer_session_id '${reviewSessionId}' must be a valid UUID`
      );
    }
    const startedSession = await this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () =>
        this.store.recordReviewSession({
          review_session_id: reviewSessionId,
          project_id: projectId,
          task_id: task.task_id,
          merge_candidate_id: candidate.merge_candidate_id,
          verification_run_id: verificationRun.verification_run_id,
          reviewer_principal_id: issuedCredential.claims.reviewerPrincipalId,
          reviewer_credential_id: issuedCredential.claims.reviewerCredentialId,
          reviewer_agent_profile_id: issuedCredential.claims.reviewerAgentProfileId,
          reviewer_provider: issuedCredential.claims.reviewerProvider,
          reviewer_model: issuedCredential.claims.reviewerModel,
          role: "ROLE_REVIEWER_READONLY",
          sandbox_backend_mode: process.platform === "linux" ? "linux-supervisor" : "real-process",
          status: "ACTIVE",
        })
    );

    const effectiveRepoPath =
      input.repo_path ??
      (this.isRealGitRepoOnDisk(project.repo_bare_path, input.git_dir)
        ? project.repo_bare_path
        : undefined);
    const reviewStartMs = Date.now();
    let executionResult: IndependentReviewExecutionResult;
    try {
      executionResult = await reviewerService.executeIndependentReview({
        reviewSessionId: startedSession.review_session_id,
        projectId,
        taskId: task.task_id,
        mergeCandidateId: candidate.merge_candidate_id,
        mergeCandidateHash: candidate.merge_candidate_hash,
        verifiedTreeHash: candidate.verified_tree_hash,
        baseMainCommitHash: candidate.base_main_commit_hash,
        snapshotPath: candidate.snapshot_path!,
        snapshotSha256: candidate.snapshot_sha256!,
        taskContract: task.task_contract_json as unknown as TaskContractSpec,
        verificationRun,
        reviewerIdentity: {
          principalId: issuedCredential.claims.reviewerPrincipalId,
          credentialId: issuedCredential.claims.reviewerCredentialId,
          sessionId: issuedCredential.claims.reviewerSessionId,
          agentProfileId: issuedCredential.claims.reviewerAgentProfileId,
          provider: issuedCredential.claims.reviewerProvider,
          model: issuedCredential.claims.reviewerModel,
          role: issuedCredential.claims.role,
        },
        repoPath: effectiveRepoPath,
        gitDir: input.git_dir,
        tier3TestFiles: input.tier3_test_files,
        snapshotStore,
        sandboxBackend: reviewerSandbox,
        evaluator: input.evaluator,
        probeReadOnlyEnforcement: input.probe_read_only_enforcement,
        ...(input.extra_forbidden_context ?? {}),
      });
    } catch (err) {
      await this.store.withRlsTransaction(
        {
          currentProjectId: projectId,
          currentPrincipalId: verified.principalId,
          currentRole: "core_api_service",
        },
        () =>
          this.store.completeReviewSession({
            project_id: projectId,
            review_session_id: startedSession.review_session_id,
            status: "FAILED",
            cleanup_populated_zero_verified: true,
          })
      );
      throw err;
    }

    const reviewWallFallbackMs = Math.max(0, Date.now() - reviewStartMs);
    const reviewerMetricsSnap =
      reviewerSandbox?.readMetrics(`review-${startedSession.review_session_id}`, 1) ?? null;

    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const completedSession = await this.store.completeReviewSession({
          project_id: projectId,
          review_session_id: startedSession.review_session_id,
          status: "COMPLETED",
          cleanup_populated_zero_verified:
            executionResult.sandboxCleanupEvidence?.populatedZeroVerified ?? true,
          sandbox_backend_mode: executionResult.sandboxBackendMode,
          sandbox_pid: executionResult.sandboxPid,
          sandbox_cgroup_path: executionResult.sandboxCgroupPath,
        });

        const reviewArtifact = await this.store.recordReviewArtifact({
          project_id: projectId,
          task_id: task.task_id,
          merge_candidate_id: candidate.merge_candidate_id,
          verification_run_id: verificationRun.verification_run_id,
          merge_candidate_hash: candidate.merge_candidate_hash,
          verified_tree_hash: candidate.verified_tree_hash,
          writer_provider: input.writer_provider,
          writer_model: input.writer_model,
          reviewer_provider: issuedCredential.claims.reviewerProvider,
          reviewer_model: issuedCredential.claims.reviewerModel,
          developer_principal_id: input.developer_principal_id,
          reviewer_principal_id: issuedCredential.claims.reviewerPrincipalId,
          developer_session_id: input.developer_session_id,
          reviewer_session_id: issuedCredential.claims.reviewerSessionId,
          developer_credential_id: input.developer_credential_id,
          reviewer_credential_id: issuedCredential.claims.reviewerCredentialId,
          developer_agent_profile_id: input.developer_agent_profile_id,
          reviewer_agent_profile_id: issuedCredential.claims.reviewerAgentProfileId,
          review_session_id: completedSession.review_session_id,
          summary_markdown: executionResult.summaryMarkdown,
          report_sha256: executionResult.reportSha256,
          approval_request_ttl_ms: input.approval_request_ttl_ms,
          verdict: executionResult.verdict,
          findings_json: executionResult.findings as unknown as ReadonlyArray<Record<string, unknown>>,
        });

        const leases = await this.store.listTaskLeasesForTask(task.task_id);
        const latestLease = leases[leases.length - 1] ?? null;
        await this.store.recordResourceUsageMetric({
          project_id: projectId,
          task_id: task.task_id,
          lease_id: task.active_lease_id ?? latestLease?.lease_id ?? null,
          lease_epoch: task.active_lease_epoch ?? latestLease?.lease_epoch ?? 0,
          attempt_no: Math.max(1, task.current_attempt_no ?? 1),
          rework_cycle: task.rework_count ?? 0,
          phase: "REVIEWER",
          wall_time_ms: reviewerMetricsSnap?.wallTimeMs ?? reviewWallFallbackMs,
          cpu_usage_usec: reviewerMetricsSnap?.cpuUsageUsec ?? 0,
          peak_memory_bytes: reviewerMetricsSnap?.peakMemoryBytes ?? 0,
          sandbox_backend_mode: executionResult.sandboxBackendMode,
          metrics_source: reviewerMetricsSnap?.metricsSource ?? "wall-clock-only",
        });

        const approvalRequest =
          executionResult.verdict === "PASS"
            ? await this.store.getLatestApprovalRequestForCandidate(candidate.merge_candidate_id)
            : null;
        const updatedTask = await this.store.getTaskById(task.task_id);

        return {
          reviewSession: completedSession,
          reviewArtifact,
          approvalRequest,
          executionResult,
          taskStatus: updatedTask!.status,
          issuedCredential,
        };
      }
    );
  }

  public async rebuildMergeCandidateAfterCasConflict(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      repo_path?: string;
      git_dir?: string;
      import_id?: string;
      snapshot_store?: ImmutableSourceSnapshotStore;
    }
  ): Promise<
    | {
        readonly ok: true;
        readonly verifiedImport: VerifiedCodeImportRecord;
        readonly mergeCandidate: MergeCandidateRecord;
        readonly candidateBuild: Extract<BuildMergeCandidateResult, { ok: true }>;
      }
    | {
        readonly ok: false;
        readonly reason: "MERGE_CONFLICT";
        readonly verifiedImport: VerifiedCodeImportRecord;
        readonly taskStatus: TaskStatus;
        readonly conflictedFiles: readonly string[];
        readonly conflictSummary: string;
      }
  > {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    const snapshotStore = input.snapshot_store ?? this.snapshotStore ?? undefined;

    const { task, verifiedImport, repoPath, clockIso } = await this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const p = await this.store.getProjectById(projectId);
        const t = await this.store.getTaskById(input.task_id);
        if (!p || !t) {
          throw new PostgresRlsError("23503", `Task ${input.task_id} not found in project`);
        }
        if (t.status !== "BuildingMergeCandidate") {
          throw new PostgresRlsError(
            "23514",
            `rebuildMergeCandidateAfterCasConflict requires task status BuildingMergeCandidate, got ${t.status}`
          );
        }
        const imports = await this.store.getVerifiedImportsForTask(t.task_id);
        const imp = input.import_id
          ? imports.find((rec) => rec.import_id === input.import_id)
          : imports[imports.length - 1];
        if (!imp) {
          throw new PostgresRlsError(
            "23503",
            `No VerifiedCodeImport found for task ${t.task_id} to rebuild merge candidate`
          );
        }
        const resolvedRepo = input.repo_path ?? p.repo_bare_path;
        if (!this.isRealGitRepoOnDisk(resolvedRepo, input.git_dir)) {
          throw new Error(
            `ERR_REAL_GIT_REPO_REQUIRED: cannot rebuild real merge candidate without valid Git repository at '${resolvedRepo}'`
          );
        }
        return {
          task: t,
          verifiedImport: imp,
          repoPath: resolvedRepo,
          clockIso: await this.store.clockTimestampIso(),
        };
      }
    );

    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.git_dir ? { GIT_DIR: input.git_dir } : {}),
    };
    const candidateRef = `refs/factory/candidates/${task.task_id}`;
    let previousCandidateRefSha: string | null = null;
    try {
      previousCandidateRefSha =
        execFileSync("git", ["rev-parse", "--verify", "--quiet", candidateRef], {
          cwd: repoPath,
          env: gitEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
        }).trim() || null;
    } catch {
      previousCandidateRefSha = null;
    }

    const buildResult = buildRealGitMergeCandidate({
      repoPath,
      gitDir: input.git_dir,
      taskId: task.task_id,
      agentCommitHash: verifiedImport.agent_commit_hash,
      candidateRef,
      snapshotStore,
      createdAt: new Date(clockIso),
    });

    if (!buildResult.ok) {
      return this.store.withRlsTransaction(
        {
          currentProjectId: projectId,
          currentPrincipalId: verified.principalId,
          currentRole: "core_api_service",
        },
        async () => {
          const conflictRes = await this.store.markMergeConflictReworkRequired({
            project_id: projectId,
            task_id: task.task_id,
            import_id: verifiedImport.import_id,
            agent_commit_hash: verifiedImport.agent_commit_hash,
            base_main_commit_hash: buildResult.baseMainCommitHash,
            conflicted_files: buildResult.conflictedFiles,
            conflict_summary: buildResult.conflictSummary,
          });
          return {
            ok: false as const,
            reason: "MERGE_CONFLICT" as const,
            verifiedImport,
            taskStatus: conflictRes.task_status,
            conflictedFiles: conflictRes.conflicted_files,
            conflictSummary: buildResult.conflictSummary,
          };
        }
      );
    }

    try {
      const mergeCandidate = await this.store.withRlsTransaction(
        {
          currentProjectId: projectId,
          currentPrincipalId: verified.principalId,
          currentRole: "core_api_service",
        },
        () =>
          this.store.createMergeCandidate({
            project_id: projectId,
            task_id: task.task_id,
            import_id: verifiedImport.import_id,
            base_main_commit_hash: buildResult.baseMainCommitHash,
            merge_candidate_hash: buildResult.mergeCandidateHash,
            verified_tree_hash: buildResult.verifiedTreeHash,
            allow_rebased_tree_hash: true,
            snapshot_path: buildResult.snapshotPath ?? null,
            snapshot_sha256: buildResult.snapshotSha256 ?? null,
            snapshot_size_bytes: buildResult.snapshotSizeBytes ?? null,
            snapshot_retention_class: buildResult.snapshotRetentionClass ?? "EPHEMERAL_14D",
          })
      );

      return {
        ok: true,
        verifiedImport,
        mergeCandidate,
        candidateBuild: buildResult,
      };
    } catch (err) {
      try {
        if (previousCandidateRefSha) {
          execFileSync("git", ["update-ref", buildResult.candidateRef, previousCandidateRefSha], {
            cwd: repoPath,
            env: gitEnv,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          });
        } else {
          execFileSync("git", ["update-ref", "-d", buildResult.candidateRef], {
            cwd: repoPath,
            env: gitEnv,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          });
        }
      } catch {
        // best-effort Git ref compensation
      }
      if (snapshotStore && buildResult.snapshotCreated && buildResult.snapshotPath) {
        try {
          snapshotStore.deleteSnapshot(buildResult.snapshotPath);
        } catch {
          // best-effort snapshot cleanup
        }
      }
      throw err;
    }
  }

  public async getApprovalCenterBundle(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      repo_path?: string;
      git_dir?: string;
    }
  ): Promise<ApprovalCenterBundle> {
    const verified = await this.authorize(auth, projectId, APPROVAL_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const project = await this.store.getProjectById(projectId);
        const task = await this.store.getTaskById(input.task_id);
        if (!project || !task) {
          throw new PostgresRlsError("23503", `Project ${projectId} or task ${input.task_id} not found`);
        }

        const candidates = await this.store.listMergeCandidatesForTask(task.task_id);
        const activeCandidate =
          (task.active_merge_candidate_id
            ? candidates.find((c) => c.merge_candidate_id === task.active_merge_candidate_id)
            : undefined) ??
          candidates.find((c) => !c.is_superseded) ??
          (candidates.length > 0 ? candidates[candidates.length - 1]! : null);

        const runs = await this.store.listVerificationRunsForTask(task.task_id);
        const latestVerificationRun =
          (activeCandidate
            ? runs
                .filter((r) => r.merge_candidate_id === activeCandidate.merge_candidate_id)
                .slice(-1)[0]
            : undefined) ??
          (runs.length > 0 ? runs[runs.length - 1]! : null);

        const sessions = await this.store.listReviewSessionsForTask(task.task_id);
        const latestReviewSession =
          (activeCandidate
            ? sessions
                .filter((s) => s.merge_candidate_id === activeCandidate.merge_candidate_id)
                .slice(-1)[0]
            : undefined) ??
          (sessions.length > 0 ? sessions[sessions.length - 1]! : null);

        const artifacts = await this.store.listReviewArtifactsForTask(task.task_id);
        const latestReviewArtifact =
          (activeCandidate
            ? artifacts
                .filter((a) => a.merge_candidate_id === activeCandidate.merge_candidate_id)
                .slice(-1)[0]
            : undefined) ??
          (artifacts.length > 0 ? artifacts[artifacts.length - 1]! : null);

        const requests = await this.store.listApprovalRequestsForTask(task.task_id);
        const activeApprovalRequest =
          (activeCandidate
            ? requests
                .filter((r) => r.merge_candidate_id === activeCandidate.merge_candidate_id)
                .slice(-1)[0]
            : undefined) ??
          (requests.length > 0 ? requests[requests.length - 1]! : null);

        const approvalDecisions = await this.store.listApprovalDecisionsForTask(task.task_id);
        const mergeOperations = await this.store.listMergeOperationsForTask(task.task_id);
        const resourceUsageMetrics = await this.store.listResourceUsageMetricsForTask(task.task_id);
        const imports = await this.store.getVerifiedImportsForTask(task.task_id);
        const verifiedImport =
          (activeCandidate
            ? imports.find((i) => i.import_id === activeCandidate.import_id)
            : undefined) ??
          (imports.length > 0 ? imports[imports.length - 1]! : null);

        const effectiveRepo = input.repo_path ?? project.repo_bare_path;
        const hasRealRepo = this.isRealGitRepoOnDisk(effectiveRepo, input.git_dir);
        const liveMainCommitHash = hasRealRepo
          ? this.createRealGitCasBridge(effectiveRepo, input.git_dir).getCurrentMainHead()
          : await this.store.getMainRefCommitHash(projectId);

        const fullLineage =
          (await this.store.getCandidateBoundLineage(task.task_id, liveMainCommitHash)) ?? undefined;

        const staleBaseDetected = Boolean(
          activeCandidate &&
            liveMainCommitHash &&
            activeCandidate.base_main_commit_hash !== liveMainCommitHash
        );

        const nowMs = new Date(await this.store.clockTimestampIso()).getTime();
        const isPendingRequest = activeApprovalRequest?.status === "PENDING";
        const expiresAtMs = isPendingRequest
          ? Date.parse(activeApprovalRequest.expires_at)
          : null;
        const remainingTtlMs = expiresAtMs !== null ? expiresAtMs - nowMs : null;
        const isExpiredAtNow = remainingTtlMs !== null ? remainingTtlMs <= 0 : false;

        let changedFiles: string[] = [];
        let diffText = "";
        if (hasRealRepo && activeCandidate) {
          const gitEnv: NodeJS.ProcessEnv = {
            ...process.env,
            ...(input.git_dir ? { GIT_DIR: input.git_dir } : {}),
          };
          try {
            changedFiles = execFileSync(
              "git",
              [
                "diff",
                "--name-only",
                activeCandidate.base_main_commit_hash,
                activeCandidate.merge_candidate_hash,
              ],
              {
                cwd: effectiveRepo,
                env: gitEnv,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 10_000,
              }
            )
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            diffText = execFileSync(
              "git",
              [
                "diff",
                "--unified=3",
                activeCandidate.base_main_commit_hash,
                activeCandidate.merge_candidate_hash,
              ],
              {
                cwd: effectiveRepo,
                env: gitEnv,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 10_000,
              }
            );
          } catch {
            diffText = `(diff unavailable for ${activeCandidate.base_main_commit_hash}..${activeCandidate.merge_candidate_hash})`;
          }
        }

        const eightFieldLockPayload =
          activeCandidate && latestVerificationRun && latestReviewArtifact
            ? {
                project_id: projectId,
                task_id: task.task_id,
                merge_candidate_id: activeCandidate.merge_candidate_id,
                approval_request_id: activeApprovalRequest?.approval_request_id ?? null,
                agent_commit_hash: activeCandidate.agent_commit_hash,
                base_main_commit_hash: activeCandidate.base_main_commit_hash,
                verified_tree_hash: activeCandidate.verified_tree_hash,
                merge_candidate_hash: activeCandidate.merge_candidate_hash,
                verification_run_id: latestVerificationRun.verification_run_id,
                review_artifact_id: latestReviewArtifact.review_artifact_id,
              }
            : null;

        return {
          project: {
            project_id: project.project_id,
            slug: project.slug,
            approval_ttl_seconds: project.approval_ttl_seconds,
            main_ref_commit_hash: project.main_ref_commit_hash,
          },
          task,
          activeCandidate,
          latestVerificationRun,
          latestReviewSession,
          latestReviewArtifact,
          activeApprovalRequest,
          approvalDecisions,
          mergeOperations,
          resourceUsageMetrics,
          liveMainCommitHash,
          staleBaseDetected,
          isExpiredAtNow,
          remainingTtlMs,
          diffSummary: {
            changedFiles,
            diffText,
          },
          eightFieldLockPayload,
          candidateLineage: {
            mainHeadCommitHash: liveMainCommitHash,
            verifiedImport,
            mergeCandidate: activeCandidate,
            verificationRun: latestVerificationRun,
            reviewSession: latestReviewSession,
            reviewArtifact: latestReviewArtifact,
            approvalRequest: activeApprovalRequest,
            approvalDecisions,
            mergeOperations,
          },
          fullLineage,
        };
      }
    );
  }

  public async executeCasMerge(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      merge_candidate_id: string;
      approval_id: string;
      repo_path?: string;
      git_dir?: string;
      require_real_git?: boolean;
      simulateCrashAfterGitUpdateRef?: boolean;
      snapshot_store?: ImmutableSourceSnapshotStore;
    }
  ): Promise<CasMergeResult> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    const snapshotStore = input.snapshot_store ?? this.snapshotStore;
    const { res, snapshotPath, clockIso } = await this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const project = await this.store.getProjectById(projectId);
        const resolvedRepoPath = input.repo_path ?? project?.repo_bare_path;
        const hasRealGitRepo = this.isRealGitRepoOnDisk(resolvedRepoPath, input.git_dir);
        if (input.require_real_git && !hasRealGitRepo) {
          throw new Error(
            `ERR_REAL_GIT_REPO_REQUIRED: executeCasMerge requires valid Git repository at '${String(
              resolvedRepoPath
            )}'`
          );
        }
        const gitBridge = hasRealGitRepo
          ? this.createRealGitCasBridge(resolvedRepoPath!, input.git_dir)
          : undefined;

        const casRes = await this.store.executeAtomicCasMergeOrReconcile({
          project_id: projectId,
          task_id: input.task_id,
          merge_candidate_id: input.merge_candidate_id,
          approval_id: input.approval_id,
          gitBridge,
          simulateCrashAfterGitUpdateRef: input.simulateCrashAfterGitUpdateRef,
        });
        const mc = await this.store.getMergeCandidateById(input.merge_candidate_id);
        return {
          res: casRes,
          snapshotPath: mc?.snapshot_path ?? null,
          clockIso: await this.store.clockTimestampIso(),
        };
      }
    );

    if (snapshotStore && snapshotPath) {
      try {
        if (res.status === "MERGED_BY_CAS" || res.status === "RECONCILED_ALREADY_MERGED") {
          snapshotStore.markMergedPermanent(snapshotPath);
        } else if (res.status === "CAS_CONFLICT_NEEDS_REBASE") {
          snapshotStore.markInvalidatedOrSuperseded(snapshotPath, new Date(clockIso));
        }
      } catch (err) {
        if (
          !(err instanceof SnapshotIntegrityError && err.code === "ERR_SNAPSHOT_NOT_FOUND")
        ) {
          // CAS merge is already durably committed in DB/Git; record structured warning without rolling back merge.
          this.emitWarning({
            code: "WARN_SNAPSHOT_PROMOTION_FAILED",
            message: `Snapshot retention update failed after CAS merge for candidate ${input.merge_candidate_id}`,
            taskId: input.task_id,
            mergeCandidateId: input.merge_candidate_id,
            error: err instanceof Error ? err.message : String(err),
            occurredAt: clockIso,
          });
        }
      }
    }

    return res;
  }

  public async recordResourceUsageMetric(
    projectId: string,
    auth: CoreApiAuthContext,
    input: Omit<RecordResourceUsageMetricInput, "project_id">
  ): Promise<ResourceUsageMetricRecord> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () =>
        this.store.recordResourceUsageMetric({
          ...input,
          project_id: projectId,
        })
    );
  }

  public async listResourceUsageMetrics(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string
  ): Promise<ResourceUsageMetricRecord[]> {
    const verified = await this.authorize(auth, projectId, READ_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () => this.store.listResourceUsageMetricsForTask(taskId)
    );
  }

  public async getCandidateBoundLineage(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      repo_path?: string;
      git_dir?: string;
    }
  ): Promise<CandidateBoundLineage> {
    const verified = await this.authorize(auth, projectId, READ_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const project = await this.store.getProjectById(projectId);
        if (!project) {
          throw new PostgresRlsError("23503", `Project ${projectId} not found`);
        }
        const effectiveRepo = input.repo_path ?? project.repo_bare_path;
        const hasRealRepo = this.isRealGitRepoOnDisk(effectiveRepo, input.git_dir);
        const liveMainHead = hasRealRepo
          ? this.createRealGitCasBridge(effectiveRepo, input.git_dir).getCurrentMainHead()
          : await this.store.getMainRefCommitHash(projectId);

        const lineage = await this.store.getCandidateBoundLineage(input.task_id, liveMainHead);
        if (!lineage) {
          throw new PostgresRlsError("23503", `Task ${input.task_id} not found in project ${projectId}`);
        }
        return lineage;
      }
    );
  }

  public async runOrphanedPushReconciler(
    projectId: string,
    auth: CoreApiAuthContext,
    orphanedDiffProvider?: Parameters<ControlPlaneStore["runLeaseExpiryAndOrphanedPushReconciler"]>[0]
  ) {
    await this.authorize(auth, projectId, MUTATION_ROLES);
    const allResults = await this.store.runLeaseExpiryAndOrphanedPushReconciler(orphanedDiffProvider);
    const visibleTaskIds = new Set(
      (
        await this.store.withRlsTransaction(
          {
            currentProjectId: projectId,
            currentPrincipalId: auth.principalId,
            currentRole: "core_api_service",
          },
          () => this.store.selectVisibleTasks()
        )
      ).map((t) => t.task_id)
    );
    return allResults.filter((r) => visibleTaskIds.has(r.task_id));
  }

  public exportM5EvidenceBundle(input: {
    lineage: CandidateBoundLineage;
    criteria: readonly M5AcceptanceCriterionReport[];
    faultRecoveryReports: readonly M5FaultRecoveryScenarioReport[];
    environmentCapabilities: M5EnvironmentCapabilities;
    generatedAt?: string;
  }): M5EvidenceBundle {
    return buildM5EvidenceBundle(input);
  }

  // ===========================================================================
  // Milestone M6A: Model Cost Guard (AC-12b) & Stages 1–4 Product Pipeline
  // ===========================================================================

  public async createCostSession(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly cost_session_id?: string;
      readonly pipeline_session_id?: string | null;
      readonly task_id?: string | null;
      readonly max_tokens_per_request: number;
      readonly max_cost_micro_usd_per_request: number;
      readonly session_token_budget: number;
      readonly session_cost_budget_micro_usd: number;
    }
  ): Promise<CostSessionRecord> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    return this.pipelineService.createCostSession({
      ...input,
      project_id: projectId,
      actor_principal_id: verified.principalId,
    });
  }

  public async getCostSessionWithLedgers(
    projectId: string,
    auth: CoreApiAuthContext,
    costSessionId: string
  ): Promise<{
    readonly session: CostSessionRecord;
    readonly ledgers: readonly ModelCallLedgerRecord[];
  } | null> {
    const verified = await this.authorize(auth, projectId, READ_ROLES);
    return this.pipelineService.getCostSessionWithLedgers({
      project_id: projectId,
      actor_principal_id: verified.principalId,
      cost_session_id: costSessionId,
    });
  }

  public async createPipelineSession(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly pipeline_session_id?: string;
      readonly cost_session_id?: string | null;
      readonly cost_budget?: {
        readonly cost_session_id?: string;
        readonly max_tokens_per_request: number;
        readonly max_cost_micro_usd_per_request: number;
        readonly session_token_budget: number;
        readonly session_cost_budget_micro_usd: number;
      };
      readonly title: string;
      readonly raw_idea_text: string;
    }
  ): Promise<{
    readonly session: ProductPipelineSessionRecord;
    readonly costSession: CostSessionRecord | null;
  }> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    return this.pipelineService.createSession({
      ...input,
      project_id: projectId,
      created_by_principal_id: verified.principalId,
    });
  }

  public async listPipelineSessions(
    projectId: string,
    auth: CoreApiAuthContext
  ): Promise<ProductPipelineSessionRecord[]> {
    const verified = await this.authorize(auth, projectId, READ_ROLES);
    return this.pipelineService.listSessions({
      project_id: projectId,
      actor_principal_id: verified.principalId,
    });
  }

  public async getPipelineBundle(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string
  ): Promise<ProductPipelineBundle | null> {
    const verified = await this.authorize(auth, projectId, READ_ROLES);
    return this.pipelineService.getBundle({
      project_id: projectId,
      actor_principal_id: verified.principalId,
      pipeline_session_id: pipelineSessionId,
    });
  }

  public async runPipelineStage1Extract(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly pipeline_session_id: string;
      readonly cost_session_id?: string;
      readonly prompt_version?: string;
      readonly max_tokens?: number;
      readonly temperature?: number;
      readonly model_config?: ModelProviderConfig;
      readonly model_executor?: ManagedModelProviderExecutor;
    }
  ): Promise<Stage1ExtractOutcome> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    return this.pipelineService.intakeAndExtractStage1({
      ...input,
      project_id: projectId,
      actor_principal_id: verified.principalId,
    });
  }

  public async resolvePipelineStage1Item(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly pipeline_session_id: string;
      readonly item_id: string;
      readonly decision: "CONFIRM" | "REJECT";
      readonly resolution_note?: string | null;
    }
  ): Promise<Stage1DiscoveryItemRecord> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    return this.pipelineService.resolveStage1Item({
      ...input,
      project_id: projectId,
      actor_principal_id: verified.principalId,
    });
  }

  public async runPipelineStage2Requirements(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly pipeline_session_id: string;
      readonly cost_session_id?: string;
      readonly prompt_version?: string;
      readonly max_tokens?: number;
      readonly temperature?: number;
      readonly model_config?: ModelProviderConfig;
      readonly model_executor?: ManagedModelProviderExecutor;
    }
  ): Promise<StageExecutionOutcome<Record<string, unknown>>> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    return this.pipelineService.generateStage2Requirements({
      ...input,
      project_id: projectId,
      actor_principal_id: verified.principalId,
    });
  }

  public async runPipelineStage3Architecture(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly pipeline_session_id: string;
      readonly cost_session_id?: string;
      readonly stage2_artifact_id?: string;
      readonly prompt_version?: string;
      readonly max_tokens?: number;
      readonly temperature?: number;
      readonly model_config?: ModelProviderConfig;
      readonly model_executor?: ManagedModelProviderExecutor;
    }
  ): Promise<StageExecutionOutcome<Record<string, unknown>>> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    return this.pipelineService.generateStage3Architecture({
      ...input,
      project_id: projectId,
      actor_principal_id: verified.principalId,
    });
  }

  public async runPipelineStage4ConsistencyCheck(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly pipeline_session_id: string;
      readonly stage1_artifact_id?: string;
      readonly stage2_artifact_id?: string;
      readonly stage3_artifact_id?: string;
      readonly checked_at?: string;
    }
  ): Promise<{
    readonly session: ProductPipelineSessionRecord;
    readonly report: Stage4ConsistencyReport;
    readonly artifact: StageArtifactRecord;
  }> {
    const verified = await this.authorize(auth, projectId, MUTATION_ROLES);
    return this.pipelineService.runStage4ConsistencyCheck({
      ...input,
      project_id: projectId,
      actor_principal_id: verified.principalId,
    });
  }

  public async submitPipelineApprovalGate(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly pipeline_session_id: string;
      readonly gate_stage: StageApprovalGateStage;
      readonly target_artifact_id?: string;
      readonly target_artifact_sha256?: string;
      readonly decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
      readonly rationale?: string | null;
    }
  ): Promise<StageApprovalGateRecord> {
    const verified = await this.authorize(auth, projectId, APPROVAL_ROLES);
    return this.pipelineService.submitStageApprovalGate({
      ...input,
      project_id: projectId,
      approver_principal_id: verified.principalId,
    });
  }

  public async freezePipelineBaseline(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly pipeline_session_id: string;
      readonly stage1_artifact_id?: string;
      readonly stage1_artifact_sha256?: string;
      readonly stage2_artifact_id?: string;
      readonly stage2_artifact_sha256?: string;
      readonly stage3_artifact_id?: string;
      readonly stage3_artifact_sha256?: string;
      readonly validation_report_artifact_id?: string;
      readonly validation_report_sha256?: string;
      readonly approval_gate_id?: string;
    }
  ): Promise<BaselineSpecFreezeRecord> {
    const verified = await this.authorize(auth, projectId, APPROVAL_ROLES);
    return this.pipelineService.freezeBaselineSpec({
      ...input,
      project_id: projectId,
      frozen_by_principal_id: verified.principalId,
    });
  }
}

export function buildM5EvidenceBundle(input: {
  lineage: CandidateBoundLineage;
  criteria: readonly M5AcceptanceCriterionReport[];
  faultRecoveryReports: readonly M5FaultRecoveryScenarioReport[];
  environmentCapabilities: M5EnvironmentCapabilities;
  generatedAt?: string;
}): M5EvidenceBundle {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const unsigned = {
    schemaVersion: "1.5" as const,
    milestone: "M5" as const,
    generatedAt,
    environmentCapabilities: input.environmentCapabilities,
    verticalSliceSummary: {
      projectId: input.lineage.projectId,
      taskId: input.lineage.taskId,
      taskStatus: input.lineage.task.status,
      mainHeadCommitHash: input.lineage.mainHeadCommitHash,
      mergeCandidateHash: input.lineage.mergeCandidate?.merge_candidate_hash ?? null,
      verifiedTreeHash: input.lineage.mergeCandidate?.verified_tree_hash ?? null,
      agentCommitHash: input.lineage.verifiedImport?.agent_commit_hash ?? null,
      reworkCount: input.lineage.task.rework_count,
      leaseEpochsObserved: input.lineage.taskLeases.length,
    },
    criteria: input.criteria,
    faultRecoveryReports: input.faultRecoveryReports,
    lineage: input.lineage,
    resourceUsageMetrics: input.lineage.resourceUsageMetrics,
  };
  const bundleSha256 = sha256Hex(canonicalizeJson(unsigned));
  return {
    ...unsigned,
    bundleSha256,
  };
}

export * from "./http-server.ts";
export * from "./runtime.ts";
