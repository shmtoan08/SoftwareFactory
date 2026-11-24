import type { CostSessionRecord } from "@software-factory/shared-types";
import { PostgresRlsError } from "./types.ts";
import type { ProjectReadInput } from "./project-read-projection.ts";

export const COST_SESSION_READ_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type CostSessionReadInput = Pick<ProjectReadInput, "projectId" | "principalId" | "signedRoles" | "deadlineAt"> & {
  pipelineSessionId: string;
};

type CostSessionDto = Pick<CostSessionRecord,
  "cost_session_id" | "pipeline_session_id" | "session_cost_budget_micro_usd" | "cost_used_micro_usd"
  | "tokens_used_total" | "session_token_budget" | "status">;

export interface CostSessionReadRows {
  fetchedAt: string;
  costSession: CostSessionDto | null;
}

export function toSafeInt(value: unknown, fieldName: string): number {
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${fieldName} (${value.toString()}) exceeds JavaScript safe integer range`);
    }
    return Number(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new RangeError(`${fieldName} (${value}) is not a safe integer`);
    }
    const parsed = BigInt(trimmed);
    if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${fieldName} (${value}) exceeds JavaScript safe integer range`);
    }
    return Number(parsed);
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(num)) {
    throw new RangeError(`${fieldName} (${String(value)}) is not a safe integer`);
  }
  return num;
}

function boundedInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
    throw new RangeError(`Missing or invalid ${field}`);
  }
  const integer = toSafeInt(value, field);
  if (integer < minimum) throw new RangeError(`Invalid ${field}`);
  return integer;
}

export function mapCostSessionProjection(linkedId: unknown, row?: Partial<Record<keyof CostSessionDto, unknown>>): CostSessionDto | null {
  if (linkedId === null) return null;
  if (typeof linkedId !== "string" || !COST_SESSION_READ_UUID.test(linkedId)) {
    throw new Error("Invalid cost session reference");
  }
  if (row?.cost_session_id !== linkedId) throw new PostgresRlsError("23503", "Cost session not found");
  const { pipeline_session_id, status } = row;
  if (pipeline_session_id !== null && (typeof pipeline_session_id !== "string" || !COST_SESSION_READ_UUID.test(pipeline_session_id))) {
    throw new Error("Invalid cost attribution");
  }
  if (status !== "ACTIVE" && status !== "EXHAUSTED" && status !== "CLOSED") throw new Error("Invalid cost session status");
  return {
    cost_session_id: linkedId,
    pipeline_session_id,
    session_cost_budget_micro_usd: boundedInteger(row.session_cost_budget_micro_usd, "session_cost_budget_micro_usd"),
    cost_used_micro_usd: boundedInteger(row.cost_used_micro_usd, "cost_used_micro_usd"),
    tokens_used_total: boundedInteger(row.tokens_used_total, "tokens_used_total"),
    session_token_budget: boundedInteger(row.session_token_budget, "session_token_budget", 1),
    status,
  };
}
