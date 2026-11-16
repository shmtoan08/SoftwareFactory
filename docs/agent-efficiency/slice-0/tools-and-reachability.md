# S0-A — Code necessity, entry points and tool selection

Baseline and scope are in [README](./README.md). [audit-run.json](./evidence/audit-run.json) records source tree, tool versions and npm integrity; [entrypoint-inventory.json](./evidence/entrypoint-inventory.json) covers all 13 workspaces. Tools were installed with ignore-scripts into a disposable directory outside the product worktree; npm manifests/lockfile are unchanged. Analysis ran in a separate local clone, with a private HOME and a macOS sandbox profile `(version 1) (allow default) (deny network*)`. Package acquisition happened before analysis; repository indexing/queries had no network access.

## Entry-point inventory beyond TypeScript imports

| Roots | Role and reason to retain |
|---|---|
| apps/core-api, apps/agent-gateway, apps/web src/main.ts and src/index.ts | HTTP service launchers and public service APIs; route dispatch lives in http-server/controller methods and cannot be judged solely from export callers |
| packages/* package.json exports -> src/index.ts | Versioned cross-package architecture contracts, including adapters/interfaces; no UI/route is required for libraries |
| Root package.json test/start scripts, .github/workflows/ci.yml | Test entry points, strict Linux/native guest and provider-free process probes; a test absent from default npm test may still be a mandatory platform CI command |
| scripts/ci, scripts/git-hooks/pre-receive | Shell/process/Git hook roots, invoked externally; C supervisor is selected/compiled by WNA, not a TypeScript module import |
| native-vm guest-service/guest-acceptance/host-acceptance CLIs and fixtures | Operator or child-process entry points; classify as operational/platform-specific, not automatically unused |
| Database migrations/RLS/functions | Schema/security entry points; Knip and CodeGraph are not SQL policy reachability proofs |
| task contracts, registries, constructor-injected adapters | Architectural/dynamic roots requiring review of registration and bindings before an unused label is confirmed |

## Knip baseline

Knip **6.45.1**, Node 24.16.0. Exact disposable [config](./evidence/knip-audit-config.json), [global result](./evidence/knip-global.json) and [per-workspace counters](./evidence/workspace-summary.json) are published. Invoke from the baseline clone with the config path: `knip --config CONFIG --include files,exports,dependencies,unlisted,unresolved --include-entry-exports --no-exit-code --reporter json`; repeat with `--workspace WORKSPACE` for each inventory entry. The underlying package results are retained separately. Report-only exit 0 does not mean no findings.

Entry roots explicitly include public library indexes, service launchers, tests, process fixtures and operational CLIs. Global findings: 0 files, 49 exports, 1 dependency, 0 unlisted, 0 unresolved. Excluded issue kinds (for example types/internal locals) and non-TS artifacts limit coverage. Individual workspace counts include related workspaces and are not additive. Future P3 must review narrower production/test views as well as this inclusive architecture view before deletion.

| Concrete finding/sample | Classification and disposition |
|---|---|
| WNA barrel exports Wsl2VmBackend, LimaVmBackend, FirecrackerApiClient flagged | Public staged architecture contracts required by issues 16/19; implementations/CLI tests import module paths directly. Unused barrel export is not dead implementation. Retain; track actual runtime activation separately |
| shared-types TERMINAL_WORKER_EVENT_TYPES / isValidTaskStateTransition | Public protocol/state contracts; caller absence alone is insufficient. Review against event/state spec before any deletion |
| apps/web dependency @software-factory/observability | Confirmed no direct source import at this baseline; candidate unused direct dependency, not proof observability package is globally dead. P3 can propose a separate removal commit with full tests |
| Constants/helpers in exported SDK/library modules | Classify exported contract versus duplicate/private implementation individually; no blanket ignore or deletion applied |
| C supervisor, SQL migrations and shell hooks | Outside selected TS analysis; explicitly retained through non-TS inventory and CI/process evidence |

No candidate was automatically removed. P3 taxonomy must separate unused file/export/dependency, unreachable route, replaced implementation, duplicate logic and unnecessary abstraction. A route/helper/library with an explicit spec/task-contract or architecture role is valid even without a UI.

## Bounded CodeGraph experiment

Candidate selected explicitly: **@colbymchenry/codegraph 1.6.2**, repository https://github.com/colbymchenry/codegraph. The unrelated unscoped npm codegraph package was inspected as metadata only and was not installed. Official [telemetry guidance](https://github.com/colbymchenry/codegraph/blob/main/TELEMETRY.md) documents CODEGRAPH_TELEMETRY=0, DO_NOT_TRACK=1 and CODEGRAPH_NO_UPDATE_CHECK=1; all were set before running, with network additionally denied. No `codegraph install`/MCP/agent integration was run. This pinned CLI did not expose README's local-only flag in init help, so `init --yes .` ran only in the disposable clone, never the shared agent worktree.

Index wall time 16.48 s (tool reports graph construction 2.0 s), 103 files, 5,542 nodes, 19,001 edges. Index was bounded 90 s, each query 25 s; [query exit/time/output-byte counters](./evidence/codegraph-queries.json) are measurements, not token counts. Knip global wall time 2.78 s; per-workspace timings are in the summary.

- [Callers of recoverBudgetDenials](./evidence/codegraph-callers-recovery.txt) identified getProjectBudgetSnapshot and assertBudgetAllowsExecutionSql, matching the source audit/targeted search. Useful navigation, no new answer beyond current inventory/search.
- [Project-read exploration](./evidence/codegraph-explore-project-read.txt) followed interfaces but reported no tests within 3 caller hops for several readers despite the existing dashboard-project-reader.test.ts coverage. Test absence in this graph must never justify deleting a reader or dropping tests.
- [revokeTaskLease definitions/trail](./evidence/codegraph-node-revoke.txt) exposed four overload/implementation locations, but did not prove revocation kills a process or fences its filesystem writes. Those are runtime/generation-isolation questions.

**Decision: do not adopt by default.** Retain the experiment evidence, not a runtime dependency or policy requirement. Reconsider only after a bounded benchmark demonstrates an additional correct answer over Knip+inventory/rg and reduced actual discovery cost without losing requirements/tests; output byte counts alone cannot prove token savings. Source/interface linking and excluded tests/native/SQL layers require independent checks. Official Knip sources: [configuration](https://knip.dev/reference/configuration), [workspace scope](https://knip.dev/features/monorepos-and-workspaces), [JSON reporter](https://knip.dev/features/reporters).
