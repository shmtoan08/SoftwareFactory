# M6C-3 bước 5 — Signed Linux worker endpoint

Implementation branch: `m6c3/worker-endpoint`, based on reviewed `f1760ef`. Tracking: [issue #13](https://github.com/shmtoan08/SoftwareFactory/issues/13). This report covers Agent A's endpoint/journal/runner work. Independent Agent B isolation review and completed Linux CI evidence must be considered separately; this is not G7 acceptance.

## API and operating boundary

`createWorkerEndpointServer(config)` is exported from WNA. `listen()` returns `{port, endpoint}`; `close()` aborts active requests and waits for runner cleanup. The listener binds loopback only; an operator supplies TLS termination before registering an HTTPS client endpoint in Core. There is no public-listener switch, default CLI daemon, environment loader or automatically provisioned VM/cloud service.

Config pins tenant namespace, principal/worker/provider/model, dedicated HMAC secret and a private service-owned filesystem journal. Production configuration requires `LinuxWorkerEndpointRunner`; constructor-only `testOnlyEmulator` permits a protocol-test runner. Test hooks cannot be enabled through HTTP/environment. Production Codex remains blocked in SDK, broker, endpoint and concrete runner.

The server implements existing `/health` and `/execute` `sf-target-v1` routes and exact signed response fields. Requests use timing-safe MAC validation, exact schema/UUID/epoch/base/deadline validation, bounded PUBLIC context and path patterns. Request caps are 16 KiB for health and 192 KiB for execute; the existing 3 MiB response cap remains. Execute action data cannot inject paths, shell commands, runtime options, clone URLs or credentials. Eight active authenticated requests per service instance bound concurrency; Core retains project/task budgets and scheduling limits.

Protocol v1 is synchronous and has no cancel/status API. An elapsed deadline, client disconnect, service close or AbortSignal causes the concrete runner to kill-and-verify; the independent native deadline also bounds a stalled coordinator. Upstream lease revocation still fences import. Immediate push revocation notification to a remote service is not implemented; cleanup may wait for disconnect/deadline. No remote billing/model Cost Guard accounting is claimed.

## Durable execution and replay

A local filesystem journal namespaces by operator tenant and execution UUID; the dedicated key must be unique to that tenant/service. The full action has a canonical SHA-256. Creating an execution directory atomically reserves the ID across service instances/processes. Claim content and parent directories are fsynced before the runner call. A crash after directory creation but before record persistence leaves HOLD, never a reusable ID.

Only the claim owner invokes the runner. A matching nonterminal claim returns 409 HOLD, even after restart; conflicting action content returns 409 CONFLICT. There is no timeout/PID-based lock stealing, automatic respawn or force-unlock. Terminal state stores the validated submission and cleanup evidence; it is atomically replaced with fsync. A replay reads that DTO and signs a new response for the current nonce. Failure after a claim or before terminal persistence leaves HOLD. Operator investigation is required; this slice does not implement a recovery approval UI.

Use a private, service-owned local state directory, outside task workspace, backed by a filesystem with reliable mkdir/rename/fsync semantics. NFS/shared network storage and shared or task-writable state directories are unsupported. Disk rollback, malicious operator modification and storage failure are not exactly-once guarantees. As in the broker, durable intent prevents automatic duplicate invocation; uncertain remote effects are not assumed absent.

## Strict Linux runner

An operator registers public baseline commits to local Git repositories. The runner validates baseline paths/modes and fetches the exact pinned commit into a fresh independent repository; no private Factory repository credential or Gateway token is used. Only PUBLIC action context and allowed files become adapter context. This reuses `AgentRuntimeAdapter.prepareInvocation` and cleanup, not `WnaWorkerDaemon.executeLease` or synthetic TaskRecord/lease records. No model provider key is supplied by this runner.

All execution uses the real Linux backend, forced cgroups v2, namespaces, subreaper and UID/GID drop. Opt-in `externalWorkerGuard` also requires all those flags, sets per-execution pids/memory/CPU ceilings (64 / 512 MiB / half a CPU), and enables native coordinator-death signaling and a monotonic maximum runtime. Existing WNA callers retain their previous mode unless they explicitly opt in.

The native worker mounts the host recursively read-only using mount_setattr and reopens only its task workspace for writes; task mounts are nosuid/nodev. Unsupported kernels/permissions fail closed. Service state is masked and process environment is allowlisted. Public baseline source remains outside the writable task clone. Native parent-death monitoring binds the coordinator before fork and rechecks ownership; after coordinator death it kills/reaps descendants and drains/removes its exact cgroup rather than rediscovering ownership by a recycled PID.

A successful result requires verified real-kernel cleanup: zero population, no remaining process and removed cgroup. Only then does the parent walk regular filesystem entries, reject links/oversized trees/out-of-scope changes, and emit bounded artifact operations. It never runs Git in the agent-modified repository after execution, preventing hooks/fsmonitor/config from executing on the host. Cleanup evidence is persisted in the journal; it is never added to v1 response fields. Uncertain workspaces are retained for inspection.

Health runs an actual short strict sandbox probe, including filesystem setup and cleanup; it is still a configured endpoint declaration, not remote hardware attestation. A paid model runtime without trusted metering is not enabled by passing this probe.

## Validation and remaining work

Agent A focused suite: **8/8 passed** on Node24.16 / Darwin, no skips. It exercises the real HTTP server/HMAC client and filesystem journal with an explicitly injected provider-free runner emulator: fresh-nonce replay, cross-instance claim contention, authentication/schema/deadline limits, shutdown waiting for cleanup, lost terminal persistence, actual child-process death before runner and Core broker/controlled artifact import preserving main. Production runner injection/cleanup guards and unsupported-host fail-closed are checked separately. These tests do not prove Linux isolation.

Full local PostgreSQL17 regression: **145/145 passed, 19 suites, 0 failures/skips** (~301 seconds); lint/strict TypeScript and secret scan passed.

A dedicated strict Linux CI suite has three no-skip cases: concrete runner filesystem/secret/artifact cleanup, native coordinator death with detached descendants, and native monotonic timeout. It requires root, a dedicated delegated cgroups v2 root and actual namespaces/mount_setattr. Missing prerequisites fail rather than skip. Source commits, full PG16/17 regression counts, completed Linux evidence and independent Agent B review are tracked in issue #13 and the local handoff; no result is assumed before those runs finish.

The endpoint does not provision VMs, install a TLS proxy, deploy a cloud service, provide private repository access, implement vendor cancellation/fencing or enable Lima/WSL2/Firecracker. Tier 3/4 concrete supervisors and final M6C/G7 acceptance remain separate work.

The initial `b51cf44` Linux CI job completed successfully in [run 43384128007](https://github.com/shmtoan08/SoftwareFactory/actions/runs/43384128007), exercising all three strict cases on a real Linux host. Exact final source validation and independent-review status are recorded in issue #13 / PR #14; those records distinguish the subsequent shutdown refinement from this initial kernel evidence. Main remains the reviewed baseline until integration is accepted.


## Independent acceptance integration

Agent B's final handoff (`7451874`, `06a7edc`) is integrated on the PR branch. Its endpoint cases now exercise the production HTTP server/journal with a declared runner emulator. Integration review fixed TAP no-skip enforcement, dedicated cgroup root propagation and an empty Linux guard-test branch. See [independent validation](./m6c3-worker-isolation-validation.md). The existing strict Linux job also runs all 20 independent cases and an intentional skipped-TAP negative probe; the ordinary PG regression remains 145 cases, with Linux-only acceptance kept in its explicit kernel job. Completed exact-commit evidence and acceptance status are tracked in issue #13 / PR #14.
