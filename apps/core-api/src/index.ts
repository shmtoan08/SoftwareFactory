import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ApprovalDecisionRecord,
  MergeCandidateRecord,
  ReviewArtifactRecord,
  TaskLeaseRecord,
  TaskRecord,
  TaskStatus,
  VerificationRunRecord,
  VerifiedCodeImportRecord,
} from "@software-factory/shared-types";
import {
  type GitTreeImportCandidateInput,
  type TaskContractSpec,
  inspectRealGitCommitForImport,
} from "@software-factory/task-contract";
import {
  type CasMergeResult,
  PostgresRlsError,
  type ProjectMemberRole,
  type SoftwareFactoryControlPlaneStore,
} from "@software-factory/database";
import {
  type BuildMergeCandidateResult,
  Docker3TierVerifier,
  ImmutableSourceSnapshotStore,
  type RetryableVerificationResult,
  type TierCommandSpec,
  buildRealGitMergeCandidate,
} from "@software-factory/verifier";

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
  private readonly store: SoftwareFactoryControlPlaneStore;
  public readonly authenticator: CoreApiTokenAuthenticator;
  public readonly snapshotStore: ImmutableSourceSnapshotStore | null;

  constructor(
    store: SoftwareFactoryControlPlaneStore,
    options?: {
      authenticator?: CoreApiTokenAuthenticator;
      authSigningSecret?: string;
      clockFn?: () => Date;
      snapshotStore?: ImmutableSourceSnapshotStore;
    }
  ) {
    this.store = store;
    this.snapshotStore = options?.snapshotStore ?? null;
    this.authenticator =
      options?.authenticator ??
      new CoreApiTokenAuthenticator({
        signingSecret: options?.authSigningSecret,
        clockFn: options?.clockFn ?? (() => new Date(this.store.clockTimestampIso())),
      });
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

  private authorize(
    auth: CoreApiAuthContext,
    targetProjectId: string,
    requiredRoles: readonly ProjectMemberRole[]
  ): CoreApiAuthContext {
    const verified = this.authenticator.verifyAuthContext(auth, targetProjectId, requiredRoles);
    const membership = this.store.getProjectMembership(targetProjectId, verified.principalId);
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

  public async createTask(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      title: string;
      task_contract: TaskContractSpec;
      base_main_commit_hash?: string;
      max_rework_cycles?: number;
    }
  ): Promise<TaskRecord> {
    const verified = this.authorize(auth, projectId, MUTATION_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () =>
        this.store.createTask({
          project_id: projectId,
          title: input.title,
          task_contract: input.task_contract,
          base_main_commit_hash: input.base_main_commit_hash,
          max_rework_cycles: input.max_rework_cycles,
        })
    );
  }

  public async dispatchTaskLease(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      worker_id: string;
      heartbeat_interval_ms?: number;
      lease_ttl_ms?: number;
    }
  ): Promise<TaskLeaseRecord> {
    const verified = this.authorize(auth, projectId, MUTATION_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () =>
        this.store.grantTaskLease({
          project_id: projectId,
          ...input,
        })
    );
  }

  public async revokeTaskLease(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      lease_id: string;
      reason: string;
      requeueTask?: boolean;
    }
  ): Promise<TaskLeaseRecord> {
    const verified = this.authorize(auth, projectId, MUTATION_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () =>
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
    const verified = this.authorize(auth, projectId, MUTATION_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () => {
        const verifiedImport = this.store.recordVerifiedCodeImport({
          project_id: projectId,
          task_id: input.task_id,
          lease_id: input.lease_id,
          lease_epoch: input.lease_epoch,
          staging_ref: input.staging_ref,
          candidate_input: input.candidate_input,
        });
        const mergeCandidate = this.store.createMergeCandidate({
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
    const verified = this.authorize(auth, projectId, MUTATION_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () => {
        const verificationRun = this.store.recordVerificationRun({
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

        const reviewArtifact = this.store.recordReviewArtifact({
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
      agent_commit_hash: string;
      base_main_commit_hash: string;
      verified_tree_hash: string;
      merge_candidate_hash: string;
      verification_run_id: string;
      review_artifact_id: string;
      decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
      feedback?: string;
      ttl_ms?: number;
    }
  ): Promise<ApprovalDecisionRecord> {
    const verified = this.authorize(auth, projectId, APPROVAL_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () =>
        this.store.submitHumanApproval({
          project_id: projectId,
          approver_principal_id: verified.principalId,
          ...input,
        })
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
    const verified = this.authorize(auth, projectId, MUTATION_ROLES);
    const snapshotStore = input.snapshot_store ?? this.snapshotStore ?? undefined;

    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () => {
        const task = this.store.getTaskById(input.task_id);
        if (!task) {
          throw new PostgresRlsError("23503", `Task ${input.task_id} not found in project`);
        }

        const existingImports = this.store.getVerifiedImportsForTask(input.task_id);
        let verifiedImport = existingImports.find(
          (rec) =>
            rec.lease_id === input.lease_id &&
            rec.lease_epoch === input.lease_epoch &&
            rec.agent_commit_hash === input.agent_commit_hash
        );

        if (!verifiedImport) {
          const candidateInput =
            input.candidate_input ??
            inspectRealGitCommitForImport({
              repoPath: input.repo_path,
              gitDir: input.git_dir,
              expectedBaseMainCommitHash: task.base_main_commit_hash,
              agentCommitHash: input.agent_commit_hash,
              contract: task.task_contract_json as unknown as TaskContractSpec,
            });
          verifiedImport = this.store.recordVerifiedCodeImport({
            project_id: projectId,
            task_id: input.task_id,
            lease_id: input.lease_id,
            lease_epoch: input.lease_epoch,
            staging_ref: input.staging_ref,
            candidate_input: candidateInput,
          });
        }

        const buildResult = buildRealGitMergeCandidate({
          repoPath: input.repo_path,
          gitDir: input.git_dir,
          taskId: input.task_id,
          agentCommitHash: input.agent_commit_hash,
          snapshotStore,
          createdAt: new Date(this.store.clockTimestampIso()),
        });

        if (!buildResult.ok) {
          const conflictRes = this.store.markMergeConflictReworkRequired({
            project_id: projectId,
            task_id: input.task_id,
            import_id: verifiedImport.import_id,
            agent_commit_hash: input.agent_commit_hash,
            base_main_commit_hash: buildResult.baseMainCommitHash,
            conflicted_files: buildResult.conflictedFiles,
            conflict_summary: buildResult.conflictSummary,
          });
          return {
            ok: false,
            reason: "MERGE_CONFLICT",
            verifiedImport,
            taskStatus: conflictRes.task_status,
            conflictedFiles: conflictRes.conflicted_files,
            conflictSummary: buildResult.conflictSummary,
          };
        }

        const mergeCandidate = this.store.createMergeCandidate({
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
        });

        return {
          ok: true,
          verifiedImport,
          mergeCandidate,
          candidateBuild: buildResult,
        };
      }
    );
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
    const verified = this.authorize(auth, projectId, MUTATION_ROLES);

    const { task, candidate } = await this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () => {
        const t = this.store.getTaskById(input.task_id);
        const mc = this.store.getMergeCandidateById(input.merge_candidate_id);
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
        return { task: t, candidate: mc };
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
      repoPath: input.repo_path,
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
      () => this.store.getTaskById(task.task_id)
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

  public async executeCasMerge(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      merge_candidate_id: string;
      approval_id: string;
      snapshot_store?: ImmutableSourceSnapshotStore;
    }
  ): Promise<CasMergeResult> {
    const verified = this.authorize(auth, projectId, MUTATION_ROLES);
    const snapshotStore = input.snapshot_store ?? this.snapshotStore;
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      async () => {
        const res = await this.store.executeAtomicCasMergeOrReconcile({
          project_id: projectId,
          task_id: input.task_id,
          merge_candidate_id: input.merge_candidate_id,
          approval_id: input.approval_id,
        });
        if (snapshotStore) {
          const mc = this.store.getMergeCandidateById(input.merge_candidate_id);
          if (mc?.snapshot_path) {
            if (res.status === "MERGED_BY_CAS" || res.status === "RECONCILED_ALREADY_MERGED") {
              snapshotStore.markMergedPermanent(mc.snapshot_path);
            } else if (res.status === "CAS_CONFLICT_NEEDS_REBASE") {
              snapshotStore.markInvalidatedOrSuperseded(
                mc.snapshot_path,
                new Date(this.store.clockTimestampIso())
              );
            }
          }
        }
        return res;
      }
    );
  }
}
