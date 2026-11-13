# G7 release readiness — evidence audit

Tracker: [G7 issue #18](https://github.com/shmtoan08/SoftwareFactory/issues/18); native implementation/evidence remains under [issue #16](https://github.com/shmtoan08/SoftwareFactory/issues/16).

Audit date: **2026-11-14** (Asia/Tokyo). Code baseline: [`78f1b7c190f82ef0aa3088c08b8ede5559aeb838`](https://github.com/shmtoan08/SoftwareFactory/commit/78f1b7c190f82ef0aa3088c08b8ede5559aeb838). **Decision: HOLD — full G7 is not accepted.** This audit starts the release gate; it does not waive unfinished M6C scope or grant deployment approval.

The latest [source review is ĐẠT](https://github.com/shmtoan08/SoftwareFactory/commit/78f1b7c190f82ef0aa3088c08b8ede5559aeb838#commitcomment-209926336), with no requested code fixes remaining in that batch. [Issue #17](https://github.com/shmtoan08/SoftwareFactory/issues/17) remains open for the team's checklist/closure; review acceptance of source is distinct from release acceptance.

## Gate criteria and evidence

The governing criteria are the [M6C scope](./m6c_parallel_execution_adapters_imports_targets_v1_5.md) and [roadmap M6/G7 criteria](./software-factory-development-roadmap.md). Existing implementation and tests are evidence, not a newly granted milestone approval.

| Requirement | Verified evidence at the code baseline | Remaining release work |
|---|---|---|
| M6A: provider configuration, Cost Guard, Stages 1–4 | `m6a-acceptance.test.ts`, managed-model/provider implementation; included in PG16/17 regression | Retain reproducible configuration and sample artifacts in the release evidence package; HTTP provider fixtures do not prove live vendor behavior |
| M6B: Stages 1–9, CR and 100% traceability | `m6b-acceptance.test.ts`, including M6B-AC4 end-to-end release package and AC7 database/upgrade checks | Bind the selected release package/traceability hashes and approval decision to the release candidate; do not substitute a test count for its acceptance record |
| M6C parallel/RLS/CAS, budget auto-pause, additional imports | [M6C-1](./m6c1-validation-report.md), [M6C-2](./m6c2-validation-report.md), acceptance/import/security suites | Record enabled runtime/import profiles; production Codex remains disabled by owner policy until trusted metering exists |
| Kernel-isolated verification and Linux worker | [gVisor](./m6c3-validation-report.md), [worker](./m6c3-worker-endpoint-validation.md), [independent isolation](./m6c3-worker-isolation-validation.md); mandatory Linux jobs pass | This proves the tested Linux/gVisor path, not execution inside a Lima/WSL2 guest |
| Managed worker on macOS/Lima and Windows/WSL2 | [Lima CLI foundation](./m6c3-vm-lima-validation.md), [WSL2 CLI foundation](./m6c3-vm-wsl2-validation.md) | **Required native integration/evidence missing**: worker routing inside real guests, SandboxIsolationTestSuite, host/guest credential and filesystem boundaries, process cleanup. Lima native start/diagnostic are still blocked |
| Approved production deployment and recovery | [Deployment gate](./m6c3-deployment-validation.md), [reconciliation](./m6c3-reconciliation-validation.md); durable claims, signed decisions, terminal fencing contracts | Actual target executors/verifiers are operator-injected; a production deployment profile requires a chosen implementation and provider-specific fencing evidence before activation. No deployment is authorized by this audit |

## Exact source validation

[CI run 43522908281](https://github.com/shmtoan08/SoftwareFactory/actions/runs/43522908281) targets **78f1b7c**, with all five jobs successful:

- PostgreSQL 16 and 17: **287/287 tests each, 47 suites, zero fail/cancelled/skipped/todo**.
- macOS: provider-free native Codex sandbox plus Lima CLI fixtures/Darwin guards.
- Strict Linux external worker: real smoke, independent isolation acceptance and strict TAP negative probes.
- Real gVisor verifier: mandatory runtime execution, without fallback.

Local VM adapter suites at the same baseline: Lima54 + WSL256 = **110/110**,19suites,zero skips. These are executable CLI fixtures, not native VM evidence. The source baseline remains explicit if a later documentation commit changes Git HEAD.

## Scope choices that must not become invented blockers

- The specification describes **gVisor / microVM** as isolation alternatives. gVisor already has real CI evidence. Firecracker is not implemented and remains a declared roadmap item, but requiring Firecracker *in addition* to gVisor for G7 needs an explicit scope decision; this audit does not invent that requirement.
- Tier2/3/4 HTTP protocol clients and a concrete Linux endpoint exist. Vendor cloud provisioning is not supplied by those clients. A chosen cloud deployment/execution profile needs a real adapter and acceptance; no particular cloud vendor is mandated or selected here.
- Owner policy blocks production Codex without trustworthy per-call Cost Guard. Emulator contract tests do not remove this restriction. A restricted release must clearly list disabled features; it must not be labeled full M6C/G7 while required cross-platform worker capabilities remain missing.
- Native Lima `stop()` is deliberately supported only with lifecycle + dedicated-instance opt-in and pinned identity/state reprobe. Native start/diagnostic remain fail-closed. No new native permission or bypass is introduced.

## Next implementation slice: native VM worker integration and acceptance

This is remaining M6C work **before full G7**, tracked under issue16. Implement and validate each host separately; preserve the existing worker and verifier protections.

1. **Provisioned test environment:** operator-owned dedicated macOS/Lima and Windows/WSL2 hosts, pinned guest identity, private state root and recorded host/guest versions. Do not reuse a user's default VM/distro or treat host OS detection as proof. Current development host is Darwin with no `limactl` in PATH; no native Windows host has been supplied.
2. **Safe native control path:** resolve Lima existing-only startup and SSH/login/control-socket boundaries before removing its guards. No create/download fallback, inherited host-home mounts, credential/agent forwarding or user-profile execution accepted as isolation. Use supported mechanisms and record their limits; never just flip `testOnlyEmulator`.
3. **Actual worker bridge:** run `LinuxWorkerEndpointRunner` inside the guest and connect through the existing signed, identity-pinned protocol. Keep the service tenant/key/state separate from task workspaces. Do not replace it with arbitrary guest diagnostic commands or model calls without Cost Guard.
4. **Execute native isolation acceptance:** cgroupsv2/namespaces/subreaper/UID drop, workspace-only writes, no host/home/credential access, no unintended network/Docker socket, parent/coordinator death, timeout and descendant cleanup, artifact export only after verified kernel cleanup, replay/HOLD behavior. All required checks execute with zero skips.
5. **Evidence binding:** record source SHA, host/guest instance identity, guest image/config digest, exact commands, test counters, redacted logs/artifact hashes and cleanup evidence. Bind the evidence to the release candidate; CLI fixture PASS cannot populate a native acceptance result.
6. **Release package:** rerun required source CI, attach sample pipeline/traceability/release records and enabled/disabled profile matrix, then obtain the team's explicit G7 decision. Team owns issue ticks/closure and gate acceptance.

Native-host access/configuration and target selection are inputs still needed for real execution. This audit neither installs/starts VMs nor calls paid models/cloud services, deploys production, or changes approval/Codex policy.
