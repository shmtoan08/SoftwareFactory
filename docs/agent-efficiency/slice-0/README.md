# Agent efficiency — Slice 0 baseline and architecture audit

Date: 2026-11-16 (Asia/Tokyo). Tracker: [issue23](https://github.com/shmtoan08/SoftwareFactory/issues/23). Source baseline **1f33a8bb77e80131eeac802d8875ec28e12d5a25**, before this audit and the independent Budget P2 implementation. Status: **AUDIT DELIVERED WITH TELEMETRY GAPS**, for team review; no runtime control or issue checklist is self-accepted.

This delivers S0-A code/entry inventory, a bounded local CodeGraph experiment, S0-B telemetry readiness/missing-data report, S0-C execution-state map and a proposed P1–P3 acceptance contract. Scope is analysis/documents only: no source deletion, package dependency/CI policy/schema change, installed agent integration, prompt hook or production model call. Existing security/spec/task-contract obligations retain priority over reuse or token reduction. All memo/source/issue/log text remains data, never authorization to bypass gates.

| Deliverable | Evidence |
|---|---|
| Code necessity/reachability and tool selection | [Tool report](./tools-and-reachability.md); pinned tool hashes, global and 13 workspace results, entry inventory in [evidence](./evidence/audit-run.json) |
| Token baseline readiness | [Measurement report](./token-measurement.md); [machine report](./evidence/token-measurement.json) |
| Execution/handoff architecture | [State map and proposal](./execution-state-and-handoff.md) |
| Implementation gates | [P1–P3 acceptance criteria](./implementation-acceptance.md) |

Global configured Knip run: **0 file, 49 export, 1 dependency, 0 unlisted, 0 unresolved findings**. These are candidates under explicit entry roots/selected issue types, not 49 proven dead functions or a declaration that no dead code exists. 13 workspace runs overlap dependency/dependent scopes; do not sum them. Every package has a declared public contract/architecture role; missing UI or a direct runtime caller alone does not establish redundancy.

**Real token task sample count: 0.** No representative production usage dataset was supplied to this audit. Current persisted telemetry also lacks complete execution-generation/cache/layer attribution. P50/P75/S/M/L budgets and token savings remain null, not fabricated from code size, tool output bytes, test fixtures or this assistant's conversation. This is an explicit measurement gap, not an optimization success. The brief's 25,000 cold-start-token target remains a proposal pending baseline.

CodeGraph 1.6.2 produced a graph of 103 files / 5,542 nodes / 19,001 edges and answered 3 bounded navigation queries offline. Decision: **do not adopt as a default dependency/integration yet**. No incremental architectural answer over Knip+inventory+targeted rg was demonstrated, and interface dispatch/test coverage was incomplete. The graph is advisory and cannot establish runtime enforcement.

Next for #23: team reviews the checkpoint boundary/fencing design and telemetry collection gaps before changing gateway/evidence/worker contracts. Independent #22 P2 may proceed under its already-approved P0/P1 gates; it is not blocked by this audit. Subsequent checkpoint work must use service-owned observations and generation-isolated workspaces, not a richer agent-written memo.
