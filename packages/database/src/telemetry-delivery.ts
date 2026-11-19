import { withTelemetryServiceTransaction, type PostgresPoolConfig } from "./postgres-pool.ts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO = "00000000-0000-0000-0000-000000000000";
const COUNTERS = new Set(["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "promptTokenCount", "candidatesTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount"]);
function invalid(): never { throw new Error("Invalid telemetry delivery"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function id(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) return invalid(); return value; }
function label(value: unknown): string { if (typeof value !== "string" || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 128) return invalid(); return value; }
function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) invalid();
}
interface Statement { sql: string; params: readonly unknown[] }
function statement(raw: unknown, project: string): Statement {
  const e = record(raw);
  if (e.projectId !== project) return invalid();
  const invocation = id(e.invocationId);
  switch (e.kind) {
    case "register": {
      exact(e, ["kind","invocationId","projectId","costSessionId","taskId","pipelineSessionId","provider","model","promptId","promptVersion","promptHmac","keyVersion","bindingState","mappingId"]);
      if (e.bindingState !== "CALL_ONLY" || e.mappingId !== "UNVERIFIED" || (typeof e.provider !== "string" || !["anthropic","google","openai"].includes(e.provider))
        || typeof e.promptHmac !== "string" || !/^[a-f0-9]{64}$/.test(e.promptHmac)) return invalid();
      return { sql: "SELECT telemetry.register_call($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::text);",
        params: [invocation,project,id(e.costSessionId),e.taskId === null ? null : id(e.taskId),e.pipelineSessionId === null ? null : id(e.pipelineSessionId),
          e.provider,label(e.model),label(e.promptId),label(e.promptVersion),e.promptHmac,label(e.keyVersion),"UNVERIFIED"] };
    }
    case "usage": {
      exact(e, ["kind","invocationId","projectId","revision","observationKind","numericUsage","canonicalStatus","normalizedError"]);
      if (e.revision !== 1 || e.canonicalStatus !== "unavailable" || (typeof e.observationKind !== "string" || !["USAGE","FAILURE"].includes(e.observationKind))
        || ![null,"usage-missing","provider-rejected"].includes(e.normalizedError as null | string)
        || (e.observationKind === "FAILURE" && e.normalizedError === null)) return invalid();
      const usage = record(e.numericUsage);
      if (Object.keys(usage).length > 5) return invalid();
      for (const [key, value] of Object.entries(usage)) if (!COUNTERS.has(key) || typeof value !== "string" || !/^(0|[1-9][0-9]{0,29})$/.test(value)) return invalid();
      const json = JSON.stringify(usage);
      if (Buffer.byteLength(json) > 8192) return invalid();
      return { sql: "SELECT observation_id,disposition FROM telemetry.append_unverified_usage($1::uuid,$2::uuid,$3::text,$4::bigint,$5::jsonb,$6::text);",
        params: [project,invocation,e.observationKind,1,json,e.normalizedError] };
    }
    case "ledger_candidate":
      exact(e, ["kind","invocationId","projectId","ledgerCallId"]);
      return { sql: "SELECT telemetry.stage_ledger_candidate($1::uuid,$2::uuid,$3::uuid);", params: [project,invocation,id(e.ledgerCallId)] };
    default: return invalid();
  }
}
export interface TelemetryCandidateResult { readonly candidateId: string; readonly invocationId: string; readonly settlementId: string | null; readonly disposition: string }
/** Private server transport; inject deliver explicitly. No environment auto-enable. */
export class PostgresTelemetryDelivery {
  readonly #config: PostgresPoolConfig;
  readonly #project: string;
  #busy = false;
  constructor(config: PostgresPoolConfig, projectId: string) {
    this.#project = id(projectId);
    const loopback = ["127.0.0.1","::1","localhost"].includes(config.host);
    if ((!loopback && config.sslMode !== "verify-full") || config.allowInsecureRemoteDisableSsl || config.allowInsecureCleartextAuth) invalid();
    this.#config = Object.freeze({ ...config });
  }
  readonly deliver = async (events: readonly unknown[], signal: AbortSignal): Promise<void> => {
    if (!Array.isArray(events) || events.length < 1 || events.length > 100 || this.#busy) return invalid();
    let commands: Statement[];
    try { commands = events.map(event => statement(event, this.#project)); } catch { return invalid(); }
    this.#busy = true;
    try {
      await withTelemetryServiceTransaction(this.#config, this.#project, signal, async query => {
        for (const command of commands) { if (signal.aborted) throw new Error("aborted"); await query(command.sql, command.params); }
      });
    } finally { this.#busy = false; }
  };
  public async reconcile(signal: AbortSignal, after = ZERO, limit = 25): Promise<readonly TelemetryCandidateResult[]> {
    id(after);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || this.#busy) return invalid();
    this.#busy = true;
    try {
      return await withTelemetryServiceTransaction(this.#config, this.#project, signal, async query => {
        const result = await query("SELECT * FROM telemetry.reconcile_candidates($1::uuid,$2::uuid,$3::integer);", [this.#project,after,limit]);
        return result.rows.map(row => Object.freeze({ candidateId: String(row.candidate_id), invocationId: String(row.invocation_id),
          settlementId: row.settlement_id === null ? null : String(row.settlement_id), disposition: String(row.disposition) }));
      });
    } finally { this.#busy = false; }
  }
}
