# M6C-3 step 7 — Firecracker management API foundation

Tracker: [issue #19](https://github.com/shmtoan08/SoftwareFactory/issues/19).

Date: 2026-11-14 (Asia/Tokyo). Baseline: main `ae8b5f5`. This is an **operator-only management client**, not a Firecracker task/verifier runtime or proof of KVM isolation.

## Scope and owner decision

The owner [deferred Lima/WSL2 native acceptance](https://github.com/shmtoan08/SoftwareFactory/issues/16#issuecomment-6867968014) without waiving it and [authorized remaining Firecracker/cloud-adapter slices](https://github.com/shmtoan08/SoftwareFactory/issues/18#issuecomment-6867968607). G7 remains HOLD. No user VM, paid model/cloud call or deployment is performed in this slice.

`packages/wna/src/firecracker-api-client.ts` implements `FirecrackerApiClient` with `probe`, `pause` and `resume`. It communicates with a pre-existing operator-owned Unix API socket using actual Node HTTP requests. It does not spawn a binary or expose arbitrary HTTP paths, API payloads, boot-source/drives/network/MMDS/snapshot configuration, boot/shutdown, guest commands, process killing or VM provisioning. It is not selected by the production dispatcher or Docker verifier.

Protocol reference is the pinned [Firecracker v1.18.0 Swagger](https://github.com/firecracker-microvm/firecracker/blob/v1.18.0/src/firecracker/swagger/firecracker.yaml): `GET /` metadata and `PATCH /vm` state changes. Instance ID and application name are explicitly configured; reported version must equal1.18.0 and metadata must match the four-field schema. The read states are `Not started`, `Running`, `Paused`; resume writes `Resumed`, not `Running`. This is protocol-version checking, not binary provenance attestation.

## Trust and failure boundaries

- The configured socket path must be absolute, normalized, short enough for supported Unix platforms, under a canonical private directory. Socket and parent ownership must match the service UID or root; neither may grant group/other permissions. Ancestors must be owned by service UID/root and cannot be group/other writable except root-owned sticky directories. Symlinks, regular files, missing sockets and permissive paths are rejected. The parent/socket device+inode tuple is pinned at construction and rechecked before requests. The client does not chmod/chown/create/remove operator resources.
- Root/operator and other service-UID processes remain trusted. A self-declared API ID/version is not cryptographic attestation. Filesystem checks cannot defend against malicious root or replace jailer/seccomp/cgroup isolation.
- Production requires Linux. `testOnlyEmulator: true` is a strict constructor-only switch for Unix API transport fixtures on Darwin/Linux. No env or HTTP switch, binary/CLI execution or credential forwarding exists. The socket carries no bearer/model/Factory credentials and ignores proxy environment variables.
- Pause/resume require both lifecycle and dedicated-instance opt-in. Each operation uses a private keep-alive agent with one connection for preflight, mutation and postflight. If a connection closes and the HTTP agent tries to reconnect, the replacement socket is rejected before the request can be written. An already matching state produces metadata-only no-op; a not-started VM is never booted.
- PATCH success requires HTTP204, then same-connection metadata must confirm the expected identity/version/state. Timeouts, aborts, failed mutation responses, lost replies or failed postflight are reported as **OUTCOME_UNCERTAIN**. There is no retry, rollback, shutdown or cleanup fallback. A later explicit operator action is outside this guarantee; there is no durable operation journal in this management-only slice.
- One deadline bounds the whole operation (default10s, maximum120s), even with continuously streamed bytes. Responses have a combined per-response byte cap (default64KiB, max1MiB), header cap8KiB, strict UTF8/JSON/schema validation and fixed HTTP status/content-type checks. Redirects/compressed responses/premature closes are rejected. Error messages never include response bodies, socket paths or raw transport errors. Agent sockets and timers are disposed on every terminal path.
- Results explicitly say `evidenceKind: api-transport` and `kernelIsolationVerified: false`. Paused or API-unavailable is never equated with guest process termination, memory erasure, billing stop, resource release or a durable provider fence.

## Validation

`npm run test:m6c3:firecracker-api`: **36/36 tests,1suite,0fail/cancel/skip/todo**, Node24.16.0/macOS. Tests use real Unix sockets and HTTP servers, not mocked client functions.

Coverage: exact metadata/schema/version; each lifecycle opt-in; pause/resume payloads and postflight; state no-op and not-started rejection; postflight mismatch, dropped/error/timeout mutation with single PATCH and no cleanup; rejection of reconnect after preflight; invalid JSON/UTF8/content-type/status/encoding, header/body overflow and truncated streams; absolute deadline with continuous output; abort before/during requests; no credential/proxy forwarding; config runtime casts and bounds; platform guard; socket/parent permissions and symlinks; real inode replacement and removed socket. Fixtures close all owned connections and remove only their own temporary directory.

Local quality checks: typecheck PASS, lint175 inputs PASS, secret scan174 inputs/0leaks PASS. The suite is included in the default Linux PG16/17 regression and explicitly in the macOS job. Exact-main CI is recorded on the step7 tracker after push.

## Remaining work

Firecracker jailer/process provisioning, trusted guest kernel/rootfs provenance, vsock/guest-worker bridge, task artifact import, full KVM isolation/cleanup acceptance and durable provisioning/recovery accounting are **not implemented by this slice**. Cloud-vendor executor/fencing adapters are separate remaining work; no vendor has been chosen or cloud resources created here. Lima/WSL2 native acceptance remains deferred until dedicated hosts are available; it is not waived. Production Codex stays blocked pending trusted Cost Guard metering.

Combined local regression with Lima/WSL2: **146/146 tests,20suites,0fail/cancel/skip/todo** (Firecracker36, Lima54, WSL256). No KVM, hypervisor binary or cloud resources were used by this run.
