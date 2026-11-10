import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ApprovalDecisionRecord,
  MergeCandidateRecord,
  ReviewArtifactRecord,
  TaskLeaseRecord,
  TaskRecord,
  VerificationRunRecord,
  VerifiedCodeImportRecord,
} from "@software-factory/shared-types";
import type { GitTreeImportCandidateInput, TaskContractSpec } from "@software-factory/task-contract";
import {
  type CasMergeResult,
  PostgresRlsError,
  type ProjectMemberRole,
  type SoftwareFactoryControlPlaneStore,
} from "@software-factory/database";

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

  constructor(
    store: SoftwareFactoryControlPlaneStore,
    options?: {
      authenticator?: CoreApiTokenAuthenticator;
      authSigningSecret?: string;
      clockFn?: () => Date;
    }
  ) {
    this.store = store;
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

  public async executeCasMerge(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      task_id: string;
      merge_candidate_id: string;
      approval_id: string;
    }
  ): Promise<CasMergeResult> {
    const verified = this.authorize(auth, projectId, MUTATION_ROLES);
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: verified.principalId,
        currentRole: "core_api_service",
      },
      () =>
        this.store.executeAtomicCasMergeOrReconcile({
          project_id: projectId,
          ...input,
        })
    );
  }
}
