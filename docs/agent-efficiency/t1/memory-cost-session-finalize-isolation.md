# Memory cost-session finalize isolation

Issue #23 separates this fix from E1 accounting links. On baseline `a8d0fc9`, memory applied session totals directly to a shared map. Finalize A could write 1 and release its per-call lock while its transaction was open. Finalize B could then add 2 and commit. A's conditional undo skipped the newer value, leaving totals 3 and only B's ledger of 2.

Memory finalizers now queue by cost-session ID and keep their reservation in that queue until the owning transaction commits or finishes rollback. The same transaction reuses its queue position. The existing per-call lock still serializes calls inside that transaction. Separate cost sessions have independent queues. The scope is finalize and the cost-session lock. SQL, guards, and accounting-link work are unchanged.

A caller that never settles its transaction can still hold the lock. The proposed operational boundary is a caller-owned transaction deadline and cancellation that settles the transaction. A waiter-only timeout could return while the owner keeps its provisional writes, and choosing a new timeout/error for legacy callers requires separate review. Regression tests use a bounded deadline to detect any unexpected lock hang.

E2 provider-free integration should exercise concurrent enrolled finalizers on one session and confirm cancelled operations settle their owning transactions.

## Other conditional undo users

The shared `setInMap` helper restores a prior value only when the current value still equals the value that write installed. Excluding cost sessions, these memory maps use it and have not been probed for analogous transaction schedules:

- `agentOrganizationProfiles`, `baselineSpecFreezes`, `budgetPauseEvents`, `changeRequests`, `codeImportSubmissions`, `devEpics`, `devMilestones`, `devUserStories`, `executionAssignments`.
- `gitCommitsByProject`, `gitRefsByProject`, `mergeQueueEntries`, `modelCallLedgers`, `outboxEvents`, `pipelineSessions`, `productionApprovals`, `productionDeployments`.
- `projectBootstraps`, `projectBudgetPolicies`, `projects`, `reconciliationApprovals`, `reconciliations`, `releaseAcceptancePackages`, `stage1DiscoveryItems`, `stageApprovalGates`, `stageArtifacts`.
- `targetDispatches`, `taskBudgetPolicies`, `taskDependencies`, `taskLeases`, `taskPlanLinks`, `tasks`, `verifiedCodeImports`.

Their use of the helper does not establish that they have the same issue.
