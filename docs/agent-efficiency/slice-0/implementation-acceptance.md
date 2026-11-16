# Proposed implementation gates after Slice 0

These criteria refine [issue23](https://github.com/shmtoan08/SoftwareFactory/issues/23) for team review. No runtime feature, gateway API, schema, core signature or task_contract field is authorized by this document alone.

| Slice | Required evidence before acceptance |
|---|---|
| P1 checkpoint capture | Registered source/worktree and execution/generation; immutable append-only system observations; canonical stable SHA+dirty-tree binding; tool/test provenance; partial/racing capture cannot be VERIFIED; agent/tenant cannot forge or overwrite evidence |
| P1 handoff | Versioned checkpoint+bounded scratchpad states; deterministic read order; stale fingerprint/generation rejection; no scratchpad policy authority; takeover idempotency; no duplicate worker spawn |
| P1 fencing | Atomic generation transfer; stale event/Git/import writes denied; isolated new worktree and sandbox; old live process cannot alter the new checkout; real cleanup proof or HOLD; no force unlock |
| P1 death drills | All four drills from state map run against persisted state and real process/worktree effects, not self-reported memo; test result tied to SHA/fingerprint; missing checkpoint never inherits green |
| P1 cold-start metric | Actual token count before the first trusted meaningful action, with sample size/provider/missingness and recorded execution/generation; initial below25k target only after baseline review; unavailable telemetry stays unavailable |
| B-quick | L0 invariants always retained, L1 stable instructions versioned, L2 task context; anchor rules below500tokens measured with declared tokenizer; compact/restart retains L0; every verifiable invariant maps to an actual test/gate; cached/uncached measurements from provider telemetry, no saving claim before data |
| P2 optimization | Mechanically enforced discovery budget/state transition, proposed5–8search rounds reviewed against baseline; explicit not-found then implement per spec; structured retrieval; cohort P75 soft budgets; whole-lifecycle cost and handoff/rework attribution |
| P2 quality guard | Same spec/required tests/security fail-closed checks; independent first-pass/requirement/rework evidence; rollback optimization if quality regresses; do not cap mandatory validation away |
| P3 governance | Reviewed entry inventory and dynamic/native/SQL roots; per-workspace Knip report-only CI; candidates grouped by package/taxonomy and independently confirmed; no automatic deletion |
| P3 review rules | Internal/unexported unnecessary code addressed in its commit; public contract retained for architecture/integration/staged rollout with proof and expiry review. The proposed staged_rollout task-contract field itself requires an explicitly scoped contract change before use |
| P3 removal | Separate reviewed deletion/dependency commit, unchanged behavior/contract or approved removal, CI5/5; no blanket suppression that hides newly dead security code |

All slices need exact source-state evidence and CI, then the team's review/owner confirmation before checklist ticks. A Slice0 document is not acceptance of a later runtime feature. Core shared-types/adapter-sdk/task-contract changes require explicit task-contract scope; application tasks cannot casually alter them. Live vendor/caching measurements require an approved metered environment and a representative dataset; this audit makes no provider calls. Missing production telemetry does not block independent Dashboard API work already approved in issue22.
