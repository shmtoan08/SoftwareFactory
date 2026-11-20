import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  CallTelemetryObserver, sanitizeCandidateUsage, InMemoryCostGuardLedger,
  LiveModelProviderClient, ManagedModelProviderExecutor, PromptRegistry,
  deriveProtectedTemplateHmac, verifyProtectedTemplateHmac,
  type CallTelemetryEvent, type CallObservationContext, type ModelCompletionResponse,
} from "@software-factory/adapter-sdk";
const project = "10000000-0000-0000-0000-000000000071";
const costSession = "20000000-0000-0000-0000-000000000071";
const context: CallObservationContext = { projectId: project, costSessionId: costSession, taskId: null,
  pipelineSessionId: null, provider: "anthropic", model: "fixture", promptId: "fixture", promptVersion: "1", promptSha256: "a".repeat(64) };
function observer(deliver: (events: readonly CallTelemetryEvent[], signal: AbortSignal) => Promise<void>, extra: Partial<ConstructorParameters<typeof CallTelemetryObserver>[0]> = {}): CallTelemetryObserver {
  return new CallTelemetryObserver({ projectId: project, environment: "fixture", keyVersion: "1", hmacKey: Buffer.alloc(32, 7), deliver, ...extra });
}
async function drained(value: CallTelemetryObserver): Promise<void> {
  for (let n = 0; n < 200 && value.stats().pending; n++) await delay(5);
  assert.equal(value.stats().pending, 0);
}
describe("T1 B1 provider-free optional observation", () => {
  it("rejects unsafe counters and unknown fields without reading getters; keeps large decimal strings exact", () => {
    assert.deepEqual(sanitizeCandidateUsage("anthropic", { input_tokens: "9007199254740993", output_tokens: 0 }), { input_tokens: "9007199254740993", output_tokens: "0" });
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, "01", "1e3", "9".repeat(31)]) {
      assert.equal(sanitizeCandidateUsage("anthropic", { input_tokens: value }), null);
    }
    assert.equal(sanitizeCandidateUsage("google", { input_tokens: 1 }), null);
    assert.equal(sanitizeCandidateUsage("openai", { total_tokens: 1 }), null);
    assert.equal(sanitizeCandidateUsage("anthropic", { raw_prompt: "PRIVATE_CANARY" }), null);
    let touched = false;
    assert.equal(sanitizeCandidateUsage("anthropic", { get input_tokens() { touched = true; throw new Error("PRIVATE_CANARY"); } }), null);
    assert.equal(touched, false);
  });
  it("domain-separates HMAC by environment/project/version and refuses forged handles", async () => {
    const batches: CallTelemetryEvent[][] = [];
    for (const [environment, projectId, keyVersion] of [["one", project, "1"], ["two", project, "1"], ["one", randomUUID(), "1"], ["one", project, "2"]]) {
      const events: CallTelemetryEvent[] = []; batches.push(events);
      const value = observer(async batch => { events.push(...batch); }, { environment: environment!, projectId: projectId!, keyVersion: keyVersion! });
      const handle = value.begin({ ...context, projectId: projectId! }); assert(handle);
      value.ledgerCandidate({ invocationId: handle.invocationId }, randomUUID());
      await drained(value); value.stop();
      assert.equal(events.length, 1);
      assert.equal(JSON.stringify(events).includes(context.promptSha256), false);
    }
    assert.equal(new Set(batches.map(batch => batch[0]?.kind === "register" ? batch[0].promptHmac : "")).size, 4);
    const register = batches[0]![0]; assert(register?.kind === "register");
    const binding = { environment: "one", projectId: project, keyVersion: "1", promptId: context.promptId,
      promptVersion: context.promptVersion, promptSha256: context.promptSha256 };
    assert.equal(register.promptHmac, "60cf538a65348b25f6727ce56985960a13877126cf638643931428586fe5980a");
    assert.equal(register.promptHmac, deriveProtectedTemplateHmac(binding, Buffer.alloc(32, 7)));
    assert.equal(verifyProtectedTemplateHmac(binding, register.promptHmac, Buffer.alloc(32, 7)), true);
    assert.equal(verifyProtectedTemplateHmac({ ...binding, environment: "two" }, register.promptHmac, Buffer.alloc(32, 7)), false);
    assert.equal(verifyProtectedTemplateHmac({ ...binding, projectId: "10000000-0000-0000-0000-000000000072" }, register.promptHmac, Buffer.alloc(32, 7)), false);
    assert.equal(verifyProtectedTemplateHmac({ ...binding, keyVersion: "2" }, register.promptHmac, Buffer.alloc(32, 7)), false);
    assert.equal(verifyProtectedTemplateHmac({ ...binding, promptSha256: "b".repeat(64) }, register.promptHmac, Buffer.alloc(32, 7)), false);
    assert.equal(verifyProtectedTemplateHmac({ ...binding, promptId: "other" }, register.promptHmac, Buffer.alloc(32, 7)), false);
    assert.equal(verifyProtectedTemplateHmac({ ...binding, promptVersion: "2" }, register.promptHmac, Buffer.alloc(32, 7)), false);
    assert.equal(verifyProtectedTemplateHmac(binding, register.promptHmac, Buffer.alloc(32, 8)), false);
    assert.equal(verifyProtectedTemplateHmac(binding, "not-a-hmac", Buffer.alloc(32, 7)), false);
    assert.equal(verifyProtectedTemplateHmac({ ...binding, promptSha256: "A".repeat(64) }, register.promptHmac, Buffer.alloc(32, 7)), false);
    assert.throws(() => deriveProtectedTemplateHmac(binding, Buffer.alloc(31)), /^Error: Invalid protected template binding$/);
  });
  it("includes in-flight events in capacity; expires hanging transport once and never overlaps delivery", async () => {
    let calls = 0; let signal: AbortSignal | undefined; let release: (() => void) | undefined;
    const value = observer(async (_events, inputSignal) => { calls++; signal = inputSignal; await new Promise<void>(resolve => { release = resolve; }); }, { maxEvents: 2, deliveryTimeoutMs: 15 });
    const handle = value.begin(context); assert(handle);
    value.usage(handle, { input_tokens: 1 });
    value.ledgerCandidate(handle, randomUUID());
    assert.equal(value.stats().pending, 2); assert.equal(value.stats().dropped, 1);
    for (let n = 0; n < 200 && !signal?.aborted; n++) await delay(5);
    assert.equal(calls, 1); assert.equal(signal?.aborted, true); assert.equal(value.stats().enabled, false);
    assert.equal(value.stats().failures, 1); assert.equal(value.begin(context), null);
    release?.(); await drained(value);
    assert.equal(value.stats().bytes, 0);
  });
  it("enforces byte bounds, batch <=100, kill switch and no delivery retry", async () => {
    const sizes: number[] = [];
    const value = observer(async events => { sizes.push(events.length); throw new Error("PRIVATE_CANARY"); });
    for (let n = 0; n < 205; n++) assert(value.begin(context));
    await drained(value);
    assert.deepEqual(sizes, [100, 100, 5]); assert.equal(value.stats().failures, 3);
    assert.equal(value.stats().dropped, 205);
    value.stop(); assert.equal(value.begin(context), null);
    const tiny = observer(async () => { throw new Error("must not deliver"); }, { maxBytes: 1 });
    assert.equal(tiny.begin(context), null); assert.equal(tiny.stats().bytes, 0); tiny.stop();
  });

  type Scenario = "allowed" | "preflight" | "provider" | "validation" | "domain" | "postcall";
  async function execute(scenario: Scenario, telemetryObserver?: CallTelemetryObserver) {
    let providerCalls = 0;
    const providerFailure = new Error("PRIVATE_PROVIDER_CANARY");
    class FixtureClient extends LiveModelProviderClient {
      override async complete(): Promise<ModelCompletionResponse> {
        providerCalls++;
        if (scenario === "provider") throw providerFailure;
        const outputTokens = scenario === "postcall" ? 1_000_000 : 2;
        return { provider: "anthropic", model: this.config.model, endpoint: "fixture", requestSha256: "b".repeat(64),
          contentText: scenario === "validation" ? "PRIVATE_BAD_OUTPUT" : '{"ok":true}',
          rawUsage: { input_tokens: 1, output_tokens: outputTokens }, usage: { inputTokens: 1, outputTokens, totalTokens: 1 + outputTokens } };
      }
    }
    const guard = new InMemoryCostGuardLedger();
    guard.createSession({ project_id: project, cost_session_id: costSession, max_tokens_per_request: scenario === "preflight" ? 1 : 1000,
      max_cost_micro_usd_per_request: 1_000_000, session_token_budget: 10_000_000, session_cost_budget_micro_usd: 1_000_000 });
    const registry = new PromptRegistry();
    registry.register({ promptId: "fixture", version: "1", description: "fixture", requiredVariables: [], systemTemplate: "PRIVATE_SYSTEM_CANARY", userTemplate: "PRIVATE_USER_CANARY",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } });
    const executor = new ManagedModelProviderExecutor({ client: new FixtureClient({ provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "fixture" }),
      promptRegistry: registry, costGuard: guard, telemetryObserver, defaultMaxTokens: 8 });
    let result = "";
    try {
      const input = { projectId: project, costSessionId: costSession, stage: "fixture", promptId: "fixture", promptVersion: "1" };
      if (scenario === "domain") { const deferred = await executor.executeStructuredPromptDeferred(input); await deferred.finalizeDomainFailure("PRIVATE_DOMAIN_CANARY"); result = "domain"; }
      else result = JSON.stringify((await executor.executeStructuredPrompt(input)).parsed);
    } catch (error) {
      if (scenario === "provider") assert.equal(error, providerFailure);
      result = error instanceof Error ? error.name : "unknown";
    }
    const ledgers = guard.listLedgers(costSession);
    return { providerCalls, result, ledgers: ledgers.map(row => ({ status: row.status, input: row.actual_input_tokens, output: row.actual_output_tokens, cost: row.actual_cost_micro_usd })),
      tokens: guard.getSession(costSession)?.tokens_used_total, cost: guard.getSession(costSession)?.cost_used_micro_usd,
      ledgerIds: ledgers.map(row => row.call_id), fingerprint: registry.render("fixture", "1", {}).promptSha256 };
  }
  for (const scenario of ["allowed", "preflight", "provider", "validation", "domain", "postcall"] as const) {
    it(`preserves ${scenario} business outcome/cost/provider count with observer on, throwing, overflowing and stopped`, async () => {
      const baseline = await execute(scenario);
      for (const mode of ["record", "reject", "overflow", "stopped", "hooks"] as const) {
        const events: CallTelemetryEvent[] = [];
        const value = observer(async batch => { if (mode === "reject") throw new Error("PRIVATE_SINK_CANARY"); events.push(...batch); }, mode === "overflow" ? { maxEvents: 1 } : {});
        if (mode === "stopped") value.stop();
        if (mode === "hooks") {
          const fail = () => { throw new Error("PRIVATE_HOOK_CANARY"); };
          value.usage = fail; value.failure = fail; value.ledgerCandidate = fail;
        }
        const actual = await execute(scenario, value); await drained(value); value.stop();
        const { ledgerIds: _baseIds, fingerprint: _baseFingerprint, ...baseBusiness } = baseline;
        const { ledgerIds, fingerprint, ...business } = actual;
        assert.deepEqual(business, baseBusiness);
        assert.equal(actual.providerCalls, scenario === "preflight" ? 0 : 1);
        if (mode === "record") {
          assert.deepEqual(events.filter(event => event.kind === "ledger_candidate").map(event => event.ledgerCallId), ledgerIds);
          assert(events.some(event => event.kind === "register" && event.bindingState === "CALL_ONLY"));
          const serialized = JSON.stringify(events);
          for (const forbidden of ["PRIVATE_", fingerprint, '"requestSha256"', '"promptSha256"']) assert.equal(serialized.includes(forbidden), false);
          assert(events.every(event => event.kind !== "usage" || event.canonicalStatus === "unavailable"));
        }
      }
    });
  }
  it("does not await a transport already hung while executing another model call", { timeout: 2000 }, async () => {
    let started = false; let release: (() => void) | undefined;
    const value = observer(async () => { started = true; await new Promise<void>(resolve => { release = resolve; }); }, { deliveryTimeoutMs: 500 });
    assert(value.begin(context));
    for (let n = 0; n < 100 && !started; n++) await delay(5);
    assert(started);
    try {
      const result = await execute("allowed", value);
      assert.equal(result.providerCalls, 1); assert.equal(result.result, '{"ok":true}');
      assert.equal(result.ledgers.length, 1);
    } finally { value.stop(); release?.(); await drained(value); }
  });
  it("isolates synchronous hook exceptions, not just rejected delivery promises", async () => {
    const value = observer(async () => {});
    value.begin = () => { throw new Error("PRIVATE_HOOK_CANARY"); };
    const baseline = await execute("allowed"); const actual = await execute("allowed", value);
    assert.deepEqual(actual.ledgers, baseline.ledgers); assert.equal(actual.result, baseline.result); assert.equal(actual.providerCalls, 1);
    value.stop();
  });
});
