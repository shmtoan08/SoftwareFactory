# S0-C — Execution state map and checkpoint/handoff proposal

Baseline: 1f33a8b. This is a proposed contract for P1 review, not implemented runtime behavior.

| Existing boundary | Source | Trusted evidence / limitation |
|---|---|---|
| Lease acquisition/epoch/revocation | database store/repository acquireTaskLease, revokeTaskLease; task_leases | Durable attempt/epoch and active lease validation; scope for generation binding, not proof a stale worker process died |
| Event ingestion/sync | gateway worker token claims -> submitWorkerEvent/getLeaseSyncStatus; PG repository row locks/sequence/fingerprint | Ordered committed watermark and duplicate/gap/stale-lease behavior; events still do not continuously observe dirty files or authenticate arbitrary agent test claims |
| Local outbox | WNA LocalOutboxBuffer, append-only local journal/replay | Survives interrupted transport and resumes from expected_next_seq; local/agent-controlled text is not system checkpoint authority |
| Worker execution journal | WorkerExecutionJournal CLAIMED/COMPLETED, action hash, fsync/rename, cleanup evidence | Service-owned execution claim/replay/HOLD after uncertain crash; not a rich handoff checkpoint or permission to respawn an uncertain execution |
| Sandbox/process cleanup | LinuxCgroupV2SandboxBackend, native supervisor, strict worker runner | Actual cgroup/namespace/UID/process cleanup evidence; killing a host CLI or marking a lease revoked alone is not equivalent |
| Import/verifier/review/CAS | Existing controlled import and approval path | Commit/tree/candidate/evidence/approval binding remains mandatory; a green memo cannot grant merge/deployment permission |
| Model/resource ledgers | Cost Guard, model_call_ledgers, resource_usage_metrics | Existing partial counters; see telemetry gaps, no complete handoff-cost attribution yet |

## Proposed checkpoint and memo boundaries

The system checkpoint is an append-only, service-owned observation record. Derive execution/project/task/worker/lease epoch and new takeover generation from verified routing context, never request-supplied authority. Resolve source/worktree from operator registration/task contract; never let the agent choose a host filesystem path. Agent credentials cannot write/overwrite checkpoint evidence or attest their own green tests.

Candidate checkpoint envelope: version/id/observedAt; execution and lease/generation identity; source commit/tree; fingerprint algorithm/version; canonical changed-path inventory including tracked/untracked/deleted files, file modes/types/content hashes; trusted tool/test invocation id and exit/result digest bound to the exact code-state fingerprint; committed event watermark; cleanup/recovery/HOLD disposition; telemetry counters with provenance/missingness. Protected paths/secrets stay excluded from content collection under policy; rejected/oversize/symlink/invalid path states are explicit failures, never silently omitted into a misleading clean fingerprint. Source Git SHA alone cannot prove a dirty worktree's tests.

Working-tree observations may race active writers. Snapshot from an isolated registered worktree or quiesce the generation, read/recheck stability, and publish only a complete stable capture. A mixed or interrupted capture remains DRAFT/uncertain and cannot carry VERIFIED tests. Do not reuse existing writable worker event payloads as authority by renaming them checkpoint.

Memo has two layers: immutable verified checkpoint reference plus an untrusted scratchpad of at most 15 lines (decisions, traps, next step, reuse rationale). Proposed versioned states: DRAFT (incomplete/unverified), RECORDED (system durably stored observation; no automatic test claim), VERIFIED (required provenance/code-state checks succeeded), STALE (current SHA/fingerprint/generation mismatch). Missing verification leads recovery/reverification; recording alone does not mean verified. Scratchpad content is never policy, executable instructions or an approval token.

## Takeover protocol and fencing

Read in fixed order: current system policy + task_contract/spec; verified assignment/lease generation; latest verifiable checkpoint + provenance; bounded scratchpad; selected file/tool evidence. Reject scope/generation mismatch before work. Use a durable compare-and-set/lock on ownership generation and reuse existing stale-lease checks at every write/import/event boundary. Old generation credentials must fail, including delayed retries.

**Lease fencing alone does not stop stale filesystem writes.** Give the new generation a distinct service-owned worktree and sandbox; do not hand it the old process's writable directory. Revoke/fence the old generation, execute scoped cleanup and verify no descendants before admitting its artifacts or reusing resources. Uncertain cleanup remains HOLD/recovery, not forced unlock or success. Concurrent old/new agents must never share a writable task checkout. Identical takeover requests must be idempotent and may not spawn duplicate workers. Existing approval/CAS/release gates remain in force.

Required death drills: (1) edits with no scratchpad -> detect dirty state, recover from system observation or reverify; (2) test completed but checkpoint not persisted -> no durable green proof, reverify; (3) quota exhausted but old process lives -> new generation/worktree isolated, stale APIs/import denied, actual cleanup evidence; (4) memo older than tree -> STALE, no inherited test result until exact-state verification. Include process/network loss, partial writes, replay and tenant-forgery negatives. Scope/schema/roles/API for P1 are to be reviewed from this map; this audit adds none of them.
