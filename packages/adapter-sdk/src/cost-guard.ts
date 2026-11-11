import { randomUUID } from "node:crypto";
import {
  type CostLimitScope,
  type CostPreflightCheckInput,
  type CostPreflightCheckResult,
  type CostSessionRecord,
  type FinalizeModelCallInput,
  type FinalizeModelCallResult,
  type ModelCallLedgerRecord,
  type ModelCallStatus,
  type ModelPricingRate,
  type ModelProviderName,
  type ModelUsageMetrics,
  evaluatePostcallLimits,
  evaluatePreflightLimits,
} from "@software-factory/shared-types";

export type {
  CostLimitScope,
  CostPreflightCheckInput,
  CostPreflightCheckResult,
  FinalizeModelCallInput,
  FinalizeModelCallResult,
};
export { evaluatePostcallLimits, evaluatePreflightLimits };

export class CostBudgetExceededError extends Error {
  public readonly code: "ERR_COST_LIMIT_EXCEEDED" | "ERR_SESSION_BUDGET_EXCEEDED";
  public readonly httpStatus = 402 as const;
  public readonly limitScope: CostLimitScope;
  public readonly costSessionId: string;
  public readonly ledgerId: string;
  public readonly details: Readonly<Record<string, unknown>>;

  constructor(input: {
    code?: "ERR_COST_LIMIT_EXCEEDED" | "ERR_SESSION_BUDGET_EXCEEDED";
    limitScope: CostLimitScope;
    costSessionId: string;
    ledgerId: string;
    message: string;
    details?: Readonly<Record<string, unknown>>;
  }) {
    super(input.message);
    this.name = "CostBudgetExceededError";
    this.code =
      input.code ??
      (input.limitScope.startsWith("PER_REQUEST")
        ? "ERR_COST_LIMIT_EXCEEDED"
        : "ERR_SESSION_BUDGET_EXCEEDED");
    this.limitScope = input.limitScope;
    this.costSessionId = input.costSessionId;
    this.ledgerId = input.ledgerId;
    this.details = input.details ?? {};
  }
}

/**
 * Default model pricing rates in integer `micro-USD` per 1,000,000 tokens
 * (`1 USD = 1_000_000 micro-USD`).
 */
export const DEFAULT_MODEL_PRICING_CATALOG: Readonly<Record<string, ModelPricingRate>> = {
  "anthropic:claude-sonnet-4-20250514": {
    inputMicroUsdPerMillionTokens: 3_000_000,
    outputMicroUsdPerMillionTokens: 15_000_000,
  },
  "anthropic:claude-3-7-sonnet-20250219": {
    inputMicroUsdPerMillionTokens: 3_000_000,
    outputMicroUsdPerMillionTokens: 15_000_000,
  },
  "anthropic:claude-3-5-haiku-20241022": {
    inputMicroUsdPerMillionTokens: 800_000,
    outputMicroUsdPerMillionTokens: 4_000_000,
  },
  anthropic: {
    inputMicroUsdPerMillionTokens: 3_000_000,
    outputMicroUsdPerMillionTokens: 15_000_000,
  },
  "openai:gpt-4.1": {
    inputMicroUsdPerMillionTokens: 2_000_000,
    outputMicroUsdPerMillionTokens: 8_000_000,
  },
  "openai:gpt-4o": {
    inputMicroUsdPerMillionTokens: 2_500_000,
    outputMicroUsdPerMillionTokens: 10_000_000,
  },
  "openai:o3-mini": {
    inputMicroUsdPerMillionTokens: 1_100_000,
    outputMicroUsdPerMillionTokens: 4_400_000,
  },
  openai: {
    inputMicroUsdPerMillionTokens: 2_500_000,
    outputMicroUsdPerMillionTokens: 10_000_000,
  },
  "google:gemini-2.5-pro": {
    inputMicroUsdPerMillionTokens: 1_250_000,
    outputMicroUsdPerMillionTokens: 10_000_000,
  },
  "google:gemini-2.5-flash": {
    inputMicroUsdPerMillionTokens: 150_000,
    outputMicroUsdPerMillionTokens: 600_000,
  },
  google: {
    inputMicroUsdPerMillionTokens: 1_250_000,
    outputMicroUsdPerMillionTokens: 5_000_000,
  },
};

export function resolveModelPricingRate(
  provider: ModelProviderName,
  model: string,
  overrides?: Readonly<Record<string, ModelPricingRate>>
): ModelPricingRate {
  const compositeKey = `${provider}:${model}`;
  if (overrides) {
    if (overrides[compositeKey]) return overrides[compositeKey]!;
    if (overrides[model]) return overrides[model]!;
    if (overrides[provider]) return overrides[provider]!;
  }
  if (DEFAULT_MODEL_PRICING_CATALOG[compositeKey]) {
    return DEFAULT_MODEL_PRICING_CATALOG[compositeKey]!;
  }
  if (model.includes("haiku")) {
    return DEFAULT_MODEL_PRICING_CATALOG["anthropic:claude-3-5-haiku-20241022"]!;
  }
  if (model.includes("flash")) {
    return DEFAULT_MODEL_PRICING_CATALOG["google:gemini-2.5-flash"]!;
  }
  return DEFAULT_MODEL_PRICING_CATALOG[provider]!;
}

/**
 * Deterministic UTF-8 byte-based token estimator for pre-flight budget reservations.
 */
export function estimateTokenCount(text: string): number {
  if (!text) {
    return 0;
  }
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.max(1, Math.ceil(bytes / 4));
}

/**
 * Exact integer ceiling cost calculation in `micro-USD` (`1 USD = 1_000_000 micro-USD`)
 * using BigInt arithmetic to eliminate IEEE-754 floating-point drift.
 */
export function computeCostMicroUsd(
  inputTokens: number,
  outputTokens: number,
  rate: ModelPricingRate
): number {
  const safeIn = BigInt(Math.max(0, Math.trunc(inputTokens)));
  const safeOut = BigInt(Math.max(0, Math.trunc(outputTokens)));
  const rIn = BigInt(Math.max(0, Math.trunc(rate.inputMicroUsdPerMillionTokens)));
  const rOut = BigInt(Math.max(0, Math.trunc(rate.outputMicroUsdPerMillionTokens)));
  const numerator = safeIn * rIn + safeOut * rOut;
  if (numerator === 0n) {
    return 0;
  }
  const microUsd = (numerator + 999_999n) / 1_000_000n;
  return Number(microUsd);
}

function readOptionalNonNegInt(
  record: Record<string, unknown> | undefined,
  key: string
): number | null {
  if (!record) return null;
  const val = record[key];
  if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
    return Math.trunc(val);
  }
  return null;
}

/**
 * Normalizes provider-specific token telemetry (`Anthropic`, `OpenAI`, `Google Gemini`)
 * into a uniform `ModelUsageMetrics` structure, falling back to deterministic byte estimation
 * only when the provider response omits usage counters.
 */
export function extractNormalizedTokenUsage(
  provider: ModelProviderName,
  rawUsage: Readonly<Record<string, unknown>> | undefined,
  fallbackInputText: string,
  fallbackOutputText: string
): ModelUsageMetrics {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  if (provider === "anthropic") {
    inputTokens = readOptionalNonNegInt(rawUsage, "input_tokens");
    outputTokens = readOptionalNonNegInt(rawUsage, "output_tokens");
  } else if (provider === "openai") {
    inputTokens =
      readOptionalNonNegInt(rawUsage, "prompt_tokens") ??
      readOptionalNonNegInt(rawUsage, "input_tokens");
    outputTokens =
      readOptionalNonNegInt(rawUsage, "completion_tokens") ??
      readOptionalNonNegInt(rawUsage, "output_tokens");
  } else {
    inputTokens = readOptionalNonNegInt(rawUsage, "promptTokenCount");
    outputTokens = readOptionalNonNegInt(rawUsage, "candidatesTokenCount");
    if (outputTokens === null && inputTokens !== null) {
      const total = readOptionalNonNegInt(rawUsage, "totalTokenCount");
      if (total !== null) {
        outputTokens = Math.max(0, total - inputTokens);
      }
    }
  }

  const resolvedIn = inputTokens ?? estimateTokenCount(fallbackInputText);
  const resolvedOut = outputTokens ?? estimateTokenCount(fallbackOutputText);
  return {
    inputTokens: resolvedIn,
    outputTokens: resolvedOut,
    totalTokens: resolvedIn + resolvedOut,
    ...(rawUsage ? { rawProviderUsage: rawUsage } : {}),
  };
}

/**
 * Persistence interface implemented by `ControlPlaneStore` (`SoftwareFactoryControlPlaneStore` &
 * `PostgresControlPlaneRepository`) as well as standalone `InMemoryCostGuardLedger`.
 */
export interface CostGuardRecorder {
  preflightCheckCostSession(
    input: CostPreflightCheckInput
  ): CostPreflightCheckResult | Promise<CostPreflightCheckResult>;
  finalizeModelCallLedger(
    input: FinalizeModelCallInput
  ): FinalizeModelCallResult | Promise<FinalizeModelCallResult>;
}

/**
 * Standalone in-memory `CostGuardRecorder` for unit-level `ManagedModelProviderExecutor` usage
 * outside the Control Plane database.
 */
export class InMemoryCostGuardLedger implements CostGuardRecorder {
  private readonly sessions = new Map<string, CostSessionRecord>();
  private readonly ledgers: ModelCallLedgerRecord[] = [];
  private readonly clockFn: () => Date;

  constructor(clockFn: () => Date = () => new Date()) {
    this.clockFn = clockFn;
  }

  public createSession(input: {
    cost_session_id?: string;
    project_id: string;
    pipeline_session_id?: string | null;
    task_id?: string | null;
    max_tokens_per_request: number;
    max_cost_micro_usd_per_request: number;
    session_token_budget: number;
    session_cost_budget_micro_usd: number;
  }): CostSessionRecord {
    const now = this.clockFn().toISOString();
    const record: CostSessionRecord = {
      cost_session_id: input.cost_session_id ?? randomUUID(),
      project_id: input.project_id,
      pipeline_session_id: input.pipeline_session_id ?? null,
      task_id: input.task_id ?? null,
      max_tokens_per_request: input.max_tokens_per_request,
      max_cost_micro_usd_per_request: input.max_cost_micro_usd_per_request,
      session_token_budget: input.session_token_budget,
      session_cost_budget_micro_usd: input.session_cost_budget_micro_usd,
      tokens_used_total: 0,
      cost_used_micro_usd: 0,
      status: "ACTIVE",
      created_at: now,
      updated_at: now,
    };
    this.sessions.set(record.cost_session_id, record);
    return { ...record };
  }

  public getSession(costSessionId: string): CostSessionRecord | null {
    const found = this.sessions.get(costSessionId);
    return found ? { ...found } : null;
  }

  public listLedgers(costSessionId?: string): ModelCallLedgerRecord[] {
    return this.ledgers
      .filter((l) => !costSessionId || l.cost_session_id === costSessionId)
      .map((l) => ({ ...l }));
  }

  public preflightCheckCostSession(input: CostPreflightCheckInput): CostPreflightCheckResult {
    const session = this.sessions.get(input.cost_session_id);
    if (!session || session.project_id !== input.project_id) {
      throw new Error(
        `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
      );
    }

    const violation = evaluatePreflightLimits(session, input);
    if (!violation) {
      return { allowed: true, session: { ...session } };
    }

    const now = this.clockFn().toISOString();
    const blockedLedger: ModelCallLedgerRecord = {
      call_id: randomUUID(),
      project_id: input.project_id,
      cost_session_id: input.cost_session_id,
      pipeline_session_id: input.pipeline_session_id ?? session.pipeline_session_id,
      task_id: input.task_id ?? session.task_id,
      stage: input.stage,
      provider: input.provider,
      model: input.model,
      prompt_id: input.prompt_id,
      prompt_version: input.prompt_version,
      prompt_sha256: input.prompt_sha256,
      request_sha256: input.request_sha256,
      estimated_input_tokens: input.estimated_input_tokens,
      reserved_output_tokens: input.reserved_output_tokens,
      actual_input_tokens: 0,
      actual_output_tokens: 0,
      actual_total_tokens: 0,
      estimated_cost_micro_usd: input.estimated_cost_micro_usd,
      actual_cost_micro_usd: 0,
      status: "BLOCKED_PREFLIGHT",
      block_reason: `${violation.limitScope}: ${violation.reason}`,
      error_message: violation.reason,
      latency_ms: 0,
      created_at: now,
    };
    this.ledgers.push(blockedLedger);

    return {
      allowed: false,
      limitScope: violation.limitScope,
      reason: violation.reason,
      session: { ...session },
      blockedLedger: { ...blockedLedger },
    };
  }

  public finalizeModelCallLedger(input: FinalizeModelCallInput): FinalizeModelCallResult {
    const session = this.sessions.get(input.cost_session_id);
    if (!session || session.project_id !== input.project_id) {
      throw new Error(
        `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
      );
    }

    const now = this.clockFn().toISOString();
    const actualTotalTokens = input.actual_input_tokens + input.actual_output_tokens;
    const evalRes = evaluatePostcallLimits(session, actualTotalTokens, input.actual_cost_micro_usd);

    const updatedSession: CostSessionRecord = {
      ...session,
      tokens_used_total: evalRes.nextTokensUsedTotal,
      cost_used_micro_usd: evalRes.nextCostUsedMicroUsd,
      status: evalRes.nextStatus,
      updated_at: now,
    };
    this.sessions.set(session.cost_session_id, updatedSession);

    const status: ModelCallStatus = evalRes.exceeded ? "BLOCKED_POSTCALL" : input.outcome;
    const ledger: ModelCallLedgerRecord = {
      call_id: randomUUID(),
      project_id: input.project_id,
      cost_session_id: input.cost_session_id,
      pipeline_session_id: input.pipeline_session_id ?? session.pipeline_session_id,
      task_id: input.task_id ?? session.task_id,
      stage: input.stage,
      provider: input.provider,
      model: input.model,
      prompt_id: input.prompt_id,
      prompt_version: input.prompt_version,
      prompt_sha256: input.prompt_sha256,
      request_sha256: input.request_sha256,
      estimated_input_tokens: input.estimated_input_tokens,
      reserved_output_tokens: input.reserved_output_tokens,
      actual_input_tokens: input.actual_input_tokens,
      actual_output_tokens: input.actual_output_tokens,
      actual_total_tokens: actualTotalTokens,
      estimated_cost_micro_usd: input.estimated_cost_micro_usd,
      actual_cost_micro_usd: input.actual_cost_micro_usd,
      status,
      block_reason: evalRes.exceeded
        ? `${evalRes.exceeded.limitScope}: ${evalRes.exceeded.reason}`
        : null,
      error_message: evalRes.exceeded?.reason ?? input.error_message ?? null,
      latency_ms: Math.max(0, Math.trunc(input.latency_ms)),
      created_at: now,
    };
    this.ledgers.push(ledger);

    return {
      allowed: !evalRes.exceeded,
      ...(evalRes.exceeded
        ? { limitScope: evalRes.exceeded.limitScope, reason: evalRes.exceeded.reason }
        : {}),
      session: { ...updatedSession },
      ledger: { ...ledger },
    };
  }
}
