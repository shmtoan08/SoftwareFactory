import type { CodeImportSubmissionRecord } from "@software-factory/shared-types";
import { PostgresRlsError } from "./types.ts";

export function validateCodeImportReceipt(input: Omit<CodeImportSubmissionRecord, "submission_id" | "created_at">): void {
  if (!["bundle", "patch", "artifact"].includes(input.source_type) ||
    !Number.isSafeInteger(input.lease_epoch) || input.lease_epoch < 1 ||
    !/^[0-9a-f]{64}$/.test(input.payload_sha256) || !/^[0-9a-f]{40}$/.test(input.agent_commit_hash) ||
    !/^[0-9a-f]{40}$/.test(input.verified_tree_hash) || !input.submitted_by_principal_id?.trim() ||
    ![`refs/factory/Verify/${input.task_id}/${input.lease_epoch}`, `refs/heads/sf/staging/${input.task_id}/${input.lease_epoch}`].includes(input.staging_ref)) {
    throw new PostgresRlsError("23514", "Invalid immutable code import receipt metadata");
  }
}
