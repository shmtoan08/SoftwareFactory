import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalizeJson, sha256Hex, type ExecutionTargetType } from "@software-factory/shared-types";
import { validateCodeImportSubmission, type CodeImportSubmission } from "@software-factory/task-contract";
export type ExternalExecutionTargetType = Exclude<ExecutionTargetType, "factory_managed_worker">;
export interface ExternalTargetAction {
    readonly execution_id: string;
    readonly task_id: string;
    readonly lease_epoch: number;
    readonly base_main_commit_hash: string;
    readonly deadline: string;
    readonly allowed_files: readonly string[];
    readonly public_context: string;
}
export interface ExecutionTargetConnector {
    readonly targetType: ExternalExecutionTargetType;
    readonly principalId: string;
    readonly workerId: string;
    readonly provider: string;
    readonly model: string;
    health(signal: AbortSignal): Promise<{
        readonly health_sha256: string;
    }>;
    execute(action: Readonly<ExternalTargetAction>, signal: AbortSignal): Promise<CodeImportSubmission>;
}
export interface HttpExecutionTargetOptions {
    readonly endpoint: string;
    readonly signingSecret: string;
    readonly principalId: string;
    readonly workerId: string;
    readonly provider: string;
    readonly model: string;
    /** Explicit local protocol emulator only, never selected through user/environment input. */
    readonly testOnlyLoopback?: boolean;
}
/** Dedicated endpoint key, never a Factory auth/DB/WNA/Git credential. */
export function signTargetProtocol(secret: string, direction: "request" | "response", path: string, nonce: string, body: unknown): string {
    return createHmac("sha256", secret).update(`sf-target-http-v1\n${direction}\n${path}\n${nonce}\n${sha256Hex(canonicalizeJson(body))}`).digest("hex");
}
export class HttpExecutionTargetConnector implements ExecutionTargetConnector {
    public readonly targetType: ExternalExecutionTargetType;
    public readonly principalId: string;
    public readonly workerId: string;
    public readonly provider: string;
    public readonly model: string;
    private readonly endpoint: URL;
    private readonly secret: string;
    constructor(type: ExternalExecutionTargetType, options: HttpExecutionTargetOptions) {
        if (!["user_managed_worker", "provider_managed_vm", "remote_agent_session"].includes(type))
            throw new Error("Unsupported external target type");
        const url = new URL(options.endpoint);
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(options.testOnlyLoopback === true && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
            throw new Error("Execution target requires HTTPS and an operator-controlled endpoint");
        if (Buffer.byteLength(options.signingSecret) < 32 || ![options.principalId, options.workerId].every((v) => /^[A-Za-z0-9._:-]{1,128}$/.test(v)) || ![options.provider, options.model].every((v) => typeof v === "string" && v.length > 0 && v.length <= 128))
            throw new Error("Invalid execution target identity/key");
        if (/codex/i.test(`${options.provider} ${options.model}`))
            throw new Error("ERR_UNMETERED_CODEX_DISABLED: production Codex requires trusted Cost Guard metering");
        if (!url.pathname.endsWith("/"))
            url.pathname += "/";
        this.endpoint = url;
        this.secret = options.signingSecret;
        this.targetType = type;
        this.principalId = options.principalId;
        this.workerId = options.workerId;
        this.provider = options.provider;
        this.model = options.model;
    }
    private async call(route: "health" | "execute", action: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
        const url = new URL(route, this.endpoint);
        const nonce = randomBytes(24).toString("hex");
        const body = { schema_version: "sf-target-v1", nonce, action };
        try {
            const response = await fetch(url, { method: "POST", redirect: "error", credentials: "omit", signal, headers: { "content-type": "application/json", "x-sf-target-signature": signTargetProtocol(this.secret, "request", url.pathname, nonce, body), ...(route === "execute" ? { "idempotency-key": (action as ExternalTargetAction).execution_id } : {}) }, body: JSON.stringify(body) });
            if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? ""))
                throw new Error("Target unavailable");
            const reader = response.body?.getReader();
            if (!reader)
                throw new Error("Empty target response");
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                while (true) {
                    const part = await reader.read();
                    if (part.done)
                        break;
                    size += part.value.length;
                    if (size > (route === "health" ? 16384 : 3 * 1024 * 1024))
                        throw new Error("Target response limit");
                    chunks.push(part.value);
                }
            }
            finally {
                await reader.cancel().catch(() => { });
            }
            const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("Invalid target response");
            const result = parsed as Record<string, unknown>;
            const mac = response.headers.get("x-sf-target-signature") ?? "";
            if (!/^[a-f0-9]{64}$/.test(mac) || !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(signTargetProtocol(this.secret, "response", url.pathname, nonce, result), "hex"))
                || result.schema_version !== "sf-target-v1" || result.nonce !== nonce || result.target_type !== this.targetType || result.principal_id !== this.principalId || result.worker_id !== this.workerId || result.provider !== this.provider || result.model !== this.model)
                throw new Error("Invalid target identity/signature");
            const common = ["schema_version", "nonce", "target_type", "principal_id", "worker_id", "provider", "model"];
            const permitted = [...common, ...(route === "health" ? ["capabilities"] : ["execution_id", "lease_epoch", "submission"])];
            if (Object.keys(result).some((key) => !permitted.includes(key)))
                throw new Error("Unknown target response fields");
            return result;
        }
        catch {
            throw new Error("ERR_TARGET_PROTOCOL: target identity, transport or response validation failed");
        }
    }
    public async health(signal: AbortSignal): Promise<{
        health_sha256: string;
    }> {
        const result = await this.call("health", {}, signal);
        const capabilities = result.capabilities;
        if (!Array.isArray(capabilities) || capabilities.length > 16 || capabilities.some((v) => typeof v !== "string" || v.length > 64) || !["code-import-v1", "idempotent-execution", "lease-fenced-results"].every((v) => capabilities.includes(v)))
            throw new Error("ERR_TARGET_CAPABILITIES: controlled-import/idempotency/fencing capability required");
        return { health_sha256: sha256Hex(canonicalizeJson(result)) };
    }
    public async execute(action: Readonly<ExternalTargetAction>, signal: AbortSignal): Promise<CodeImportSubmission> {
        const result = await this.call("execute", action, signal);
        if (result.execution_id !== action.execution_id || result.lease_epoch !== action.lease_epoch)
            throw new Error("ERR_TARGET_BINDING: execution result does not match lease");
        return validateCodeImportSubmission(result.submission);
    }
}
export class UserManagedWorkerHttpConnector extends HttpExecutionTargetConnector {
    constructor(options: HttpExecutionTargetOptions) { super("user_managed_worker", options); }
}
export class ProviderVmHttpConnector extends HttpExecutionTargetConnector {
    constructor(options: HttpExecutionTargetOptions) { super("provider_managed_vm", options); }
}
export class RemoteSessionHttpConnector extends HttpExecutionTargetConnector {
    constructor(options: HttpExecutionTargetOptions) { super("remote_agent_session", options); }
}
