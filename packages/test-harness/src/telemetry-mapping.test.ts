import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CANDIDATE_USAGE_MAPPINGS, foldUnverifiedUsageSnapshots } from "@software-factory/adapter-sdk";

describe("T1 C1 provider-free candidate mapping fixtures", () => {
  it("pins exact candidate rows without promoting any mapping", () => {
    assert.equal(CANDIDATE_USAGE_MAPPINGS.length, 4);
    assert(CANDIDATE_USAGE_MAPPINGS.every(row => row.status === "UNVERIFIED"));
    assert(CANDIDATE_USAGE_MAPPINGS.every(row => row.model === "claude-sonnet-4-20250514" || row.model === "gemini-2.5-pro"));
    assert(CANDIDATE_USAGE_MAPPINGS.every(row => row.cacheRelation === "unverified" && row.reasoningRelation === "unverified"));
    assert.equal(new Set(CANDIDATE_USAGE_MAPPINGS.map(row => row.mappingId)).size, 4);
  });

  it("keeps Anthropic cumulative frames unavailable and never sums repeated snapshots", () => {
    const folded = foldUnverifiedUsageSnapshots("anthropic-messages-2023-06-01-sse-r1", [
      { receiptId: "start", sequence: 0, terminal: false, usage: { input_tokens: 9007199254740993, output_tokens: 0 } },
      { receiptId: "delta-1", sequence: 1, terminal: false, usage: { input_tokens: "9007199254740993", output_tokens: "3" } },
      { receiptId: "delta-1", sequence: 1, terminal: false, usage: { input_tokens: "9007199254740993", output_tokens: "3" } },
      { receiptId: "final", sequence: 2, terminal: true, usage: { input_tokens: "9007199254740993", output_tokens: "5" } },
    ]);
    assert.deepEqual(folded.numericUsage, { input_tokens: "9007199254740993", output_tokens: "5" });
    assert.equal(folded.acceptedReceipts, 3); assert.equal(folded.missingReason, "mapping-unverified");
    assert.equal(folded.canonicalTotal, null); assert.equal(folded.canonicalStatus, "unavailable");
  });

  it("marks partial Google streams incomplete without converting missing counters to zero", () => {
    const folded = foldUnverifiedUsageSnapshots("google-generatecontent-v1beta-sse-r1", [
      { receiptId: "chunk-1", sequence: 0, terminal: false, usage: { promptTokenCount: "10", candidatesTokenCount: "2" } },
      { receiptId: "chunk-2", sequence: 1, terminal: false, usage: { promptTokenCount: "10", candidatesTokenCount: "4", thoughtsTokenCount: "7" } },
    ]);
    assert.deepEqual(folded.numericUsage, { promptTokenCount: "10", candidatesTokenCount: "4", thoughtsTokenCount: "7" });
    assert.equal(folded.missingReason, "stream-incomplete"); assert.equal(folded.terminalSeen, false);
    assert.equal(Object.hasOwn(folded.numericUsage, "totalTokenCount"), false);
  });

  it("fails closed for unknown fields, unsafe integers, conflicting retries and invalid ordering", () => {
    const missing = foldUnverifiedUsageSnapshots("google-generatecontent-v1beta-nonstream-r1", [
      { receiptId: "one", sequence: 0, terminal: true, usage: { totalTokenCount: Number.MAX_SAFE_INTEGER + 1, raw_payload: "PRIVATE" } },
    ]);
    assert.deepEqual(missing.numericUsage, {}); assert.equal(missing.missingReason, "usage-missing");
    const conflict = foldUnverifiedUsageSnapshots("anthropic-messages-2023-06-01-sse-r1", [
      { receiptId: "same", sequence: 0, terminal: false, usage: { input_tokens: "1" } },
      { receiptId: "same", sequence: 0, terminal: true, usage: { input_tokens: "2" } },
    ]);
    assert.equal(conflict.missingReason, "conflicting-observation"); assert.equal(conflict.acceptedReceipts, 1);
    assert.throws(() => foldUnverifiedUsageSnapshots("google-generatecontent-v1beta-sse-r1", [
      { receiptId: "two", sequence: 2, terminal: false, usage: {} },
      { receiptId: "one", sequence: 1, terminal: true, usage: {} },
    ]), /Invalid candidate usage fixture/);
    assert.throws(() => foldUnverifiedUsageSnapshots("unknown", []), /Invalid candidate usage fixture/);
  });

  it("does not read getters or accept multiple non-stream receipts", () => {
    let touched = false;
    const folded = foldUnverifiedUsageSnapshots("anthropic-messages-2023-06-01-nonstream-r1", [
      { receiptId: "one", sequence: 0, terminal: true, usage: { get input_tokens() { touched = true; return "PRIVATE"; } } },
    ]);
    assert.equal(touched, false); assert.equal(folded.missingReason, "usage-missing");
    assert.throws(() => foldUnverifiedUsageSnapshots("anthropic-messages-2023-06-01-nonstream-r1", [
      { receiptId: "one", sequence: 0, terminal: false, usage: {} },
      { receiptId: "two", sequence: 1, terminal: true, usage: {} },
    ]), /Invalid candidate usage fixture/);
  });
});
