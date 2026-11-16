# S0-B — Token measurement readiness and missing baseline

Baseline: 1f33a8b. Result: **0 representative real task samples; no measured optimization claim**. The [machine report](./evidence/token-measurement.json) deliberately has null costs/cache counters/percentiles/budgets. This audit did not call paid providers, mine personal agent transcripts or use fixture usage as production telemetry.

## Existing evidence and gaps

| Existing source | What it establishes | Missing for issue23 |
|---|---|---|
| adapter-sdk/cost-guard.ts extractNormalizedTokenUsage | Provider input/output totals; Anthropic cache creation/read included in input; usageEstimated marks deterministic fallback | Persisted cached/uncached split, per-layer L0/L1/L2 usage and execution-generation attribution |
| shared-types ModelUsageMetrics | rawProviderUsage can exist transiently beside normalized totals | A transient provider response is not a durable audited dataset |
| ModelCallLedgerRecord / model_call_ledgers | call_id,project/cost-session/task/pipeline-session/stage, model/prompt SHA/version, actual totals/cost, usage_estimated | No direct execution/lease-generation field, handoff/rework grouping or first-meaningful-action marker; task_id alone spans attempts |
| Gateway resource metrics and WNA daemon | Recorded lease/resource wall/CPU/RSS evidence | Resource time is not LLM token usage; tool-output size is not billable or cached token count |
| Provider-free/HTTP contract tests | Adapter behavior and deterministic regression | Synthetic counters cannot establish actual spend/P75/first-pass approval performance |

No external deployment/database usage dataset is configured for this audit. Missing data is reported as missing, not zero usage. P1 may record absent optional telemetry with explicit reason/provenance; it must not promote byte estimates, worker claims or cached+uncached sums into verified measurements. Keep production Codex blocked until trusted metering exists under the existing owner policy.

## Proposed collection and budget method (not enabled)

Collect service-owned per-call records scoped to project/task/execution/lease generation and provider/model/prompt version; preserve cache input/read/write semantics, uncached input, output, actual billed cost and missing/estimated flags. Bind content-layer attribution to the prompt builder version; if provider cannot attribute layers, report unavailable rather than partitioning totals heuristically. Exclude secret prompt contents; retain only approved hashes/counters.

Predeclare S/M/L task cohorts by contract scope/risk, not by observed spending: S bounded single-package change; M approved cross-package feature; L security/recovery/schema or broad architectural work. These are proposed cohort definitions, not a code-size correctness rule. Collect representative successful, failed, resumed and reworked tasks; report sample sizes/provider mix and explicit missingness. Propose at least 30 fully attributed observations per cohort for an initial operational baseline; team may revise after seeing distribution. Compute empirical P50/P75 within comparable cohorts, prefer P75 for soft exploration/total budgets, and retain heavy tails. Until then S/M/L budget values remain null.

Metrics to instrument: total effective cost across the entire task lifecycle to merge (include failed/handoff/rework calls), first-pass approval rate with a fixed denominator, missing requirements/mandatory tests/security regressions, T_handoff/T_resume/T_rework, and actual tokens before the first verified meaningful action after takeover. Precisely mark that action through trusted tool/test/worktree observation; a scratchpad claim does not count. The initial cold-start target below 25,000 tokens is the brief's proposed target, not a current test result. Do not resurrect the discarded below 10 percent rule for small tasks.

No optimization is allowed to pass merely by reducing tokens while quality worsens. Compare matched scope/provider/model/contract cohorts, require the same spec and mandatory tests, and rollback the optimization slice when independent quality/rework guards regress. B-quick caching is only measurable after real cached/uncached telemetry; prompt separation can be specified before claiming a saving.
