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
import type { CasMergeResult, SoftwareFactoryControlPlaneStore } from "@software-factory/database";

export interface CoreApiAuthContext {
  projectId: string;
  principalId: string;
}

/**
 * CoreApiService (MVP-SPEC-01, MVP-SPEC-02, MVP-SPEC-04)
 * Orchestrates Control Plane operations within scoped `core_api_service` RLS transactions:
 * Task creation, Lease grant/revoke, Trusted Import validation, Candidate-First creation,
 * Ephemeral Verifier recording, 3D Independent Reviewer artifact recording,
 * 8-Field Human Approval, and Atomic CAS Merge + Post-Merge Reconciler.
 */
export class CoreApiService {
  private readonly store: SoftwareFactoryControlPlaneStore;

  constructor(store: SoftwareFactoryControlPlaneStore) {
    this.store = store;
  }

  public async createTask(
    projectId: string,
    principalId: string,
    input: {
      title: string;
      task_contract: TaskContractSpec;
      base_main_commit_hash?: string;
    }
  ): Promise<TaskRecord> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: principalId,
        currentRole: "core_api_service",
      },
      () =>
        this.store.createTask({
          project_id: projectId,
          title: input.title,
          task_contract: input.task_contract,
          base_main_commit_hash: input.base_main_commit_hash,
        })
    );
  }

  public async dispatchTaskLease(
    projectId: string,
    principalId: string,
    input: {
      task_id: string;
      worker_id: string;
      heartbeat_interval_ms?: number;
      lease_ttl_ms?: number;
    }
  ): Promise<TaskLeaseRecord> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: principalId,
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
    principalId: string,
    input: {
      task_id: string;
      lease_id: string;
      reason: string;
      requeueTask?: boolean;
    }
  ): Promise<TaskLeaseRecord> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: principalId,
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
    principalId: string,
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
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: principalId,
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
    principalId: string,
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
      developer_principal_id?: string;
      reviewer_principal_id?: string;
      developer_session_id?: string;
      reviewer_session_id?: string;
      review_verdict: "PASS" | "FAIL";
      findings_json?: ReadonlyArray<Record<string, unknown>>;
    }
  ): Promise<{
    verificationRun: VerificationRunRecord;
    reviewArtifact: ReviewArtifactRecord;
  }> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: principalId,
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
    approverPrincipalId: string,
    input: {
      task_id: string;
      merge_candidate_id: string;
      agent_commit_hash: string;
      base_main_commit_hash: string;
      verified_tree_hash: string;
      merge_candidate_hash: string;
      verification_run_id: string;
      review_artifact_id: string;
      decision: "APPROVED" | "REJECTED";
      ttl_ms?: number;
    }
  ): Promise<ApprovalDecisionRecord> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: approverPrincipalId,
        currentRole: "core_api_service",
      },
      () =>
        this.store.submitHumanApproval({
          project_id: projectId,
          approver_principal_id: approverPrincipalId,
          ...input,
        })
    );
  }

  public async executeCasMerge(
    projectId: string,
    principalId: string,
    input: {
      task_id: string;
      merge_candidate_id: string;
      approval_id: string;
    }
  ): Promise<CasMergeResult> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: principalId,
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
