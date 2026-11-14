# Native macOS/Lima acceptance — developer evidence

Date2026-11-14 (Asia/Tokyo). Trackers: [issue16](https://github.com/shmtoan08/SoftwareFactory/issues/16), [G7 issue18](https://github.com/shmtoan08/SoftwareFactory/issues/18). **MAC_NATIVE_EVIDENCE_READY_FOR_REVIEW**. G7 stays HOLD; Windows/WSL2 native work and the team's release decision remain outstanding. No issue/gate is self-accepted or closed.

## Exact code and host

Code under test: **[107c49df16b64c19b2f6bafd28a48914d55654e0](https://github.com/shmtoan08/SoftwareFactory/commit/107c49df16b64c19b2f6bafd28a48914d55654e0)**. Host and guest were clean, independent checkouts of that exact commit. This report/evidence is published in a later documentation commit; its HEAD is not substituted for the runtime SHA.

Owner explicitly approved provisioning a private Lima2.3.0 and `sf-native-acceptance` VM: [authorization recorded in issue16](https://github.com/shmtoan08/SoftwareFactory/issues/16#issuecomment-6877562242). Lima was installed in a private user directory, not through a global Homebrew update. No personal/default VM, host mount, cloud resource, paid model or production deployment was used. Host trust of the private test CA was process-scoped via NODE_EXTRA_CA_CERTS, with no TLS-disable flag or system keychain change.

| Component | Recorded configuration/version |
|---|---|
| Host | Intel x64 Mac; macOS15.7.9, Darwin24.6.0; Node24.16.0 |
| Hypervisor/control | Lima2.3.0, native VZ; exact binary SHA in host receipt |
| Dedicated guest | `sf-native-acceptance`,2CPU,4GiB requested RAM,16GiB sparse disk |
| Linux | Ubuntu24.04.5 LTS; kernel6.8.0-147-generic; Node24.16.0 |
| Runtime profile | Plain, no host mounts/copyToHost/additional disks/networks; agent/X11/dot-SSH forwarding and containerd disabled |
| Host connection | One static TCP forward127.0.0.1:56620 -> guest127.0.0.1:24443; private TLS proxy -> strict worker127.0.0.1:24444 |
| Credentials/state | Dedicated CA/server key and HMAC key, private control/state roots; no host/Factory/DB/Git/model credentials forwarded |
| Task policy | Native factory requires cgroupsv2, namespaces including **net**, subreaper, UID/capability drop, workspace-only writes, control/source/home masks and verified cleanup |

Public image/archive/config/profile/binary/service/proxy hashes are recorded in [provisioning](./evidence/native-lima/107c49d/provisioning.json), [host receipt](./evidence/native-lima/107c49d/host-receipt.json) and [file manifest](./evidence/native-lima/107c49d/manifest.json). Image hash is verified download provenance, not a measurement of the running root filesystem. The private CA/key, signing secret, raw service JSON, raw resolved Lima config and host-only canary value are excluded from publication. Required fixture canaries in test names are not real credentials.

## Executed native checks

| Native evidence | Actual result |
|---|---|
| Strict worker smoke + measured guest bootstrap | [worker.tap](./evidence/native-lima/107c49d/worker.tap): **4/4**,1suite,0fail/cancel/skip/todo |
| Independent isolation/adversarial suite | [isolation.tap](./evidence/native-lima/107c49d/isolation.tap): **20/20**,2suites,0fail/cancel/skip/todo |
| Network-isolated coordinator death and timeout | [network-cleanup.tap](./evidence/native-lima/107c49d/network-cleanup.tap): **2/2**,0fail/cancel/skip/todo; [exact supplementary probe](./evidence/native-lima/107c49d/network-cleanup-probe.mjs) |
| Mac -> guest worker | [host-receipt.json](./evidence/native-lima/107c49d/host-receipt.json): **HOST_BRIDGE_PASSED**, signed source/profile/boot binding, actual artifact, durable replay and epoch conflict |
| Actual HTTPS/auth rejection | [postchecks](./evidence/native-lima/107c49d/postchecks.json): signed conflicting request409; unsigned health401; client without private CA fails certificate verification |
| Final guest inventory | [inventory](./evidence/native-lima/107c49d/guest-inventory.json): no host-share mounts; host-only canary path invisible; no task cgroups/workspaces left; persisted cleanup is real, populatedZero=true, remainingProcesses0 |
| Shutdown | [guest stop](./evidence/native-lima/107c49d/guest-stop.json) and provisioning receipt: worker/proxy stopped, VM **Stopped**, host forward listeners closed |

Total **26 executed guest tests, zero skips**, plus the six host acceptance checks and actual TLS/auth postchecks. The existing strict TAP validator accepted each log. Kernel process/namespace/cgroup operations ran inside the actual VZ Linux guest, not a CLI process emulator. Independent coordinator-death/timeout probes explicitly require `net` metadata and real kernel cleanup; they supplement the baseline smoke suite's cleanup checks. Their source/boot header matches the guest/host manifests, and their exact script hash is included in the file manifest.

The guest bootstrap's untrusted task compares its `/proc/self/ns/net` identity with the parent and attempts TCP/UDP to live parent listeners. It cannot reach them or a writable Unix control socket under `/run`; source/state reads fail, and a valid artifact is exported only after cleanup. The supplementary probes kill only their own coordinator PIDs or let the native deadline expire, including detached descendants. This is task-level denial: the trusted parent worker/TLS control plane retains its network connectivity.

One earlier source51ddf37 bridge-only run remains as a completed journal record. It lacked the new task network namespace and is **not** counted as final network-isolation evidence. Discovery led to source107c49d, mandatory native network isolation, and a complete guest/host rerun on a new boot. Inventory therefore contains two completed historical records, with no active/HOLD record; the final receipt identifies only its own source107c49d execution.

## Reproduction and boundaries

Provisioning and base commands are in the [native integration runbook](./m6c3-native-vm-integration.md). Exact committed entrypoints used:

```text
Guest: node packages/test-harness/src/native-vm-guest-service.ts PRIVATE_SERVICE_JSON
Guest: SF_NATIVE_SOURCE_ROOT=/opt/software-factory SF_WORKER_TEST_CGROUP_ROOT=/sys/fs/cgroup/sf-native-acceptance node packages/test-harness/src/native-vm-guest-acceptance.ts PRIVATE_PROFILE_JSON
Guest: node --test --test-reporter=tap PRIVATE_PATH/network-cleanup-probe.mjs
Host:  NODE_EXTRA_CA_CERTS=PRIVATE_CA node packages/test-harness/src/native-vm-host-acceptance.ts PRIVATE_HOST_JSON guest-manifest.json NEW-host-receipt.json
```

Both source checkouts were pinned to107c49d; private configuration/evidence files were outside those trees. Parent controller HOME remains the actual account HOME for the private-root rejection check; child limactl HOME/LIMA_HOME are explicitly private. Git configuration inheritance was disabled for the host acceptance process. Source transfer used an offline Git bundle with an explicit main-branch checkout; no host filesystem sharing was enabled. Downloads were hash-verified before extraction/use.

The profile is the committed deterministic **provider-free** adapter, not a live AI model. Host-side checks invoke the registered connector and validate its controlled-import submission envelope/artifact; a full native Core assignment -> Git import -> verifier -> CAS business flow was not executed in this hardware batch. Existing Core/import/approval/CAS regression is separate CI evidence. This result does not activate production dispatch, unrestricted/model network egress or unmetered Codex. A future production adapter needs its own reviewed metered egress/configuration.

The private VM and files are retained for owner reuse, **powered off**. Reproduction starts only that dedicated instance, starts its worker/proxy, and reruns guest/host evidence for the new boot/source/profile. Old receipts do not establish current liveness or authorize execution after a reboot. Temporary key-bearing transfer archives were removed; private CA/key/config material remains outside Git. No global system directory permissions were relaxed.

The [source107c49d review is ĐẠT](https://github.com/shmtoan08/SoftwareFactory/commit/107c49df16b64c19b2f6bafd28a48914d55654e0#commitcomment-210005961). Its nonblocking notes about early network-namespace diagnostics, indirect override assertions and legacy network policy remain recorded; no source change was hidden under these receipts. This execution supplies the updated-SHA native rerun requested by that review. The correct Linux CI bootstrap evidence is the strict Linux external-worker job; the separate macOS job runs transport fixtures/native Codex and is not a guest-kernel substitute.

## Source CI and remaining gate

[CI43599372972](https://github.com/shmtoan08/SoftwareFactory/actions/runs/43599372972), exact source107c49d, is **SUCCESS all5jobs**. PG16/17 each **350/350 tests,51suites,0fail/cancel/skip/todo**; strict Linux worker, real gVisor and macOS/native Codex jobs passed. These CI counts are distinct from the native26-test evidence above.

Next: team reviews the Mac evidence and source mapping; Windows requires its own dedicated WSL2 native integration/acceptance and receipts. Release artifact/profile/source binding and team G7 decision remain separate. Mac success does not substitute for Windows or close issue16/G7.
