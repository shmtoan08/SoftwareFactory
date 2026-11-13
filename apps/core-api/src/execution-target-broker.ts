import { randomUUID } from "node:crypto";
import { canonicalizeJson, sha256Hex, type TaskExecutionAssignmentRecord, type TargetDispatchRecord, type CodeImportSubmissionRecord } from "@software-factory/shared-types";
import { PostgresControlPlaneRepository, PostgresRlsError, executionProfileSnapshot, executionProfileSha, type ControlPlaneStore } from "@software-factory/database";
import { type ExecutionTargetConnector, type ExternalTargetAction } from "@software-factory/adapter-sdk";
import { CodeImportError, type CodeImportSubmission } from "@software-factory/task-contract";
import { redactTelemetryMessage } from "@software-factory/observability";
export interface ExecutionTargetConfiguration {
    readonly connectors?: Readonly<Record<string, ExecutionTargetConnector>>;
    readonly timeoutMs?: number;
    readonly testOnlyEmulator?: boolean;
}
export interface AssignExecutionTargetInput {
    readonly profile_id: string;
    readonly public_context: string;
    readonly data_classification: "PUBLIC";
}
export function validateExecutionTargetConfiguration(config: ExecutionTargetConfiguration, store?: ControlPlaneStore): void {
    for (const [key, connector] of Object.entries(config.connectors ?? {})) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || !connector || !["user_managed_worker", "provider_managed_vm", "remote_agent_session"].includes(connector.targetType) || typeof connector.health !== "function" || typeof connector.execute !== "function")
            throw new Error("Invalid operator execution target registry");
    }
    if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120000))
        throw new Error("Target timeout must be 1..120000 ms");
    if (store && Object.keys(config.connectors ?? {}).length && config.testOnlyEmulator !== true && !(store instanceof PostgresControlPlaneRepository))
        throw new Error("External execution requires durable PostgreSQL dispatch intents");
}
export function validateTargetId(id: string): void { if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
    throw new PostgresRlsError("23514", "Execution target identifiers must be canonical UUIDs"); }
function strictKeys(input: object, keys: readonly string[]): void { if (!input || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)))
    throw new PostgresRlsError("23514", "Unknown execution target request fields"); }
export class ExecutionTargetBroker {
    private readonly store: ControlPlaneStore;
    private readonly connectors: Map<string, ExecutionTargetConnector>;
    private readonly timeoutMs: number;
    constructor(store: ControlPlaneStore, config: ExecutionTargetConfiguration = {}) { validateExecutionTargetConfiguration(config, store); this.store = store; this.connectors = new Map(Object.entries(config.connectors ?? {})); this.timeoutMs = config.timeoutMs ?? 30000; }
    private scope(projectId: string, actor: string) { return { currentProjectId: projectId, currentPrincipalId: actor, currentRole: "core_api_service" as const }; }
    private connector(snapshot: Readonly<Record<string, unknown>>, key: string, workerId?: string): ExecutionTargetConnector {
        const connector = this.connectors.get(key);
        if (!connector || connector.targetType !== snapshot.execution_target_type || connector.principalId !== snapshot.principal_id || connector.provider !== snapshot.provider || connector.model !== snapshot.model || workerId !== undefined && workerId !== connector.workerId)
            throw new PostgresRlsError("23514", "Approved target is not enabled with the pinned identity/provider/model");
        if (/codex/i.test(`${connector.provider} ${connector.model}`))
            throw new PostgresRlsError("23514", "ERR_UNMETERED_CODEX_DISABLED: production Codex requires trusted Cost Guard metering");
        return connector;
    }
    public async assign(projectId: string, actor: string, taskId: string, input: AssignExecutionTargetInput): Promise<TaskExecutionAssignmentRecord> {
        strictKeys(input, ["profile_id", "public_context", "data_classification"]);
        validateTargetId(taskId);
        validateTargetId(input.profile_id);
        if (input.data_classification !== "PUBLIC" || typeof input.public_context !== "string" || Buffer.byteLength(input.public_context) > 16384 || redactTelemetryMessage(input.public_context) !== input.public_context)
            throw new PostgresRlsError("23514", "Only reviewed PUBLIC context without detected credentials may be exported");
        return this.store.withRlsTransaction(this.scope(projectId, actor), async () => {
            const task = await this.store.getTaskById(taskId), profile = await this.store.getAgentOrganizationProfileById(input.profile_id);
            if (!task || !profile || task.project_id !== projectId || profile.project_id !== projectId)
                throw new PostgresRlsError("23503", "Target task/profile not found");
            const snapshot = executionProfileSnapshot(profile);
            const connector = this.connector(snapshot, profile.target_locator ?? "");
            const allowed = task.task_contract_json.allowed_files;
            if (!Array.isArray(allowed) || allowed.length < 1 || allowed.length > 256 || allowed.some((p) => typeof p !== "string" || p.length > 512))
                throw new PostgresRlsError("23514", "External target requires bounded allowed_files");
            return this.store.createTaskExecutionAssignment({ assignment_id: randomUUID(), project_id: projectId, task_id: taskId, profile_id: profile.profile_id, profile_snapshot: snapshot, profile_sha256: executionProfileSha(profile), task_contract_sha256: sha256Hex(canonicalizeJson(task.task_contract_json)), target_key: profile.target_locator!, worker_id: connector.workerId, public_context: input.public_context, data_classification: "PUBLIC", approved_by_principal_id: actor });
        });
    }
    private async reconcileReceipt(projectId: string, actor: string, record: TargetDispatchRecord): Promise<TargetDispatchRecord> {
        if (!["SENDING", "UNKNOWN"].includes(record.status))
            return record;
        return this.store.withRlsTransaction(this.scope(projectId, actor), async () => {
            const receipt = await this.store.getCodeImportSubmission(record.lease_id);
            return receipt ? this.store.finishTargetDispatch({ project_id: projectId, lease_id: record.lease_id, status: "IMPORTED", submission_id: receipt.submission_id }) : record;
        });
    }
    public async execute(projectId: string, actor: string, taskId: string, input: {
        readonly execution_request_id: string;
    }, importSubmission: (leaseId: string, epoch: number, submission: CodeImportSubmission) => Promise<CodeImportSubmissionRecord>): Promise<TargetDispatchRecord> {
        this.store.assertOutsideTransaction();
        strictKeys(input, ["execution_request_id"]);
        validateTargetId(taskId);
        validateTargetId(input.execution_request_id);
        const ctx = this.scope(projectId, actor);
        const prepared = await this.store.withRlsTransaction(ctx, async () => {
            const assignment = await this.store.getTaskExecutionAssignment(taskId), task = await this.store.getTaskById(taskId), prior = await this.store.getTargetDispatchByRequest(input.execution_request_id);
            if (!assignment || !task || task.project_id !== projectId)
                throw new PostgresRlsError("23514", "Task requires an approved external execution target");
            if (prior && prior.task_id !== taskId)
                throw new PostgresRlsError("23505", "Execution request belongs to another task");
            return { assignment, task, prior };
        });
        if (prepared.prior && prepared.prior.status !== "PENDING")
            return this.reconcileReceipt(projectId, actor, prepared.prior);
        const connector = this.connector(prepared.assignment.profile_snapshot, prepared.assignment.target_key, prepared.assignment.worker_id);
        let health: {
            readonly health_sha256: string;
        };
        try {
            health = await connector.health(AbortSignal.timeout(Math.min(this.timeoutMs, 5000)));
        }
        catch {
            throw new PostgresRlsError("23514", "Target identity/health/capability checks failed before dispatch");
        }
        const allocate = () => this.store.withRlsTransaction(ctx, async () => {
            const prior = await this.store.getTargetDispatchByRequest(input.execution_request_id);
            if (prior) {
                if (prior.task_id !== taskId)
                    throw new PostgresRlsError("23505", "Execution request belongs to another task");
                const existing = await this.store.getLeaseById(prior.lease_id);
                if (!existing)
                    throw new PostgresRlsError("23503", "Target lease missing");
                return existing;
            }
            return this.store.grantTaskLease({ project_id: projectId, task_id: taskId, worker_id: prepared.assignment.worker_id, execution_target_assignment_id: prepared.assignment.assignment_id, execution_target_request_id: input.execution_request_id, lease_ttl_ms: Math.max(35000, this.timeoutMs + 5000), heartbeat_interval_ms: 10000, reject_overlapping_active_files: true });
        });
        // Concurrent callers may read no intent before waiting for grantTaskLease's
        // project/task locks. Reconcile after the losing transaction rolls back.
        const lease = await allocate().catch(async (error: unknown) => {
            const existing = await this.store.withRlsTransaction(ctx, async () => {
                const prior = await this.store.getTargetDispatchByRequest(input.execution_request_id);
                return prior?.task_id === taskId ? this.store.getLeaseById(prior.lease_id) : null;
            });
            if (existing)
                return existing;
            throw error;
        });
        const claim = await this.store.withRlsTransaction(ctx, () => this.store.claimTargetDispatch(projectId, lease.lease_id, health.health_sha256));
        if (!claim.created)
            return this.reconcileReceipt(projectId, actor, claim.record);
        // A committed SENDING intent precedes the one and only external execute request.
        try {
            const live = await this.store.withRlsTransaction(ctx, async () => ({ task: await this.store.getTaskById(taskId), lease: await this.store.getLeaseById(lease.lease_id), now: await this.store.clockTimestampIso() }));
            if (!live.task || !live.lease || live.lease.status !== "ACTIVE" || live.task.active_lease_id !== lease.lease_id)
                throw new Error("Target lease lost before invocation");
            const remaining = Date.parse(live.lease.expires_at) - Date.parse(live.now);
            if (remaining <= 0)
                throw new Error("Target lease expired");
            if (sha256Hex(canonicalizeJson(live.task.task_contract_json)) !== prepared.assignment.task_contract_sha256)
                throw new Error("Task contract changed before invocation");
            const action: ExternalTargetAction = Object.freeze({ execution_id: lease.lease_id, task_id: taskId, lease_epoch: lease.lease_epoch, base_main_commit_hash: live.task.base_main_commit_hash, deadline: live.lease.expires_at, allowed_files: Object.freeze([...(live.task.task_contract_json.allowed_files as string[])]), public_context: prepared.assignment.public_context });
            const submission = await connector.execute(action, AbortSignal.timeout(Math.min(this.timeoutMs, remaining)));
            const receipt = await importSubmission(lease.lease_id, lease.lease_epoch, submission);
            return await this.store.withRlsTransaction(ctx, () => this.store.finishTargetDispatch({ project_id: projectId, lease_id: lease.lease_id, status: "IMPORTED", submission_id: receipt.submission_id }));
        }
        catch (error) {
            // Receipt proof resolves a lost database acknowledgement; no provider re-dispatch.
            const reconciled = await this.reconcileReceipt(projectId, actor, claim.record);
            if (reconciled.status === "IMPORTED")
                return reconciled;
            return this.store.withRlsTransaction(ctx, () => this.store.finishTargetDispatch({ project_id: projectId, lease_id: lease.lease_id, status: error instanceof CodeImportError ? "REJECTED" : "UNKNOWN", error_code: error instanceof CodeImportError ? "ERR_TARGET_IMPORT_REJECTED" : "ERR_TARGET_UNCERTAIN" }));
        }
    }
}
