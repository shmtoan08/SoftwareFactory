import { readTimestamp, type ProjectReadInput } from "./project-read-projection.ts";

export type BudgetReadInput = Pick<ProjectReadInput, "projectId" | "principalId" | "signedRoles" | "deadlineAt">;
export interface BudgetReadRows {
  projectId: string;
  fetchedAt: string;
  policy: { status: string; updatedAt: string; tokens: string | null; costMicroUsd: string | null; wallTimeMs: string | null } | null;
  usage: { tokens: string; costMicroUsd: string; wallTimeMs: string };
  estimatedModelUsageIncluded: boolean;
  recoveryState: "clear" | "pending" | "unknown";
}
/** Memory values must be individually exact before accumulation, including failed call usage. */
export function storedBudgetInteger(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid stored budget integer");
  return BigInt(value);
}
function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid budget projection decimal");
  return value;
}
export function budgetReadResponse(rows: BudgetReadRows, projectId: string) {
  if (rows.projectId !== projectId || typeof rows.estimatedModelUsageIncluded !== "boolean" || !["clear", "pending", "unknown"].includes(rows.recoveryState)) throw new Error("Invalid budget read scope");
  const dimension = (unit: "tokens" | "micro_usd" | "milliseconds", limit: string | null, consumed: string) => {
    const used = decimal(consumed);
    if (limit !== null && BigInt(decimal(limit)) === 0n) throw new Error("Invalid persisted budget ceiling");
    return { unit, limitKind: rows.policy === null ? "policy-absent" as const : limit === null ? "unbounded" as const : "configured" as const,
      limit, consumed: used, remaining: limit === null ? null : (BigInt(limit) - BigInt(used)).toString() };
  };
  const policy = rows.policy;
  if (policy && policy.status !== "ACTIVE" && policy.status !== "AUTO_PAUSED") throw new Error("Invalid persisted policy status");
  return {
    schemaVersion: "dashboard-read-v1" as const, fetchedAt: readTimestamp(rows.fetchedAt), projectId,
    policy: policy ? { status: policy.status, updatedAt: readTimestamp(policy.updatedAt) } : null,
    dimensions: { tokens: dimension("tokens", policy === null ? null : policy.tokens, rows.usage.tokens),
      costMicroUsd: dimension("micro_usd", policy === null ? null : policy.costMicroUsd, rows.usage.costMicroUsd),
      wallTimeMs: dimension("milliseconds", policy === null ? null : policy.wallTimeMs, rows.usage.wallTimeMs) },
    estimatedModelUsageIncluded: rows.estimatedModelUsageIncluded, recoveryState: rows.recoveryState,
    recoveryReason: rows.recoveryState === "unknown" ? "journal-not-modeled" as const : rows.recoveryState === "pending" ? "visible-pending-intent" as const : "no-visible-pending-intent" as const,
    recoveryScope: "visible-project-budget-denial-intents-at-snapshot" as const,
    usageSemantics: "recorded-project-ledgers-and-resource-metrics" as const,
  };
}
