import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { validateNativeWorkerAttestation, type NativeWorkerAttestation, signTargetProtocol, type ExternalTargetAction } from "@software-factory/adapter-sdk";
import { canonicalizeJson } from "@software-factory/shared-types";
import { isSafeRelativePosixPath, validateCodeImportSubmission, type CodeImportSubmission } from "@software-factory/task-contract";
import { WorkerExecutionJournal, WorkerJournalConflict } from "./worker-execution-journal.ts";
import type { SandboxCleanupEvidence } from "./index.ts";
import { LinuxWorkerEndpointRunner } from "./worker-endpoint-runner.ts";

export interface WorkerEndpointRunner {
  health(signal: AbortSignal): Promise<void>;
  execute(action: Readonly<ExternalTargetAction>, signal: AbortSignal): Promise<{ submission: CodeImportSubmission; cleanupEvidence: SandboxCleanupEvidence }>;
}
export type WorkerEndpointHook = "beforeJournalClaim" | "afterJournalClaim" | "beforeRunnerSpawn" | "afterRunnerCompletion" | "beforeTerminalPersist" | "afterTerminalPersist";
export interface WorkerEndpointServerConfig {
  readonly tenantNamespace: string;
  readonly principalId: string;
  readonly workerId: string;
  readonly provider: string;
  readonly model: string;
  readonly signingSecret: string;
  readonly stateDir: string;
  readonly runner: WorkerEndpointRunner;
  /** Measured by native guest bootstrap, signed as part of health only. */
  readonly runtimeAttestation?: NativeWorkerAttestation;
  readonly port?: number;
  /** Loopback listener behind an operator-controlled TLS proxy. No public binding option. */
  readonly host?: "127.0.0.1" | "::1";
  /** Constructor-only protocol emulator. No HTTP/env switch. */
  readonly testOnlyEmulator?: boolean;
  readonly testOnlyHooks?: Partial<Record<WorkerEndpointHook, (action: ExternalTargetAction) => void | Promise<void>>>;
}
function strictObject(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !fields.includes(key)) || Object.keys(raw).length !== fields.length) throw new Error("Invalid worker request fields");
  return raw as Record<string, unknown>;
}
function uuid(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value); }
export function validateWorkerAction(raw: unknown): ExternalTargetAction {
  const value = strictObject(raw, ["execution_id", "task_id", "lease_epoch", "base_main_commit_hash", "deadline", "allowed_files", "public_context"]);
  if (!uuid(value.execution_id) || !uuid(value.task_id) || !Number.isSafeInteger(value.lease_epoch) || Number(value.lease_epoch) < 1 || typeof value.base_main_commit_hash !== "string" || !/^[a-f0-9]{40}$/.test(value.base_main_commit_hash)
    || typeof value.deadline !== "string" || !Number.isFinite(Date.parse(value.deadline)) || new Date(value.deadline).toISOString() !== value.deadline
    || typeof value.public_context !== "string" || Buffer.byteLength(value.public_context) > 16384 || !Array.isArray(value.allowed_files) || value.allowed_files.length < 1 || value.allowed_files.length > 256
    || value.allowed_files.some((p) => typeof p !== "string" || p.length > 512 || !isSafeRelativePosixPath(p))) throw new Error("Invalid worker execution action");
  return Object.freeze({ ...value, allowed_files: Object.freeze([...value.allowed_files]) }) as unknown as ExternalTargetAction;
}
export function assertWorkerCleanup(evidence: SandboxCleanupEvidence, action: ExternalTargetAction, testOnlyEmulator = false): void {
  if (!evidence || evidence.taskId !== action.execution_id || evidence.leaseEpoch !== action.lease_epoch || evidence.remainingProcsCount !== 0) throw new Error("Worker cleanup identity/evidence mismatch");
  if (!testOnlyEmulator && (evidence.isSimulated || !evidence.realKernelOperationsExecuted || evidence.backendMode !== "linux-cgroup-v2" || !evidence.populatedZeroVerified || !evidence.cgroupDirRemoved || !evidence.cgroupKillWritten || !evidence.freezeApplied)) throw new Error("Verified kernel cleanup required before worker success");
}
export class WorkerEndpointServer {
  private readonly server: Server;
  private readonly journal: WorkerExecutionJournal;
  private readonly config: WorkerEndpointServerConfig;
  private readonly active = new Set<AbortController>();
  private readonly pending = new Set<Promise<void>>();
  constructor(config: WorkerEndpointServerConfig) {
    if (![config.tenantNamespace, config.principalId, config.workerId].every((s) => typeof s === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(s)) || ![config.provider, config.model].every((s) => typeof s === "string" && s.length > 0 && s.length <= 128) || typeof config.signingSecret !== "string" || Buffer.byteLength(config.signingSecret) < 32) throw new Error("Invalid worker identity/key configuration");
    if (/codex/i.test(`${config.provider} ${config.model}`)) throw new Error("ERR_UNMETERED_CODEX_DISABLED");
    if (config.host !== undefined && !["127.0.0.1", "::1"].includes(config.host) || config.port !== undefined && (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535)) throw new Error("Worker endpoint requires loopback binding");
    if (config.testOnlyHooks && config.testOnlyEmulator !== true) throw new Error("Fault injection requires explicit test-only configuration");
    if (!config.testOnlyEmulator && !(config.runner instanceof LinuxWorkerEndpointRunner)) throw new Error("Production worker endpoint requires the strict Linux runner");
    this.config = { ...config, ...(config.runtimeAttestation === undefined ? {} : { runtimeAttestation: validateNativeWorkerAttestation(config.runtimeAttestation) }) }; this.journal = new WorkerExecutionJournal(config.stateDir, config.tenantNamespace);
    this.server = createServer((req, res) => {
      res.on("error", () => {});
      const work = this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }); if (!res.writableEnded) res.end('{"error":"ERR_WORKER_REQUEST"}'); });
      this.pending.add(work); void work.finally(() => this.pending.delete(work));
    });
    this.server.requestTimeout = 10000; this.server.headersTimeout = 5000; this.server.maxHeadersCount = 32;
  }
  public async listen(): Promise<{ port: number; endpoint: string }> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.config.port ?? 0, this.config.host ?? "127.0.0.1", () => { this.server.off("error", reject); resolve(); }); });
    const address = this.server.address(); if (!address || typeof address === "string") throw new Error("Invalid worker listener");
    return { port: address.port, endpoint: `http://${address.family === "IPv6" ? "[::1]" : "127.0.0.1"}:${address.port}` };
  }
  public async close(): Promise<void> {
    // Stop accepting connections before awaiting cleanup, including during concurrent shutdown calls.
    const closed = this.server.listening ? new Promise<void>((resolve, reject) => this.server.close((err) => err ? reject(err) : resolve())) : Promise.resolve();
    for (const controller of this.active) controller.abort();
    this.server.closeAllConnections();
    await Promise.allSettled([...this.pending]);
    await closed;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || !["/health", "/execute"].includes(req.url ?? "") || !/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] ?? ""))) { res.writeHead(404); res.end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > (req.url === "/health" ? 16384 : 192 * 1024)) throw new Error("Worker request too large"); chunks.push(Buffer.from(chunk)); }
    const body = strictObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), ["schema_version", "nonce", "action"]);
    if (body.schema_version !== "sf-target-v1" || typeof body.nonce !== "string" || !/^[a-f0-9]{48}$/.test(body.nonce)) throw new Error("Invalid worker nonce");
    const signature = req.headers["x-sf-target-signature"];
    if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signTargetProtocol(this.config.signingSecret, "request", req.url!, body.nonce, body), "hex"))) { res.writeHead(401); res.end(); return; }
    const identity = { schema_version: "sf-target-v1", nonce: body.nonce, target_type: "user_managed_worker", principal_id: this.config.principalId, worker_id: this.config.workerId, provider: this.config.provider, model: this.config.model };
    const send = (payload: unknown) => { const data = canonicalizeJson(payload); if (Buffer.byteLength(data) > 3 * 1024 * 1024) throw new Error("Worker response too large"); res.writeHead(200, { "content-type": "application/json", "x-sf-target-signature": signTargetProtocol(this.config.signingSecret, "response", req.url!, body.nonce as string, payload) }); res.end(data); };
    if (this.active.size >= 8) { res.writeHead(503); res.end(); return; }
    const controller = new AbortController(); this.active.add(controller);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", disconnected);
    try {
      if (req.url === "/health") { strictObject(body.action, []); await this.config.runner.health(AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])); send({ ...identity, ...(this.config.runtimeAttestation ? {runtime_attestation:this.config.runtimeAttestation} : {}), capabilities: ["code-import-v1", "idempotent-execution", "lease-fenced-results"] }); return; }
      const action = validateWorkerAction(body.action);
      if (req.headers["idempotency-key"] !== action.execution_id) throw new Error("Idempotency key mismatch");
      const existing = this.journal.read(action);
      if (existing?.status === "COMPLETED") { assertWorkerCleanup(existing.cleanupEvidence!, action, this.config.testOnlyEmulator); send({ ...identity, execution_id: action.execution_id, lease_epoch: action.lease_epoch, submission: existing.submission }); return; }
      // A durable claim remains HOLD regardless of current kernel health or an elapsed deadline.
      if (existing) throw new WorkerJournalConflict("HOLD");
      const remaining = Date.parse(action.deadline) - Date.now();
      if (remaining <= 0 || remaining > 125000 || controller.signal.aborted) throw new Error("Worker deadline rejected");
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
      await this.config.runner.health(signal); signal.throwIfAborted();
      await this.config.testOnlyHooks?.beforeJournalClaim?.(action);
      const claim = this.journal.claim(action);
      if (!claim.created) {
        if (claim.record.status !== "COMPLETED") throw new WorkerJournalConflict("HOLD");
        assertWorkerCleanup(claim.record.cleanupEvidence!, action, this.config.testOnlyEmulator); send({ ...identity, execution_id: action.execution_id, lease_epoch: action.lease_epoch, submission: claim.record.submission }); return;
      }
      await this.config.testOnlyHooks?.afterJournalClaim?.(action);
      await this.config.testOnlyHooks?.beforeRunnerSpawn?.(action);
      signal.throwIfAborted();
      const result = await this.config.runner.execute(action, signal);
      await this.config.testOnlyHooks?.afterRunnerCompletion?.(action);
      signal.throwIfAborted(); assertWorkerCleanup(result.cleanupEvidence, action, this.config.testOnlyEmulator);
      const submission = validateCodeImportSubmission(result.submission);
      await this.config.testOnlyHooks?.beforeTerminalPersist?.(action);
      this.journal.complete(action, submission, result.cleanupEvidence);
      await this.config.testOnlyHooks?.afterTerminalPersist?.(action);
      send({ ...identity, execution_id: action.execution_id, lease_epoch: action.lease_epoch, submission });
    } catch (error) { if (error instanceof WorkerJournalConflict && !res.headersSent) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `ERR_WORKER_${error.kind}` })); return; } throw error; }
    finally { res.off("close", disconnected); this.active.delete(controller); }
  }
}
export function createWorkerEndpointServer(config: WorkerEndpointServerConfig): WorkerEndpointServer { return new WorkerEndpointServer(config); }
