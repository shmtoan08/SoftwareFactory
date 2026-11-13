import { canonicalizeJson, sha256Hex, type ProductionDeploymentApprovalRecord, type ProductionDeploymentRecord, type ProductionReconciliationApprovalRecord, type ProductionResolutionEvidence } from "@software-factory/shared-types";
import { PostgresRlsError } from "./types.ts";

export function deploymentBindingSha256(approval: ProductionDeploymentApprovalRecord, deployment: ProductionDeploymentRecord): string {
  return sha256Hex(canonicalizeJson({ deployment_id: deployment.deployment_id, project_id: deployment.project_id, original_approval_id: approval.approval_id,
    release_id: approval.release_id, release_package_sha256: approval.release_package_sha256, commit_hash: approval.commit_hash,
    artifact_sha256: approval.artifact_sha256, target_key: approval.target_key, started_at: deployment.started_at }));
}
export function validateResolutionEvidence(evidence: ProductionResolutionEvidence, artifact: string): void {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
    || Object.keys(evidence).sort().join(",") !== "artifact_sha256,evidence_sha256,outcome,provider_operation_id,terminal_fence"
    || evidence.terminal_fence !== true || !["SUCCEEDED","NOT_DEPLOYED"].includes(evidence.outcome)
    || typeof evidence.provider_operation_id !== "string" || !/^[A-Za-z0-9._:/-]{1,256}$/.test(evidence.provider_operation_id)
    || typeof evidence.evidence_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.evidence_sha256)
    || (evidence.outcome === "SUCCEEDED" ? evidence.artifact_sha256 !== artifact : evidence.artifact_sha256 !== null)) {
    throw new PostgresRlsError("23514", "Reconciliation requires verified terminal fencing and exact artifact evidence");
  }
}
export function validateReconciliationApproval(input: ProductionReconciliationApprovalRecord, original: ProductionDeploymentApprovalRecord | null, deployment: ProductionDeploymentRecord | null, now: string): void {
  if (!original || !deployment || original.project_id !== input.project_id || deployment.project_id !== input.project_id
    || original.approval_id !== input.original_approval_id || deployment.approval_id !== original.approval_id
    || deployment.deployment_id !== input.deployment_id || deployment.reconciled_at || !["RUNNING","UNKNOWN"].includes(deployment.status)
    || input.expected_status !== deployment.status || input.deployment_binding_sha256 !== deploymentBindingSha256(original,deployment)) {
    throw new PostgresRlsError("23514", "Reconciliation approval does not bind the unresolved deployment snapshot");
  }
  validateResolutionEvidence(input.evidence,original.artifact_sha256);
  const issued = Date.parse(input.issued_at), expires = Date.parse(input.expires_at), current = Date.parse(now);
  if (input.status !== "ACTIVE" || !/^[a-f0-9]{64}$/.test(input.token_sha256) || !input.approver_principal_id.trim()
    || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > current || expires <= current || expires <= issued || expires-issued > 900_000) {
    throw new PostgresRlsError("23514", "Invalid reconciliation approval or lifetime (maximum 15 minutes)");
  }
}
