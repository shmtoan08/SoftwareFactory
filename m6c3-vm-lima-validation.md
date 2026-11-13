# M6C-3 Step 6 — Lima VM Backend Foundation Technical Validation Report

**Authors**: Agent B (initial implementation), Agent A (integration and review follow-up)\
**Tracker**: [Issue #16 — VM Backend Foundation](https://github.com/shmtoan08/SoftwareFactory/issues/16)\
**Baseline SHA**: `9d2aea69c636bc500f92ff7a7489f4d0b8834894`\
**Initial main commit**: `b6e08b5ccb91c22a95f1f9b16b5d4740f64db306`\
**Hardening main commit**: `1cbf54a`\
**Published branch**: `main`\
**Updated**: 2026-11-14\
**Status**: CLI foundation implemented; integration validation below; native Lima acceptance PENDING (native start/diagnostic fail closed)

---

## 1. Executive Summary & Review Follow-up Addressing

This report documents the hardened implementation and validation of the Lima VM backend foundation (`LimaVmBackend`) for Software Factory M6C-3 Step 6, addressing all review findings detailed in `rounds/lima-transfer/AGENT_B_FOLLOWUP.md` (L-1 through L-5):

1. **L-1 — Inherited Pipe False Success Defense**: Removed the 300ms normal-exit success fallback. When a direct CLI child exits while background descendants keep stdout/stderr open, the execution deadline remains fully armed until stream closure (`close`). When the timeout expires, it rejects with `ERR_VM_COMMAND_TIMEOUT` (reporting uncertain state) rather than falsely reporting `{ exitCode: 0, stdout: "" }`. Tested with direct-parent-exited-0 + background-descendant-alive with real PID cleanup.
2. **L-2 — Unsupported CLI Flag & Version/Schema Reference (Lima v2.0.3)**:
   - Official `limactl shell` in Lima v2.0.3 ([shell.go](https://raw.githubusercontent.com/lima-vm/lima/v2.0.3/cmd/limactl/shell.go)) does NOT support a `--user` flag.
   - Removed `guestUser` from `LimaVmBackendConfig`. If supplied, constructor explicitly rejects with `ERR_LIMA_UNSUPPORTED_OPTION`.
   - Pinned and documented supported Lima CLI reference version `v2.0.3` ([start.go](https://raw.githubusercontent.com/lima-vm/lima/v2.0.3/cmd/limactl/start.go), [shell.go](https://raw.githubusercontent.com/lima-vm/lima/v2.0.3/cmd/limactl/shell.go)).
   - Proposed integration exports use `.ts` conforming to repository convention.
3. **L-3 — Strict Status/Schema & Execution Precondition**:
   - Structured JSON parser strictly validates official Lima status enum: `"Running" | "Stopped" | "Installing" | "Broken" | "Uninitialized"`. Unknown or empty status fails closed with `ERR_LIMA_OUTPUT_UNRECOGNIZED`.
   - Validates optional fields: `dir` (string), `arch` (string), `vmType` (string), `sshLocalPort` (integer bounded `0..65535`).
   - `execOperatorCommand` enforces `probeResult.status === "Running"`. If the instance is `Stopped`, `Installing`, `Broken`, or `Uninitialized`, execution halts immediately with `ERR_LIMA_INSTANCE_NOT_RUNNING` without invoking `limactl shell`.
   - `start` and `stop` reject `Broken` or `Installing` states without invoking CLI operations.
   - Parser errors never reflect raw unparsed JSON lines to prevent credential leakage.
4. **L-4 — Pin State/Home & Env Snapshot**:
   - Minimal host environment is snapshotted once at construction time (`this.pinnedHostEnv`) via `buildMinimalHostEnv(config.limaHome)`.
   - Subsequent mutations of `process.env` (`HOME`, `LIMA_HOME`, `PATH`, `SSH_AUTH_SOCK`) do not alter execution environment or target registry across subsequent probe and execution calls.
   - Uses official environment variable `LIMA_HOME` only (no unverified `LIMAHOME`).
5. **L-5 — Honest SSH/Login Boundary & Native Fail-Closed Operations**:
   - Lima v2.0.3 `limactl shell` utilizes the instance's generated `ssh.config` (which may include `ControlMaster` socket reuse or `ForwardAgent`) and executes a login shell before command invocation. Stripping host `SSH_AUTH_SOCK` at spawn time does not guarantee absence of control socket reuse, nor does `/usr/bin/env -i` prevent guest login profile side-effects.
   - `limactl start` lacks an `--existing-only` flag, leaving a non-atomic TOCTOU window where an instance deleted after `probe()` could trigger template auto-creation.
   - Therefore, native execution (`testOnlyEmulator !== true`) of both `start()` and `execOperatorCommand()` fails closed with `ERR_LIMA_NATIVE_BOUNDARY_UNSUPPORTED`.
   - All contract CLI argv paths, timeouts, stream piping, and boundary tests remain validated via constructor-only emulator fixtures (`testOnlyEmulator: true`). Native Lima host evidence is marked **PENDING**.

---

## 2. Technical Design & Structural Contract

### 2.1 Configuration Interface (`LimaVmBackendConfig`)
```typescript
export type LimaInstanceStatus = "Running" | "Stopped" | "Installing" | "Broken" | "Uninitialized";

export interface LimaVmBackendConfig {
  readonly binaryPath: string;           // Absolute path to limactl or fixture binary
  readonly instanceName: string;         // Operator-registered Lima instance identity
  readonly limaHome?: string;            // Optional absolute LIMA_HOME directory
  readonly allowLifecycle?: boolean;     // Default: false (must be boolean)
  readonly dedicatedInstance?: boolean;  // Default: false (must be boolean)
  readonly commandTimeoutMs?: number;    // Default: 10000ms (10s), integer bounded <= 120000ms (120s)
  readonly maxOutputBytes?: number;      // Default: 65536 bytes (64 KiB), integer bounded <= 1048576 (1 MiB)
  readonly testOnlyEmulator?: boolean;   // Default: false (must be boolean)
}
```

### 2.2 Probing Contract (`probe()` & `parseLimaListJsonOutput()`)
- Invocations: `limactl list --json` (Lima v2.0.3)
- Supported Formats: JSON Lines (JSONL stream) and JSON array.
- Status Validation: Must match `SUPPORTED_LIMA_STATUSES` (`Running`, `Stopped`, `Installing`, `Broken`, `Uninitialized`).
- Strict Identity Matching: Matches `entry.name === config.instanceName` strictly (case-preserving exact match).
  - Missing matches throw `ERR_LIMA_INSTANCE_NOT_FOUND`.
  - Duplicate matches throw `ERR_LIMA_INSTANCE_AMBIGUOUS`.
  - Does not fall back to `default`.

### 2.3 Lifecycle Contract (`start()`, `stop()`)
- Guard: Both `allowLifecycle: true` and `dedicatedInstance: true` are required.
- Native Guard: `start()` requires `testOnlyEmulator: true` to prevent TOCTOU template creation; native mode throws `ERR_LIMA_NATIVE_BOUNDARY_UNSUPPORTED`.
- State Enforcement:
  - `start()`: Pre-probes instance; if `Running`, returns immediately (no-op). If not `Stopped`, rejects with `ERR_VM_START_FAILED`.
  - `stop()`: Pre-probes instance; if `Stopped`, returns immediately (no-op). If not `Running`, rejects with `ERR_VM_STOP_FAILED`.

### 2.4 Diagnostic Execution Contract (`execOperatorCommand()`)
- Native Guard: Fails closed in native mode (`testOnlyEmulator !== true`) with `ERR_LIMA_NATIVE_BOUNDARY_UNSUPPORTED`.
- Pre-Probe Running Gate: Runs `await this.probe(signal)` and verifies `status === "Running"`. If not running, throws `ERR_LIMA_INSTANCE_NOT_RUNNING` without spawning `limactl shell`.
- TOCTOU Notice: The probe-before-exec pattern confirms instance presence and Running state immediately prior to invocation; non-atomic TOCTOU inherent to external OS process launches is acknowledged.
- Argv Construction (Lima v2.0.3):
  `["shell", config.instanceName, "/usr/bin/env", "-i", command, ...args]`
- Host Environment: Pinned snapshot from constructor using `buildMinimalHostEnv(config.limaHome)`. `SSH_AUTH_SOCK` and `SSH_AGENT_PID` stripped.

### 2.5 Timeout, Abort & Inherited Pipe Hang Defense
- Read-end stream handles (`child.stdout.destroy()`, `child.stderr.destroy()`) are destroyed upon termination.
- Exited parent processes (`child.on('exit')`) do not finalize with false success; the execution timer remains armed until stream closure (`child.on('close')`).
- If descendants hold pipes open past `commandTimeoutMs`, the timeout triggers stream destruction, `SIGTERM` / `SIGKILL` escalation, and rejects with `ERR_VM_COMMAND_TIMEOUT` / `ERR_VM_COMMAND_UNCERTAIN`.

---

## 3. Test Matrix & Results

Suite: `packages/test-harness/src/m6c3-vm-lima.test.ts`\
Runner: Node.js v24 (`node --test`)\
Total Test Cases: **54**\
Total Test Suites: **10**\
Passed: **54** | Failed: **0** | Cancelled: **0** | Skipped: **0** | Todo: **0**

| Group | Description | Cases | Outcome |
|---|---|---|---|
| Group 1 | Production Platform Guard & Configuration Validation | 11 | 11 PASS |
| Group 2 | Structured JSON Output Parsing (`parseLimaListJsonOutput`) | 9 | 9 PASS |
| Group 3 | Instance Probing Contract (`probe()`) | 4 | 4 PASS |
| Group 4 | Lifecycle Operations (`start()`, `stop()`) | 7 | 7 PASS |
| Group 5 | Operator Diagnostic Execution (`execOperatorCommand()`) | 9 | 9 PASS |
| Group 6 | Host & Guest Environment Boundary (Secrets & `SSH_AUTH_SOCK`) | 3 | 3 PASS |
| Group 7 | Timeout, Abort, Output Caps & Uncertain Outcome Semantics (including probe inherited-pipe regression) | 8 | 8 PASS |
| Group 8 | Error Sanitization Helper | 1 | 1 PASS |
| Integration | CLI error boundary (stderr suppression and invalid UTF-8) | 2 | 2 PASS |

### Regression Suites & Quality Gates
- **WSL2 VM Foundation Regression**: `packages/test-harness/src/m6c3-vm-wsl2.test.ts`: **56 passed, 0 failed, 0 skipped** (9 suites).
- **Typecheck**: `npm run typecheck` (`tsc -p tsconfig.json --noEmit`): **PASS** (0 errors).
- **Linter**: `npm run lint` (`node scripts/ci/lint.mjs`): **PASS** (171 source files checked).
- **Secret Scan**: `npm run scan:secrets` (`node scripts/ci/secret-scan.mjs`): **PASS** (170 source files scanned, 0 leaks).

---

## 4. Environment Limits & Pending Status
- **Native Lima Evidence**: **PENDING**. Full end-to-end VM virtualization on macOS VZ/QEMU hypervisor requires verified safe login shell isolation and template creation defenses in future milestones.
- **Fail-Closed Guarantees**: Any attempt to invoke `start()` or `execOperatorCommand()` without explicit `testOnlyEmulator: true` safely halts with `ERR_LIMA_NATIVE_BOUNDARY_UNSUPPORTED`.

## 5. Agent A takeover and integration

The owner transferred remaining Lima work to A after B exhausted its quota. A integrated B's work as main commits [`b6e08b5`](https://github.com/shmtoan08/SoftwareFactory/commit/b6e08b5ccb91c22a95f1f9b16b5d4740f64db306) and [`1cbf54a`](https://github.com/shmtoan08/SoftwareFactory/commit/1cbf54a), then independently verified that historical pre-integration baseline of **103/103** Lima+WSL2 tests.

A strengthened the inherited-pipe regression: its deadline is now 800 ms (longer than the removed 300 ms false-success fallback), and it asserts that the guest fixture actually wrote its descendant PID. This prevents a slow metadata probe timeout from masquerading as proof of guest pipe handling. A also replaced empty platform-specific test returns with real constructor/platform assertions; Darwin-only native-operation guard assertions remain exercised on macOS.

Lima operation errors no longer include arbitrary CLI stderr or spawn error messages. UTF-8 decoding is strict and catches malformed byte output inside the operation promise. Two child-process tests verify arbitrary-secret stderr suppression and malformed-byte rejection. The internal status allowlist is no longer exported as a mutable Set.

Public WNA exports expose the Lima backend and aliased contract types, using `.ts` imports. The default npm test suite now includes Lima; Linux PG16/17 jobs execute it, and the macOS native-Codex job also executes the Lima CLI fixture suite to exercise Darwin guards. This adds no VM installation or startup and does not wire either backend into production dispatch.

Official schema checked against [Lima v2.0.3 instance types](https://github.com/lima-vm/lima/blob/v2.0.3/pkg/limatype/lima_instance.go) and [list implementation](https://github.com/lima-vm/lima/blob/v2.0.3/cmd/limactl/list.go). JSONL is the upstream piped format; JSON arrays are an additional parser input accepted by this adapter, not a claim that upstream emits arrays by default. The reference version is documented, not a runtime binary-version attestation.

Native VM start/diagnostic, actual SSH/login controls, Linux guest cleanup/isolation and full M6C/G7 acceptance remain pending. Safe native metadata probing and explicitly opted-in targeted stop are the only native operations offered by this foundation.

Historical integration results at main `0a6bc9d` (Node24.16.0/macOS): Lima **53/53**, WSL2 **52/52**, combined **105 tests / 19 suites / 105 pass / 0 fail, cancelled, skipped or todo**. Typecheck PASS; lint171 source files PASS; secret scan170 files/0leaks PASS. Full Linux PG16/17 and macOS CI results are linked in issue #16 for the exact pushed commit.

## 6. Issue #17 review follow-up (2026-11-14)

S6-NOTE-03 adds a metadata-only `probe()` fixture that emits valid listing JSON, spawns a descendant inheriting stdout/stderr, and exits zero. With an 800 ms deadline it must reject `ERR_VM_COMMAND_TIMEOUT`, never return parsed metadata early. The test verifies descendant creation, bounds settlement time and kills only its recorded fixture descendant in cleanup. It does not invoke a guest or VM.

S6-NOTE-04 synchronizes section 3 with the current **54 tests / 10 suites**: the reviewed HEAD had 53 tests (51 original + 2 CLI error-boundary integration tests), and this follow-up adds the probe regression. Historical results in section 5 are explicitly labeled historical. S6-NOTE-05 replaces branch-only SHA references with main commits and main links.

Native Lima acceptance remains PENDING. Native `stop()` remains the documented, deliberately supported exception: it requires explicit lifecycle and dedicated-instance opt-in, reprobes exact identity/state and targets only the configured instance. Native start/diagnostic remain blocked; no new native operations are enabled by this follow-up.

Local issue #17 validation (Node24.16.0/macOS): Lima **54/54**, WSL2 **56/56**, combined **110 tests / 19 suites / 110 pass / 0 fail, cancelled, skipped or todo**. Exact-main CI results are tracked on issue #17.
