# T1 stage D — authority and coverage readiness

Date: 2026-11-20. This is the required provider-free readiness decision under the approved T1 contract. It measures the checked-in execution surfaces; it does not make a provider call, enable a runtime collector, register a pilot prompt, promote a mapping, or authorize T2.

## Executable inventory

`telemetry-authority-readiness.test.ts` builds the repository TypeScript program, resolves receiver types, scans all production TypeScript under `apps/` and `packages/`, and pins every call to `complete` whose receiver is a `LiveModelProviderClient`, regardless of the variable or property name. The measured inventory is three direct HTTP-client dispatch surfaces: managed structured execution, independent live review, and workspace coding. It separately pins two external model CLI surfaces: Claude Code and Codex. A source change that adds or removes a direct client/CLI surface fails the audit until this decision is revisited.

Only managed structured execution has the optional observer hook. The other two direct client surfaces bypass it. Claude Code dispatches through the generic agent runtime process boundary without the observer or an authoritative per-call Cost Guard record. Codex production is correctly hard-disabled as unmetered; its emulator is not production coverage evidence. The generic `AgentRuntimeAdapter` injection point also means a source list alone cannot prove that every chargeable command is mediated.

No production source constructs `CallTelemetryObserver`. `ProductPipelineService` constructs four managed executors without `telemetryObserver`; a caller may inject a default executor, but there is no approved composition root, authenticated service secret wiring, or independent dispatch journal. Therefore observed candidate rows cannot detect a call that bypassed `begin`, and an empty observation set cannot prove zero calls.

## Measured bounds and decision

The executable audit pins the observer's structural limits: 1,024 queued/in-flight events, 16 MiB retained bytes, 16 KiB per event, batches of 100, and a 60-second event deadline. Existing B1–B3 tests prove asynchronous failure isolation, queue/drop accounting, SQL delivery and transaction-end behavior. These are delivery-safety measurements, not coverage authority. Production overhead cannot be meaningfully measured while no production collector composition exists, and inventing one in D would change the execution boundary outside the approved scope.

Readiness result: **NOT READY for TASK_BOUND or T2 baseline enrollment**. Of five known chargeable model surfaces, zero have both complete mediation and an independently authoritative dispatch/in-flight inventory. The database still enforces `binding_state = 'CALL_ONLY'`; lifecycle close still rejects; reports remain deterministically incomplete with `complete_roots = 0` and `canonical_total = null`.

Required future authority work needs separate approval: choose the eligible production execution boundary, add an authoritative dispatch/in-flight journal under the same lease/generation CAS discipline, mediate every chargeable route (or disable it for enrolled lifecycles), wire a protected service identity and reconciler, then repeat this audit with generation-race and crash-gap evidence. Protected HMAC binding can be implemented provider-free next, but it proves template identity only and cannot upgrade this coverage decision.

Review follow-up from C3: the deterministic report test now directly denies a reporter bound to another project. Mapping-version arrays are documented as canonically ordered immutable input; different order fails closed instead of silently rewriting a finalized report.
