# M6C-3 Step 5 — WSL2 VM Backend Foundation Technical Validation Report

**Author**: Agent B  
**Tracker**: [Issue #16 — VM Backend Foundation](https://github.com/shmtoan08/SoftwareFactory/issues/16)  
**Baseline SHA**: `6d1d846dae387f78e5eb93cfa000394e2556f0a0`  
**Branch**: `m6c3/vm-wsl2-foundation`  
**Date**: 2026-11-13  
**Status**: Complete (Unit & CLI Process Contract Tests Passed; Native Windows Evidence PENDING)

---

## 1. Executive Summary

This report documents the design, implementation, and empirical validation of the Windows Subsystem for Linux (WSL2) VM backend foundation (`Wsl2VmBackend`) for Software Factory M6C-3.

The implementation strictly satisfies the structural VM contract defined in `INTERFACE.md`:
1. **Operator Pinning**: Pinned executable absolute path, pinned distribution name, optional pinned guest user.
2. **Encoding & Output Handling**: Transparently decodes real `wsl.exe` console pipe output: UTF-16LE with BOM (`\uFEFF`), UTF-16LE without BOM, UTF-8 with BOM, and standard UTF-8.
3. **Strict WSL2 Probing**: Inspects host metadata via `wsl.exe --list --verbose` without booting the guest; validates exact distribution identity; strictly enforces WSL version 2; rejects version 1, missing distros, ambiguous duplicates, and corrupt formatting without falling back to the default distribution (`*`).
4. **Targeted Lifecycle Operations**: `start` and `stop` strictly require double opt-in (`allowLifecycle === true` and `dedicatedInstance === true`). `stop` invokes `wsl.exe --terminate <Distro>` targeted exclusively at the configured distribution; `--shutdown` is strictly forbidden to prevent terminating other host distributions or the global WSL utility VM.
5. **Operator Diagnostic Execution**: Spawns directly via argv array with `shell: false`, guest `env -i` clean isolation, minimal host environment stripped of all Factory/Gateway/DB/Git/model credentials, and `WSLENV: ""` explicitly purged to prevent Windows-to-Linux variable forwarding.
6. **Bounded Limits & Uncertain Outcome Semantics**: Enforces monotonic execution timeout and output buffer byte cap. Killing `wsl.exe` on timeout/abort halts host transport but diagnoses uncertain guest state (`ERR_VM_COMMAND_TIMEOUT` / `ERR_VM_COMMAND_UNCERTAIN`), avoiding fake cleanup or automatic retries.
7. **Platform Gating**: Production mode strictly checks `process.platform === "win32"`; fixture emulator mode requires explicit constructor flag `testOnlyEmulator: true`.

---

## 2. Technical Design & Structural Contract

### 2.1 Configuration Interface (`Wsl2VmBackendConfig`)
```typescript
export interface Wsl2VmBackendConfig {
  readonly binaryPath: string;           // Absolute path to wsl.exe or fixture binary
  readonly distributionName: string;     // Operator-registered distribution identity
  readonly guestUser?: string;           // Optional guest execution user
  readonly allowLifecycle?: boolean;     // Default: false
  readonly dedicatedInstance?: boolean; // Default: false
  readonly commandTimeoutMs?: number;    // Default: 10000ms (10s), max: 120000ms (120s)
  readonly maxOutputBytes?: number;      // Default: 65536 bytes (64 KiB), max: 1048576 (1 MiB)
  readonly testOnlyEmulator?: boolean;   // Default: false
}
```

### 2.2 Probing Contract (`probe()`)
- Invocations: `wsl.exe --list --verbose`
- Columns: `[NAME] [STATE] [VERSION]`
- Parsing & Gating Rules:
  - Header validation prevents corrupt output from being accepted.
  - Matches `entry.name === config.distributionName` strictly (case-preserving exact match).
  - An asterisk `*` indicating the default distribution is tracked but never used as a fallback if the configured distribution is missing.
  - Distribution version must strictly equal `2`. Version `1` is rejected fail-closed with `ERR_WSL_VERSION_UNSUPPORTED`.
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

### 2.5 Timeout, Abort & Uncertain Outcome
When `commandTimeoutMs` expires or an `AbortSignal` fires:
1. Host transport process (`wsl.exe`) is sent `SIGTERM`, followed by `SIGKILL` after 500ms grace period.
2. Because terminating `wsl.exe` only severs host-side I/O pipes and does not guarantee that the Linux guest kernel terminated the child process, the backend rejects with:
   - `ERR_VM_COMMAND_TIMEOUT`: `Command timed out after <N>ms; host transport terminated but guest process state is uncertain`
   - `ERR_VM_COMMAND_UNCERTAIN`: `Host transport aborted; guest process termination is uncertain (killing wsl.exe does not guarantee guest process stopped)`
3. The backend does NOT automatically retry and does NOT invoke `stop()` or `--terminate` to fake cleanup.

---

## 3. Test Matrix & Results

Suite: `packages/test-harness/src/m6c3-vm-wsl2.test.ts`  
Runner: `node --test`  
Total Test Cases: **41**  
Total Test Suites: **9**  
Passed: **41** | Failed: **0** | Skipped: **0**

| Group | Description | Cases | Outcome |
|---|---|---|---|
| Group 1 | Production Platform Guard & Configuration Validation | 7 | 7 PASS |
| Group 2 | Output Decoding (UTF-16LE with BOM, UTF-16LE without BOM, UTF-8 BOM, UTF-8) | 5 | 5 PASS |
| Group 3 | Distribution Probing & Version 2 Contract (`probe()`) | 10 | 10 PASS |
| Group 4 | Lifecycle Operations (`start()`, `stop()`) | 5 | 5 PASS |
| Group 5 | Operator Diagnostic Execution (`execOperatorCommand()`) | 7 | 7 PASS |
| Group 6 | Host & Guest Environment Boundary (Secrets & WSLENV) | 1 | 1 PASS |
| Group 7 | Timeout, Abort, Output Caps & Uncertain Outcome Semantics | 5 | 5 PASS |
| Group 8 | Error Sanitization Helper | 1 | 1 PASS |

### Linting & Security Verification
- `npm run typecheck`: TypeScript 5.6.3 clean (0 errors).
- `npm run lint`: 167 source files checked, strict TypeScript & bash -n clean.
- `npm run scan:secrets`: 166 source files scanned, 0 leaks found.

---

## 4. Host Environment Limitations & Native Windows Status

- **Current Host**: Darwin x86_64 / arm64 (macOS).
- **Native Windows / WSL2 Host**: Not present in local execution environment.
- **Evidence Classification**:
  - **CLI Process Contract & Adapter Logic**: Verified via child-process executable fixtures that record argv, inspect host environment, emit raw byte encodings (UTF-16LE with/without BOM, UTF-8), and simulate process lifecycles.
  - **Native Windows Kernel / WSL2 Hyper-V Isolation**: **PENDING** real Windows host with WSL2 virtualization enabled.
  - **Production Platform Guard**: Verified fail-closed on Darwin when `testOnlyEmulator: false`.
  - **Dispatcher Integration**: In accordance with Issue #16 instructions, `Wsl2VmBackend` is foundation-only and is NOT activated in production dispatcher or endpoint runtimes during this milestone.
