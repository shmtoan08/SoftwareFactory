import type { ProductionDeploymentApprovalRecord, ReleaseAcceptancePackageRecord } from "@software-factory/shared-types";
import { PostgresRlsError } from "./types.ts";

export function validateProductionApproval(input: ProductionDeploymentApprovalRecord, release: ReleaseAcceptancePackageRecord | null, now: string): void {
  const issued = Date.parse(input.issued_at); const expires = Date.parse(input.expires_at); const current = Date.parse(now);
  if (!release || release.project_id !== input.project_id || release.pipeline_session_id !== input.pipeline_session_id
    || release.release_id !== input.release_id || release.package_sha256 !== input.release_package_sha256
    || release.main_head_commit_hash !== input.commit_hash || !release.complete || release.coverage_percent !== 100) {
    throw new PostgresRlsError("23503", "Production approval must bind the exact accepted release");
  }
  if (input.status !== "ACTIVE" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.target_key)
    || !/^[0-9a-f]{64}$/.test(input.artifact_sha256) || !/^[0-9a-f]{64}$/.test(input.token_sha256)
    || !input.approver_principal_id.trim() || !Number.isFinite(issued) || !Number.isFinite(expires)
    || issued > current || expires <= current || expires <= issued || expires - issued > 3_600_000) {
    throw new PostgresRlsError("23514", "Invalid production approval binding or lifetime (maximum one hour)");
  }
}

export function validateDeploymentCompletion(status: string, receipt: string | null): void {
  if (!((status === "SUCCEEDED" && receipt !== null && /^[0-9a-f]{64}$/.test(receipt)) || (status === "UNKNOWN" && receipt === null))) {
    throw new PostgresRlsError("23514", "Production completion requires a success receipt or UNKNOWN outcome");
  }
}
