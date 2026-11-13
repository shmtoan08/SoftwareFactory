# M6C-3 Step 6 — WSL2 VM Backend Foundation Technical Validation Report

**Author**: Agent B\
**Tracker**: [Issue #16 — VM Backend Foundation](https://github.com/shmtoan08/SoftwareFactory/issues/16)\
**Baseline SHA**: `6d1d846dae387f78e5eb93cfa000394e2556f0a0`\
**Follow-up Base SHA**: `82a09aa1775c0fe522c31f65ee7945bf37c75183`\
**Branch**: `m6c3/vm-wsl2-foundation`\
**Date**: 2026-11-13\
**Status**: Complete (Unit & CLI Process Contract Tests Passed; Native Windows Evidence PENDING)

---

## 1. Executive Summary

This report documents the design, implementation, and empirical validation of the Windows Subsystem for Linux (WSL2) VM backend foundation (`Wsl2VmBackend`) for Software Factory M6C-3, including all technical hardening requirements requested in `rounds/vm-foundation/AGENT_B_FOLLOWUP.md`.

The implementation strictly satisfies the structural VM contract defined in `INTERFACE.md`:
1. **Operator Pinning**: Pinned executable absolute path, pinned distribution name, optional pinned guest user.
2. **Encoding & Output Handling**: Transparently decodes real `wsl.exe` console pipe output: UTF-16LE with BOM (`\uFEFF`), UTF-16LE without BOM, UTF-8 with BOM, and standard UTF-8.
3. **Strict WSL2 Probing & Fail-Closed Version Parsing**: Inspects host metadata via `wsl.exe --list --verbose` without booting the guest; validates exact distribution identity; strictly enforces WSL version token `"2"` (rejecting `"2junk"`, `"2.5"`, `"02"`, `"v2"`, and `"1"`); rejects missing distros, ambiguous duplicates, and corrupt formatting without falling back to the default distribution (`*`).
4. **Targeted Lifecycle Operations**: `start` and `stop` strictly require double opt-in (`allowLifecycle === true` and `dedicatedInstance === true`). `stop` invokes `wsl.exe --terminate <Distro>` targeted exclusively at the configured distribution; `--shutdown` is strictly forbidden to prevent terminating other host distributions or the global WSL utility VM.
5. **Diagnostic Pre-Probe Execution**: `execOperatorCommand` validates command arguments, then executes `probe(signal)` using the same `AbortSignal` before guest execution. Missing, WSL1, duplicate, or malformed listing halts immediately without invoking secondary guest commands.
6. **Operator Diagnostic Execution**: Spawns directly via argv array with `shell: false`, guest `env -i` clean isolation, minimal host environment stripped of all Factory/Gateway/DB/Git/model credentials, and `WSLENV: ""` explicitly purged to prevent Windows-to-Linux variable forwarding.
7. **Bounded Settlement & Inherited Pipe Hang Defense**: Single-pass cleanup, stream destruction, and bounded settlement preventing indefinite promise hangs when background descendants inherit and retain stdout/stderr file descriptors after the parent exits.
8. **Bounded Limits & Uncertain Outcome Semantics**: Enforces monotonic execution timeout and output buffer byte cap. Killing `wsl.exe` on timeout, abort, or guest output overflow halts host transport but diagnoses uncertain guest state (`ERR_VM_COMMAND_TIMEOUT` / `ERR_VM_COMMAND_UNCERTAIN`), avoiding fake cleanup or automatic retries.
9. **Strict Boolean & Platform Gating**: Validates that all optional boolean configuration flags (`testOnlyEmulator`, `allowLifecycle`, `dedicatedInstance`) are strictly booleans at runtime; production mode strictly checks `process.platform === "win32"`; fixture emulator mode requires explicit boolean `testOnlyEmulator: true`.

---

## 2. Technical Design & Structural Contract

### 2.1 Configuration Interface (`Wsl2VmBackendConfig`)
```typescript
export interface Wsl2VmBackendConfig {
  readonly binaryPath: string;           // Absolute path to wsl.exe or fixture binary
  readonly distributionName: string;     // Operator-registered distribution identity
  readonly guestUser?: string;           // Optional guest execution user
  readonly allowLifecycle?: boolean;     // Default: false (must be boolean)
  readonly dedicatedInstance?: boolean; // Default: false (must be boolean)
  readonly commandTimeoutMs?: number;    // Default: 10000ms (10s), integer bounded <= 120000ms (120s)
  readonly maxOutputBytes?: number;      // Default: 65536 bytes (64 KiB), integer bounded <= 1048576 (1 MiB)
  readonly testOnlyEmulator?: boolean;   // Default: false (must be boolean)
}
```

### 2.2 Strict Probing & Version Parsing Contract (`probe()`)
- Invocations: `wsl.exe --list --verbose`
- Columns: `[NAME] [STATE] [VERSION]`
- Parsing & Gating Rules:
  - Header line validation ensures columnar formatting is present before parsing data rows.
  - Matches `entry.name === config.distributionName` strictly (case-preserving exact match).
  - An asterisk `*` indicating the default distribution is tracked but never used as a fallback if the configured distribution is missing.
  - Strict Version Matching: Version token must strictly equal `"2"`.
    - `Number.parseInt` traps are avoided: tokens like `"2junk"`, `"2.5"`, `"02"`, `"v2"` are rejected with `ERR_WSL_VERSION_UNSUPPORTED`.
    - Valid WSL version `"1"` is rejected fail-closed with `ERR_WSL_VERSION_UNSUPPORTED`.
  - Duplicate matches throw `ERR_WSL_DISTRO_AMBIGUOUS`.
  - Missing matches throw `ERR_WSL_DISTRO_NOT_FOUND`.

### 2.3 Lifecycle Contract (`start()`, `stop()`)
- Guard: Both `allowLifecycle: true` and `dedicatedInstance: true` are required. Otherwise throws `ERR_VM_LIFECYCLE_DISABLED`.
- `start()`:
  - Invokes `probe()`.
  - If state is already `"Running"`, returns immediately without unnecessary host CLI calls.
  - If state is `"Stopped"`, boots distribution non-interactively via:
    `wsl.exe --distribution <distributionName> --exec /bin/true`
- `stop()`:
  - Invokes `probe()`.
  - Terminates targeted distribution via:
    `wsl.exe --terminate <distributionName>`
  - `--shutdown` is never invoked, preserving shared WSL2 host instances.

### 2.4 Diagnostic Execution Contract (`execOperatorCommand()`)
- Pre-Probe Gate: Validates command syntax, then runs `await this.probe(signal)` before spawning. If probe rejects (distro missing, WSL1, corrupt listing), execution aborts without issuing `--exec`.
- TOCTOU Notice: The probe-before-exec pattern provides high assurance by verifying distro registration immediately prior to invocation; the inherent non-atomic TOCTOU (time-of-check to time-of-use) property of OS process launches is acknowledged.
- Command Validation: Absolute Linux path required (starts with `/`); path traversal (`..`), null bytes (`\0`), and newlines are rejected.
- Arguments: Array of strings without null bytes.
- Spawn Argv:
  `["--distribution", config.distributionName, ...(config.guestUser ? ["--user", config.guestUser] : []), "--exec", "/usr/bin/env", "-i", command, ...args]`
- Shell: `shell: false` strictly enforced.
- Environment:
  - Minimal host environment: `SystemRoot`, `SYSTEMDRIVE`, `PATH`, `TEMP`, `TMP`.
  - All secret keys matching `/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|CANARY)/i` and prefixes `SF_`, `GITHUB_`, `DATABASE_`, `OPENAI_`, `ANTHROPIC_`, `AWS_`, `AZURE_` are purged.
  - `WSLENV` is set to `""` to prevent Windows from forwarding any host variables into the guest.
  - Guest executes under `/usr/bin/env -i` for clean execution environment.

### 2.5 Timeout, Abort, Pipe Hang Defense & Uncertain Outcome
When `commandTimeoutMs` expires, an `AbortSignal` fires, or output exceeds `maxOutputBytes`:
1. Parent immediately destroys its read-end stream handles (`child.stdout.destroy()`, `child.stderr.destroy()`), breaking any pipe retention caused by background descendant processes holding file descriptors.
2. Direct child process (`wsl.exe`) is sent `SIGTERM`, followed by `SIGKILL` escalation after 250ms.
3. A force-settlement watchdog bounds overall promise resolution to <= 500ms, preventing indefinite hangs even if the OS close event is delayed.
4. Timers and stream listeners are cleaned up in a single pass (`terminating` guard prevents duplicate kill escalation timers when output streams overflow).
5. For guest diagnostic invocations (`execOperatorCommand`), output overflow reports uncertain guest state:
   `ERR_VM_COMMAND_UNCERTAIN: Output exceeded maximum bounded limit of <N> bytes; host transport terminated but guest process state is uncertain`
6. The backend does NOT automatically retry and does NOT invoke `stop()` or `--terminate` to fake cleanup.

---

## 3. Test Matrix & Results

Suite: `packages/test-harness/src/m6c3-vm-wsl2.test.ts`\
Runner: `node --test`\
Total Test Cases: **56**\
Total Test Suites: **9**\
Passed: **56** | Failed: **0** | Cancelled: **0** | Skipped: **0** | Todo: **0**

| Group | Description | Cases | Outcome |
|---|---|---|---|
| Group 1 | Production Platform Guard & Configuration Validation | 9 | 9 PASS |
| Group 2 | Output Decoding (BOM, BOM-less UTF-16LE, early UTF-8 NUL and short ambiguous input) | 8 | 8 PASS |
| Group 3 | Distribution Probing & Version 2 Contract (`probe()`) | 14 | 14 PASS |
| Group 4 | Lifecycle Operations (`start()`, `stop()`, localized-state limitation) | 6 | 6 PASS |
| Group 5 | Operator Diagnostic Execution (`execOperatorCommand()`) | 10 | 10 PASS |
| Group 6 | Host & Guest Environment Boundary (Secrets & WSLENV) | 1 | 1 PASS |
| Group 7 | Timeout, Abort, Output Caps & Uncertain Outcome Semantics | 7 | 7 PASS |
| Group 8 | Error Sanitization Helper | 1 | 1 PASS |

### Specific Regression Coverage for Follow-Up Items
- **Item 1 (Strict Version Parsing)**:
  - Rejects `2junk`: `parseWslListVerboseOutput rejects '2junk' as malformed version` (PASS)
  - Rejects `2.5`: `parseWslListVerboseOutput rejects '2.5' as malformed version` (PASS)
  - Rejects `02`: `parseWslListVerboseOutput rejects '02' as malformed version` (PASS)
  - Rejects `v2`: `parseWslListVerboseOutput rejects 'v2' as malformed version` (PASS)
  - Rejects `1`: `probe rejects distribution configured with WSL version 1 (fail-closed)` (PASS)
  - Accepts `2`: `parseWslListVerboseOutput accepts strictly '2'` (PASS)
- **Item 2 (Pre-Probe Diagnostics)**:
  - Missing distro rejection: `execOperatorCommand validates probe and rejects missing distro without invoking secondary exec command` (PASS, verifies fixture log contains only `--list --verbose`)
  - WSL1 distro rejection: `execOperatorCommand validates probe and rejects WSL1 distro without invoking secondary exec command` (PASS, verifies fixture log contains only `--list --verbose`)
  - Malformed listing rejection: `execOperatorCommand validates probe and rejects malformed output without invoking secondary exec command` (PASS, verifies fixture log contains only `--list --verbose`)
- **Item 3 (Strict Booleans & Numeric Bounds)**:
  - Cast rejection on `testOnlyEmulator` (`"false"`, `"true"`, `1`, `0`, `{}`): (PASS)
  - Cast rejection on `allowLifecycle` and `dedicatedInstance` (`"true"`, `1`): (PASS)
  - Numeric integer validation for `commandTimeoutMs` (rejects decimals `100.5`, `NaN`, `Infinity`): (PASS)
  - Numeric integer validation for `maxOutputBytes` (rejects decimals `1024.5`, `NaN`, `Infinity`): (PASS)
  - Truthy string `"true"` does not bypass Darwin platform guard: (PASS)
- **Item 4 (Pipe Hang Defense & Bounded Settlement)**:
  - Background descendant pipe retention: `execOperatorCommand settles within bounded time when background descendant inherits and keeps pipe open` (PASS, settles within ~200ms without hanging; test PID watchdog cleans background descendant)
  - Guest output overflow uncertain outcome: `output exceeding maxOutputBytes during guest invocation reports ERR_VM_COMMAND_UNCERTAIN` (PASS)

### Linting & Security Verification
- `npm run typecheck`: TypeScript 5.6.3 clean (0 errors).
- `npm run lint`: 168 source files checked, strict TypeScript & bash -n clean.
- `npm run scan:secrets`: 167 source files scanned, 0 leaks found.

---

## 4. Host Environment Limitations & Native Windows Status

- **Current Host**: Darwin x86_64 / arm64 (macOS).
- **Native Windows / WSL2 Host**: Not present in local execution environment.
- **Evidence Classification**:
  - **CLI Process Contract & Adapter Logic**: Verified via child-process executable fixtures that record argv, inspect host environment, emit raw byte encodings (UTF-16LE with/without BOM, UTF-8), and simulate process lifecycles.
  - **Native Windows Kernel / WSL2 Hyper-V Isolation**: **PENDING** real Windows host with WSL2 virtualization enabled.
  - **Production Platform Guard**: Verified fail-closed on Darwin when `testOnlyEmulator: false`.
  - **Dispatcher Integration**: In accordance with Issue #16 instructions, `Wsl2VmBackend` is foundation-only and is NOT activated in production dispatcher or endpoint runtimes during this milestone.

## 5. Agent A integration verification

B delivered commits `82a09aa` and `eb97c36` with 51 passing tests. A cherry-picked both, exported only the backend and aliased contract types from WNA, and added `test:m6c3:vm-wsl2` plus the suite to the default `npm test` command used by the existing Linux PostgreSQL 16/17 CI matrix. This does not activate the backend in the dispatcher.

A removed the 300 ms successful settlement fallback after host CLI exit: if a descendant retains output pipes, an incomplete stream must not be reported as success. The existing execution deadline now remains in force until pipe closure; timeout reports uncertain outcome. A second process fixture exits the direct CLI with code zero while a descendant retains pipes, asserts timeout rejection, and kills its recorded descendant in cleanup.

Historical integration validation at main `9d2aea6` on macOS with Node 24.16.0: **52 tests, 9 suites, 52 pass, 0 fail/cancelled/skipped/todo**. Typecheck, lint and secret scan are recorded separately in the integration handoff. Native Windows/WSL2, guest cleanup and kernel isolation remain **PENDING**. Lima is not implemented in this integration; issue #16 and M6C/G7 remain open.

## 6. Issue #17 review follow-up (2026-11-14)

**S6-NOTE-01 — localized running state:** the no-op optimization in `start()` recognizes the English `Running` token only (case-insensitive). Other state text, including French `En cours d'exécution`, still passes through exact identity/version checks and, with both lifecycle opt-ins enabled, invokes the same targeted `/bin/true` boot command. It may perform a redundant idempotent invocation; it does not select the default distro, retry, terminate or globally shut down WSL. A process fixture records both calls and locks this behavior. No translation dictionary or unsupported language-independent state claim is introduced.

**S6-NOTE-02 — BOM-less encoding:** detection now samples up to 64 UTF-16 code units, requires at least eight printable ASCII/control-whitespace units and at least 70% matching zero-high-byte evidence, then validates UTF-16 decoding and rejects candidates containing decoded NUL. Two early NUL bytes alone no longer trigger UTF-16LE. Tests cover genuine BOM-less listing output with localized text, UTF-8 with early NUL (including non-ASCII and odd-length buffers), and short ambiguous input.

BOM-less detection remains a heuristic: short or non-ASCII-dominated input falls back to UTF-8, and deliberately ambiguous byte sequences cannot be classified perfectly without an encoding signal. Use a BOM for deterministic UTF-16 decoding. The change does not establish native Windows/WSL2 acceptance.

Current suite: **56 tests / 9 suites**. The older 51- and 52-test results above are historical handoff/integration evidence; the current matrix in section 3 supersedes those snapshots.
