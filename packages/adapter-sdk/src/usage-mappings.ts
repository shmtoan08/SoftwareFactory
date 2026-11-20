import { sanitizeCandidateUsage } from "./call-telemetry.ts";

export type CandidateUsageProvider = "anthropic" | "google";

export interface CandidateUsageMapping {
  readonly mappingId: string;
  readonly status: "UNVERIFIED";
  readonly provider: CandidateUsageProvider;
  readonly model: string;
  readonly endpoint: string;
  readonly apiVersion: string;
  readonly streamMode: "non-stream" | "sse";
  readonly allowedCounters: readonly string[];
  readonly cacheRelation: "unverified";
  readonly reasoningRelation: "unverified";
  readonly snapshotSemantics: "final-object" | "cumulative-unverified";
  readonly sourceUrls: readonly string[];
}

const ANTHROPIC_COUNTERS = Object.freeze([
  "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
]);
const GOOGLE_COUNTERS = Object.freeze([
  "promptTokenCount", "candidatesTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount",
]);
const ANTHROPIC_SOURCES = Object.freeze([
  "https://platform.claude.com/docs/en/api/messages",
  "https://platform.claude.com/docs/en/build-with-claude/streaming",
]);
const GOOGLE_SOURCES = Object.freeze([
  "https://aistudio.google.com/api-reference/generate-content",
]);

/** Candidate rows only. Review must explicitly promote a future immutable revision. */
export const CANDIDATE_USAGE_MAPPINGS: readonly CandidateUsageMapping[] = Object.freeze([
  Object.freeze({ mappingId: "anthropic-messages-2023-06-01-nonstream-r1", status: "UNVERIFIED", provider: "anthropic",
    model: "claude-sonnet-4-20250514", endpoint: "/v1/messages", apiVersion: "2023-06-01", streamMode: "non-stream",
    allowedCounters: ANTHROPIC_COUNTERS, cacheRelation: "unverified", reasoningRelation: "unverified",
    snapshotSemantics: "final-object", sourceUrls: ANTHROPIC_SOURCES }),
  Object.freeze({ mappingId: "anthropic-messages-2023-06-01-sse-r1", status: "UNVERIFIED", provider: "anthropic",
    model: "claude-sonnet-4-20250514", endpoint: "/v1/messages", apiVersion: "2023-06-01", streamMode: "sse",
    allowedCounters: ANTHROPIC_COUNTERS, cacheRelation: "unverified", reasoningRelation: "unverified",
    snapshotSemantics: "cumulative-unverified", sourceUrls: ANTHROPIC_SOURCES }),
  Object.freeze({ mappingId: "google-generatecontent-v1beta-nonstream-r1", status: "UNVERIFIED", provider: "google",
    model: "gemini-2.5-pro", endpoint: "/v1beta/models/{model}:generateContent", apiVersion: "v1beta", streamMode: "non-stream",
    allowedCounters: GOOGLE_COUNTERS, cacheRelation: "unverified", reasoningRelation: "unverified",
    snapshotSemantics: "final-object", sourceUrls: GOOGLE_SOURCES }),
  Object.freeze({ mappingId: "google-generatecontent-v1beta-sse-r1", status: "UNVERIFIED", provider: "google",
    model: "gemini-2.5-pro", endpoint: "/v1beta/models/{model}:streamGenerateContent", apiVersion: "v1beta", streamMode: "sse",
    allowedCounters: GOOGLE_COUNTERS, cacheRelation: "unverified", reasoningRelation: "unverified",
    snapshotSemantics: "cumulative-unverified", sourceUrls: GOOGLE_SOURCES }),
]);

export interface CandidateUsageSnapshot {
  readonly receiptId: string;
  readonly sequence: number;
  readonly terminal: boolean;
  readonly usage: unknown;
}

export interface UnverifiedUsageFold {
  readonly mappingId: string;
  readonly canonicalStatus: "unavailable";
  readonly canonicalInput: null;
  readonly canonicalOutput: null;
  readonly canonicalTotal: null;
  readonly numericUsage: Readonly<Record<string, string>>;
  readonly missingReason: "mapping-unverified" | "usage-missing" | "stream-incomplete" | "conflicting-observation";
  readonly terminalSeen: boolean;
  readonly acceptedReceipts: number;
}

function invalid(): never { throw new Error("Invalid candidate usage fixture"); }

/**
 * Provider-free fixture fold. It deduplicates transport receipts and retains only
 * the latest permitted snapshot. It never sums frames or emits canonical usage.
 */
export function foldUnverifiedUsageSnapshots(
  mappingId: string,
  snapshots: readonly CandidateUsageSnapshot[]
): UnverifiedUsageFold {
  const mapping = CANDIDATE_USAGE_MAPPINGS.find(row => row.mappingId === mappingId);
  if (!mapping || !Array.isArray(snapshots) || snapshots.length > 1000) invalid();
  const seen = new Map<string, string>();
  let priorSequence = -1;
  let latest: Readonly<Record<string, string>> = Object.freeze({});
  let terminalSeen = false;
  let acceptedReceipts = 0;
  let missingUsage = snapshots.length === 0;
  let conflict = false;
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object" || !/^[A-Za-z0-9_-]{1,128}$/.test(snapshot.receiptId)
      || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || typeof snapshot.terminal !== "boolean") invalid();
    const sanitized = sanitizeCandidateUsage(mapping.provider, snapshot.usage);
    const digest = JSON.stringify([snapshot.sequence, snapshot.terminal, sanitized]);
    const previous = seen.get(snapshot.receiptId);
    if (previous !== undefined) { if (previous !== digest) conflict = true; continue; }
    if (snapshot.sequence <= priorSequence) invalid();
    priorSequence = snapshot.sequence; seen.set(snapshot.receiptId, digest); acceptedReceipts++;
    terminalSeen ||= snapshot.terminal;
    if (sanitized) { latest = sanitized; missingUsage = false; } else { missingUsage = true; }
  }
  if (mapping.streamMode === "non-stream" && acceptedReceipts > 1) invalid();
  const missingReason = conflict ? "conflicting-observation" : missingUsage ? "usage-missing"
    : mapping.streamMode === "sse" && !terminalSeen ? "stream-incomplete" : "mapping-unverified";
  return Object.freeze({ mappingId, canonicalStatus: "unavailable", canonicalInput: null, canonicalOutput: null,
    canonicalTotal: null, numericUsage: latest, missingReason, terminalSeen, acceptedReceipts });
}
