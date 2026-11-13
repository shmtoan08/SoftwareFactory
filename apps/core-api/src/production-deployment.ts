import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { canonicalizeJson, sha256Hex, type ProductionDeploymentApprovalRecord, type ProductionDeploymentRecord } from "@software-factory/shared-types";
import { PostgresRlsError, type ControlPlaneStore } from "@software-factory/database";

export interface ProductionDeploymentAction {
  readonly deployment_id: string;
  readonly project_id: string;
  readonly release_id: string;
  readonly release_package_sha256: string;
  readonly commit_hash: string;
  readonly artifact_sha256: string;
  readonly target_key: string;
}
/** Operator-injected executor must deploy the exact digest and use deployment_id as its idempotency key. */
export type ProductionDeploymentExecutor = (action: Readonly<ProductionDeploymentAction>, signal: AbortSignal) => Promise<{ readonly receipt_sha256: string }>;
export interface ProductionDeploymentConfiguration {
  readonly signingSecret?: string;
  readonly executors?: Readonly<Record<string, ProductionDeploymentExecutor>>;
  readonly timeoutMs?: number;
}
export interface ApproveProductionDeploymentInput {
  readonly pipeline_session_id: string;
  readonly release_id: string;
  readonly artifact_sha256: string;
  readonly target_key: string;
  readonly ttl_ms?: number;
}
export interface ExecuteProductionDeploymentInput {
  readonly approval_id: string;
  readonly approval_token: string;
}

export function validateDeploymentConfiguration(config: ProductionDeploymentConfiguration): void {
  if (config.signingSecret !== undefined && Buffer.byteLength(config.signingSecret) < 32) throw new Error("Production approval signing secret must contain at least 32 bytes");
  const entries = Object.entries(config.executors ?? {});
  if (entries.length && !config.signingSecret) throw new Error("Production executors require an explicit approval signing secret");
  if (entries.some(([key, executor]) => !/^[a-z][a-z0-9-]{0,63}$/.test(key) || typeof executor !== "function")) throw new Error("Invalid production executor registry");
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120_000)) throw new Error("Production executor timeout must be 1..120000 ms");
}
export function validateProductionId(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new PostgresRlsError("23514", "Production identifiers must be canonical UUIDs");
}
function strictKeys(value: object, keys: readonly string[]): void {
  if (!value || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new PostgresRlsError("23514", "Unknown production deployment request fields");
}
function signedPayload(approval: ProductionDeploymentApprovalRecord): string {
  const { status: _status, token_sha256: _hash, ...binding } = approval;
  return Buffer.from(canonicalizeJson({ purpose: "sf-production-deployment-v1", ...binding })).toString("base64url");
}

export class ProductionDeploymentGate {
  private readonly executors: Map<string, ProductionDeploymentExecutor>;
  private readonly secret?: string;
  private readonly timeoutMs: number;
  private readonly store: ControlPlaneStore;
  constructor(store: ControlPlaneStore, config: ProductionDeploymentConfiguration = {}) {
    this.store = store; validateDeploymentConfiguration(config); this.secret = config.signingSecret;
    this.executors = new Map(Object.entries(config.executors ?? {})); this.timeoutMs = config.timeoutMs ?? 30_000;
  }
  private sign(payload: string): string {
    if (!this.secret) throw new PostgresRlsError("42501", "Production deployment gate is disabled");
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }
  private requireTarget(key: string): ProductionDeploymentExecutor {
    const executor = this.executors.get(key);
    if (!this.secret || !executor) throw new PostgresRlsError("42501", "Production deployment target is not enabled by the operator");
    return executor;
  }
  private async assertRelease(projectId: string, pipelineId: string, releaseId: string) {
    const release = (await this.store.listReleaseAcceptancePackages(pipelineId)).find((r) => r.release_id === releaseId);
    const project = await this.store.getProjectById(projectId);
    if (!release || !project || release.project_id !== projectId || !release.complete || release.coverage_percent !== 100) throw new PostgresRlsError("23503", "Accepted production release not found");
    // Read real Git, never the caller's or cached database main hash alone.
    const head = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "rev-parse", "--verify", "refs/heads/main^{commit}"], {
      cwd: project.repo_bare_path, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" }, stdio: "pipe", timeout: 5_000,
    }).toString().trim();
    if (head !== release.main_head_commit_hash || project.main_ref_commit_hash !== head) throw new PostgresRlsError("23514", "Production release is stale against live main");
    return release;
  }
  public async approve(projectId: string, actor: string, input: ApproveProductionDeploymentInput) {
    strictKeys(input,["pipeline_session_id","release_id","artifact_sha256","target_key","ttl_ms"]);
    validateProductionId(input.pipeline_session_id); validateProductionId(input.release_id);
    this.requireTarget(input.target_key);
    const ttl = input.ttl_ms ?? 900_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 3_600_000 || typeof input.artifact_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.artifact_sha256)) throw new PostgresRlsError("23514", "Invalid production artifact or approval lifetime");
    return this.store.withRlsTransaction({ currentProjectId: projectId, currentPrincipalId: actor, currentRole: "core_api_service" }, async () => {
      const release = await this.assertRelease(projectId,input.pipeline_session_id,input.release_id);
      const now = new Date(await this.store.clockTimestampIso());
      const approval: ProductionDeploymentApprovalRecord = { approval_id: randomUUID(), project_id: projectId, pipeline_session_id: input.pipeline_session_id,
        release_id: release.release_id, release_package_sha256: release.package_sha256, commit_hash: release.main_head_commit_hash,
        artifact_sha256: input.artifact_sha256, target_key: input.target_key, approver_principal_id: actor,
        issued_at: now.toISOString(), expires_at: new Date(now.getTime()+ttl).toISOString(), token_sha256: "", status: "ACTIVE" };
      const payload = signedPayload(approval); const token = `${payload}.${this.sign(payload)}`;
      const stored = await this.store.createProductionDeploymentApproval({ ...approval, token_sha256: sha256Hex(token) });
      return { approval: stored, approval_token: token };
    });
  }
  public async execute(projectId: string, actor: string, input: ExecuteProductionDeploymentInput): Promise<ProductionDeploymentRecord> {
    this.store.assertOutsideTransaction();
    strictKeys(input,["approval_id","approval_token"]);
    validateProductionId(input.approval_id);
    const token = input.approval_token;
    if (typeof token !== "string" || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) throw new PostgresRlsError("42501", "Invalid production approval signature");
    const [payload, mac] = token.split(".") as [string,string];
    if (!timingSafeEqual(Buffer.from(this.sign(payload),"hex"),Buffer.from(mac,"hex"))) throw new PostgresRlsError("42501", "Invalid production approval signature");
    const claim = await this.store.withRlsTransaction({ currentProjectId: projectId, currentPrincipalId: actor, currentRole: "core_api_service" }, async () => {
      const approval = await this.store.getProductionDeploymentApproval(input.approval_id);
      if (!approval || signedPayload(approval) !== payload || approval.token_sha256 !== sha256Hex(token)) throw new PostgresRlsError("42501", "Production approval binding mismatch");
      this.requireTarget(approval.target_key);
      await this.assertRelease(projectId,approval.pipeline_session_id,approval.release_id);
      return { approval, ...await this.store.beginProductionDeployment({ project_id: projectId, approval_id: approval.approval_id, token_sha256: sha256Hex(token), requested_by_principal_id: actor }) };
    });
    if (!claim.created) return claim.record;
    // The claim transaction has COMMITTED before any external effect is possible.
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let receipt: string | null = null;
    try {
      const remaining = Date.parse(claim.approval.expires_at) - Date.parse(await this.store.clockTimestampIso());
      if (remaining <= 0) throw new Error("Approval expired after claim");
      const action = Object.freeze({ deployment_id: claim.record.deployment_id, project_id: projectId, release_id: claim.approval.release_id,
        release_package_sha256: claim.approval.release_package_sha256, commit_hash: claim.approval.commit_hash,
        artifact_sha256: claim.approval.artifact_sha256, target_key: claim.approval.target_key });
      const result = await Promise.race([
        this.requireTarget(action.target_key)(action,controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Deployment outcome unknown after timeout")); },Math.min(this.timeoutMs,remaining)); }),
      ]);
      if (!/^[a-f0-9]{64}$/.test(result.receipt_sha256)) throw new Error("Invalid deployment receipt");
      receipt = result.receipt_sha256;
    } catch { controller.abort(); /* No raw executor errors or credentials enter audit or HTTP responses. */ }
    finally { if (timer) clearTimeout(timer); }
    return this.store.withRlsTransaction({ currentProjectId: projectId, currentPrincipalId: actor, currentRole: "core_api_service" }, () =>
      this.store.completeProductionDeployment({ project_id: projectId, deployment_id: claim.record.deployment_id, status: receipt ? "SUCCEEDED" : "UNKNOWN", receipt_sha256: receipt }));
  }
}
