import { createHmac, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export interface CallObservationContext {
  readonly projectId: string;
  readonly costSessionId: string;
  readonly taskId: string | null;
  readonly pipelineSessionId: string | null;
  readonly provider: "anthropic" | "google" | "openai";
  readonly model: string;
  readonly promptId: string;
  readonly promptVersion: string;
  /** Internal render fingerprint; never copied into an event. */
  readonly promptSha256: string;
}
export interface CallObservationHandle { readonly invocationId: string }
export type CallTelemetryEvent = Readonly<
  | { kind: "register"; invocationId: string; projectId: string; costSessionId: string;
      taskId: string | null; pipelineSessionId: string | null; provider: string; model: string;
      promptId: string; promptVersion: string; promptHmac: string; keyVersion: string;
      bindingState: "CALL_ONLY"; mappingId: "UNVERIFIED" }
  | { kind: "usage"; invocationId: string; projectId: string; revision: 1;
      observationKind: "USAGE" | "FAILURE"; numericUsage: Readonly<Record<string, string>>;
      canonicalStatus: "unavailable"; normalizedError: "usage-missing" | "provider-rejected" | null }
  | { kind: "ledger_candidate"; invocationId: string; projectId: string; ledgerCallId: string }
>;
export interface CallTelemetryOptions {
  readonly projectId: string;
  readonly environment: string;
  readonly keyVersion: string;
  readonly hmacKey: Uint8Array;
  /** Private async transport only. No runtime/database transport is installed by default. */
  readonly deliver: (events: readonly CallTelemetryEvent[], signal: AbortSignal) => Promise<void>;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
  readonly deliveryTimeoutMs?: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = {
  anthropic: ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"],
  google: ["promptTokenCount", "candidatesTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount"],
  openai: [],
} as const;
function bounded(value: string): boolean { return typeof value === "string" && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= 128; }
/** Candidate syntax only; no provider accounting or canonical mapping is asserted. */
export function sanitizeCandidateUsage(provider: keyof typeof KEYS, raw: unknown): Readonly<Record<string, string>> | null {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.length > KEYS[provider].length) return null;
    const result: Record<string, string> = {};
    for (const key of keys) {
      if (typeof key !== "string" || !(KEYS[provider] as readonly string[]).includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor || !("value" in descriptor)) return null;
      const value: unknown = descriptor.value;
      const decimal = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? String(value) : typeof value === "string" ? value : "";
      if (!/^(0|[1-9][0-9]{0,29})$/.test(decimal)) return null;
      result[key] = decimal;
    }
    return Object.freeze(result);
  } catch { return null; }
}
interface Pending { readonly event: CallTelemetryEvent; readonly bytes: number; readonly deadline: number }
/** Bounded best-effort CALL_ONLY observer. It never calls provider/Cost Guard APIs. */
export class CallTelemetryObserver {
  readonly #project: string;
  readonly #environment: string;
  readonly #keyVersion: string;
  readonly #key: Buffer;
  readonly #deliver: CallTelemetryOptions["deliver"];
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #timeout: number;
  readonly #handles = new WeakMap<CallObservationHandle, Pick<CallObservationContext, "projectId" | "provider">>();
  #queue: Pending[] = [];
  #flight: Pending[] = [];
  #bytes = 0;
  #enabled = true;
  #scheduled = false;
  #controller: AbortController | null = null;
  #delivered = 0;
  #dropped = 0;
  #failures = 0;
  constructor(options: CallTelemetryOptions) {
    this.#maxEvents = options.maxEvents ?? 1024;
    this.#maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.#timeout = options.deliveryTimeoutMs ?? 1000;
    if (!UUID.test(options.projectId) || !bounded(options.environment) || !bounded(options.keyVersion)
      || options.hmacKey.byteLength < 32 || options.hmacKey.byteLength > 128
      || typeof options.deliver !== "function" || !Number.isInteger(this.#maxEvents) || this.#maxEvents < 1 || this.#maxEvents > 1024
      || !Number.isInteger(this.#maxBytes) || this.#maxBytes < 1 || this.#maxBytes > 16 * 1024 * 1024
      || !Number.isInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 60_000) throw new Error("Invalid telemetry configuration");
    this.#project = options.projectId; this.#environment = options.environment; this.#keyVersion = options.keyVersion;
    this.#key = Buffer.from(options.hmacKey); this.#deliver = options.deliver;
  }
  public begin(context: CallObservationContext): CallObservationHandle | null {
    try {
      if (!this.#enabled) return null;
      if (context.projectId !== this.#project || !UUID.test(context.costSessionId)
        || (context.taskId !== null && !UUID.test(context.taskId)) || (context.pipelineSessionId !== null && !UUID.test(context.pipelineSessionId))
        || !Object.hasOwn(KEYS, context.provider) || ![context.model, context.promptId, context.promptVersion].every(bounded)
        || !/^[a-f0-9]{64}$/.test(context.promptSha256)) { this.#dropped++; return null; }
      const invocationId = randomUUID();
      const promptHmac = createHmac("sha256", this.#key).update(JSON.stringify([
        "sf-telemetry-template-v1", this.#environment, context.projectId, this.#keyVersion,
        context.promptId, context.promptVersion, context.promptSha256,
      ])).digest("hex");
      if (!this.#enqueue(Object.freeze({ kind: "register", invocationId, projectId: context.projectId,
        costSessionId: context.costSessionId, taskId: context.taskId, pipelineSessionId: context.pipelineSessionId,
        provider: context.provider, model: context.model, promptId: context.promptId, promptVersion: context.promptVersion,
        promptHmac, keyVersion: this.#keyVersion, bindingState: "CALL_ONLY", mappingId: "UNVERIFIED" }))) return null;
      const handle = Object.freeze({ invocationId });
      // Retain only sanitized scope/provider, not the original template fingerprint.
      this.#handles.set(handle, Object.freeze({ projectId: context.projectId, provider: context.provider }));
      return handle;
    } catch { this.#dropped++; return null; }
  }
  public usage(handle: CallObservationHandle, raw: unknown): void {
    const context = this.#handles.get(handle);
    if (!context) return;
    const numericUsage = sanitizeCandidateUsage(context.provider, raw);
    this.#enqueue(Object.freeze({ kind: "usage", invocationId: handle.invocationId, projectId: context.projectId,
      revision: 1, observationKind: "USAGE", numericUsage: numericUsage ?? Object.freeze({}),
      canonicalStatus: "unavailable", normalizedError: numericUsage ? null : "usage-missing" }));
  }
  public failure(handle: CallObservationHandle): void {
    const context = this.#handles.get(handle);
    if (context) this.#enqueue(Object.freeze({ kind: "usage", invocationId: handle.invocationId, projectId: context.projectId,
      revision: 1, observationKind: "FAILURE", numericUsage: Object.freeze({}), canonicalStatus: "unavailable", normalizedError: "provider-rejected" }));
  }
  public ledgerCandidate(handle: CallObservationHandle, ledgerCallId: string): void {
    const context = this.#handles.get(handle);
    if (!context) return;
    if (!UUID.test(ledgerCallId)) { this.#dropped++; return; }
    this.#enqueue(Object.freeze({ kind: "ledger_candidate", invocationId: handle.invocationId, projectId: context.projectId, ledgerCallId }));
  }
  public stop(): void {
    this.#enabled = false; this.#key.fill(0);
    for (const item of this.#queue) { this.#bytes -= item.bytes; this.#dropped++; }
    this.#queue = []; this.#controller?.abort();
  }
  public stats(): Readonly<{ enabled: boolean; pending: number; bytes: number; delivered: number; dropped: number; failures: number }> {
    return Object.freeze({ enabled: this.#enabled, pending: this.#queue.length + this.#flight.length, bytes: this.#bytes,
      delivered: this.#delivered, dropped: this.#dropped, failures: this.#failures });
  }
  #enqueue(event: CallTelemetryEvent): boolean {
    if (!this.#enabled) { this.#dropped++; return false; }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > 16 * 1024 || this.#queue.length + this.#flight.length >= this.#maxEvents || this.#bytes + bytes > this.#maxBytes) { this.#dropped++; return false; }
    this.#queue.push({ event, bytes, deadline: performance.now() + 60_000 }); this.#bytes += bytes; this.#schedule(); return true;
  }
  #schedule(): void {
    if (!this.#enabled || this.#scheduled || this.#flight.length || !this.#queue.length) return;
    this.#scheduled = true;
    setImmediate(() => { this.#scheduled = false; this.#pump(); }).unref();
  }
  #pump(): void {
    if (!this.#enabled || this.#flight.length) return;
    while (this.#queue[0] && this.#queue[0].deadline <= performance.now()) {
      const expired = this.#queue.shift()!; this.#bytes -= expired.bytes; this.#dropped++;
    }
    if (!this.#queue.length) return;
    this.#flight = this.#queue.splice(0, 100);
    const controller = new AbortController(); this.#controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true; this.#failures++; this.#dropped += this.#flight.length;
      // A transport ignoring abort cannot cause repeated concurrent hanging attempts.
      this.stop();
    }, Math.max(1, Math.min(this.#timeout, this.#flight[0]!.deadline - performance.now()))).unref();
    Promise.resolve().then(() => this.#deliver(Object.freeze(this.#flight.map(item => item.event)), controller.signal))
      .then(() => { if (!timedOut && this.#enabled) this.#delivered += this.#flight.length;
        else if (!timedOut) this.#dropped += this.#flight.length; }, () => { if (!timedOut) { this.#failures++; this.#dropped += this.#flight.length; } })
      .finally(() => {
        clearTimeout(timer);
        for (const item of this.#flight) this.#bytes -= item.bytes;
        this.#flight = []; this.#controller = null; this.#schedule();
      });
  }
}
