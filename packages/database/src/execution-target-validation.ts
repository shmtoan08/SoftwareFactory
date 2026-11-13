import { canonicalizeJson, sha256Hex, type AgentOrganizationProfileRecord, type TaskExecutionAssignmentRecord, type TaskRecord, type TaskLeaseRecord, type VerificationRunRecord } from "@software-factory/shared-types";
import { PostgresRlsError } from "./types.ts";
export function executionProfileSnapshot(profile: AgentOrganizationProfileRecord): Readonly<Record<string, unknown>> {
    return { profile_id: profile.profile_id, project_id: profile.project_id, profile_key: profile.profile_key, role: profile.role, principal_id: profile.principal_id, provider: profile.provider, model: profile.model,
        execution_target_type: profile.execution_target_type, trust_tier: profile.trust_tier, target_locator: profile.target_locator, capabilities_json: profile.capabilities_json, is_active: profile.is_active };
}
export function executionProfileSha(profile: AgentOrganizationProfileRecord): string { return sha256Hex(canonicalizeJson(executionProfileSnapshot(profile))); }
export function validateTargetAssignment(input: Omit<TaskExecutionAssignmentRecord, "created_at">, task: TaskRecord | null, profile: AgentOrganizationProfileRecord | null, hasLeases: boolean, plannedProfileId: string | null): void {
    if (!task || !profile || task.project_id !== input.project_id || profile.project_id !== input.project_id || profile.profile_id !== input.profile_id || task.task_id !== input.task_id)
        throw new PostgresRlsError("23503", "Execution assignment tenant/task/profile mismatch");
    if (hasLeases || task.current_attempt_no !== 0 || !["Ready", "ReworkRequired"].includes(task.status))
        throw new PostgresRlsError("23514", "Execution assignment requires an unstarted task");
    if (!profile.is_active || profile.role !== "DEVELOPER" || profile.execution_target_type === "factory_managed_worker" || input.target_key !== profile.target_locator || plannedProfileId && plannedProfileId !== profile.profile_id
        || input.profile_sha256 !== executionProfileSha(profile) || canonicalizeJson(input.profile_snapshot) !== canonicalizeJson(executionProfileSnapshot(profile))
        || input.task_contract_sha256 !== sha256Hex(canonicalizeJson(task.task_contract_json)) || input.data_classification !== "PUBLIC"
        || typeof input.public_context !== "string" || Buffer.byteLength(input.public_context) > 16384 || !/^[a-z][a-z0-9-]{0,63}$/.test(input.target_key) || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.worker_id))
        throw new PostgresRlsError("23514", "Invalid approved execution target or public context");
}
export function validateTargetLease(task: TaskRecord, assignment: TaskExecutionAssignmentRecord | null, profile: AgentOrganizationProfileRecord | null, input: {
    worker_id: string;
    execution_target_assignment_id?: string | null;
    execution_target_request_id?: string | null;
}): void {
    if (!assignment) {
        if (input.execution_target_assignment_id || input.execution_target_request_id || profile && (!profile.is_active || profile.role !== "DEVELOPER" || profile.execution_target_type !== "factory_managed_worker"))
            throw new PostgresRlsError("23514", "External target dispatch requires an approved execution assignment");
        return;
    }
    if (!profile || !profile.is_active || executionProfileSha(profile) !== assignment.profile_sha256 || sha256Hex(canonicalizeJson(task.task_contract_json)) !== assignment.task_contract_sha256
        || input.execution_target_assignment_id !== assignment.assignment_id || input.worker_id !== assignment.worker_id || !input.execution_target_request_id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.execution_target_request_id))
        throw new PostgresRlsError("23514", "Target dispatch binding or approved profile/contract changed");
}
export function validateTargetVerification(lease: TaskLeaseRecord | null, assignment: TaskExecutionAssignmentRecord | null, profile: AgentOrganizationProfileRecord | null, input: Pick<VerificationRunRecord, "isolation_runtime" | "execution_backend" | "is_docker_isolated" | "hermetic_network_disabled" | "verifier_image_digest">): void {
    if (lease?.execution_target_assignment_id) {
        if (!assignment || assignment.assignment_id !== lease.execution_target_assignment_id || input.isolation_runtime !== "runsc" || input.execution_backend !== "docker" || input.is_docker_isolated !== true || input.hermetic_network_disabled !== true || !/^sha256:[a-f0-9]{64}$/.test(input.verifier_image_digest))
            throw new PostgresRlsError("23514", "External target verification requires immutable lease provenance and network-disabled runsc");
    }
    else if (assignment || profile && profile.execution_target_type !== "factory_managed_worker")
        throw new PostgresRlsError("23514", "External target verification is missing approved lease provenance");
}
