# M6C-3 Step 5 — Lima VM Backend Foundation Technical Validation Report

**Author**: Agent B  
**Tracker**: [Issue #16 — VM Backend Foundation](https://github.com/shmtoan08/SoftwareFactory/issues/16)  
**Baseline SHA**: `9d2aea69c636bc500f92ff7a7489f4d0b8834894`  
**Branch**: `m6c3/vm-lima-foundation-b`  
**Date**: 2026-11-13  
**Status**: Complete (Unit & CLI Process Contract Tests Passed; Native Lima Host Evidence PENDING)

---

## 1. Executive Summary

This report documents the design, implementation, and empirical validation of the Lima VM backend foundation (`LimaVmBackend`) for Software Factory M6C-3, transferred to Agent B per `rounds/lima-transfer/ASSIGNMENT.md`.

The implementation strictly satisfies the structural VM contract defined in `INTERFACE.md` and official `limactl` CLI behavior:
1. **Operator Configuration Pinning**: Pinned absolute `binaryPath` (`limactl` or fixture binary), pinned `instanceName`, optional absolute `limaHome` (`LIMA_HOME`), and optional `guestUser`.
2. **Structured JSON Probing (`probe()`)**: Invokes `limactl list --json` and parses both JSON Lines (JSONL) streams and JSON arrays via `parseLimaListJsonOutput`. Validates exact instance identity and non-empty status; rejects missing instances (`ERR_LIMA_INSTANCE_NOT_FOUND`), duplicate identities (`ERR_LIMA_INSTANCE_AMBIGUOUS`), and malformed/empty JSON (`ERR_LIMA_OUTPUT_UNRECOGNIZED`) without falling back to `default`.
3. **Targeted Lifecycle Operations (`start()`, `stop()`)**: Requires double opt-in (`allowLifecycle === true` and `dedicatedInstance === true`). `start()` probes first to prevent `limactl start` from auto-creating an instance from a template, skips if already `Running`, and otherwise invokes `limactl start --tty=false <instanceName>`. `stop()` probes and invokes `limactl stop <instanceName>`.
4. **Diagnostic Pre-Probe & Execution (`execOperatorCommand()`)**: Validates command path/arguments, runs `await this.probe(signal)` before guest execution, and halts immediately on probe failure without issuing `limactl shell`. Executes `limactl shell [--user <guestUser>] <instanceName> /usr/bin/env -i <command> <args...>` with `shell: false`.
5. **Host & Guest Environment Isolation**: Minimal host environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, optional `LIMA_HOME`). Explicitly strips `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, credential/key patterns, and Factory/API prefixes (`SF_`, `GITHUB_`, `DATABASE_`, `OPENAI_`, `ANTHROPIC_`, `AWS_`, `AZURE_`) to block SSH agent forwarding and host secret leakage. Guest commands run under `/usr/bin/env -i`.
6. **Bounded Limits, Pipe Hang Defense & Uncertain Outcome Semantics**: Enforces monotonic `commandTimeoutMs` and `maxOutputBytes`. On timeout, abort, or overflow, destroys parent stream handles (`stdout`/`stderr`), sends `SIGTERM` with 250ms `SIGKILL` escalation, and bounds overall settlement to 500ms. Reports uncertain guest state (`ERR_VM_COMMAND_TIMEOUT` / `ERR_VM_COMMAND_UNCERTAIN`) without faking cleanup or auto-stopping the VM.
7. **Strict Boolean & Platform Gating**: Validates `testOnlyEmulator`, `allowLifecycle`, and `dedicatedInstance` as strict runtime booleans; production mode requires `process.platform === "darwin"`; fixture mode requires explicit `testOnlyEmulator: true`.

---

## 2. Technical Design & Structural Contract

### 2.1 Configuration Interface (`LimaVmBackendConfig`)
```typescript
export interface LimaVmBackendConfig {
  readonly binaryPath: string;           // Absolute path to limactl or fixture binary
  readonly instanceName: string;         // Operator-registered Lima instance identity
  readonly limaHome?: string;            // Optional absolute LIMA_HOME directory
  readonly guestUser?: string;           // Optional guest execution user (--user)
  readonly allowLifecycle?: boolean;     // Default: false (must be boolean)
  readonly dedicatedInstance?: boolean;  // Default: false (must be boolean)
  readonly commandTimeoutMs?: number;    // Default: 10000ms (10s), integer bounded <= 120000ms (120s)
  readonly maxOutputBytes?: number;      // Default: 65536 bytes (64 KiB), integer bounded <= 1048576 (1 MiB)
  readonly testOnlyEmulator?: boolean;   // Default: false (must be boolean)
}
```

### 2.2 Probing Contract (`probe()` & `parseLimaListJsonOutput()`)
- Command: `limactl list --json`
- Supported Formats:
  - JSON Lines (one JSON object per line, matching `limactl list --json` default stream)
  - JSON Array (`[{ ... }, ...]`)
- Validation Rules:
  - Rejects empty stdout or non-object JSON entries with `ERR_LIMA_OUTPUT_UNRECOGNIZED`.
  - Requires non-empty string `name` and `status` on every entry.
  - Matches `entry.name === config.instanceName` strictly; rejects duplicates with `ERR_LIMA_INSTANCE_AMBIGUOUS` and missing instances with `ERR_LIMA_INSTANCE_NOT_FOUND`.
  - Never falls back to `"default"`.

### 2.3 Lifecycle Contract (`start()`, `stop()`)
- Guard: Both `allowLifecycle: true` and `dedicatedInstance: true` are required; otherwise throws `ERR_VM_LIFECYCLE_DISABLED`.
- `start(signal)`:
  - Calls `await this.probe(signal)` first (prevents template download / auto-create on unregistered instance).
  - Returns immediately if `status` is `"Running"`.
  - Invokes `limactl start --tty=false <instanceName>`.
- `stop(signal)`:
  - Calls `await this.probe(signal)` first.
  - Invokes `limactl stop <instanceName>`.

### 2.4 Diagnostic Execution Contract (`execOperatorCommand()`)
- Command Validation: Must be an absolute Linux path starting with `/`, no `..` path traversal, no null bytes (`\0`), no newlines.
- Pre-Probe Gate: Executes `await this.probe(signal)` before spawning `limactl shell`.
- Spawn Argv:
  `["shell", ...(guestUser ? ["--user", guestUser] : []), instanceName, "/usr/bin/env", "-i", command, ...args]`
  (If `command === "/usr/bin/env"` and `args[0] === "-i"`, avoids duplicating `/usr/bin/env -i`).
- Host Environment Isolation:
  - Builds minimal host env and explicitly purges `SSH_AUTH_SOCK` and `SSH_AGENT_PID` so `limactl shell` cannot forward host SSH agent sockets into the guest.
  - Propagates `LIMA_HOME` only when `config.limaHome` is explicitly configured.

### 2.5 Timeout, Abort, Pipe Hang Defense & Uncertain Outcome
- Pre-aborted `AbortSignal` rejects immediately before `spawn` with `ERR_VM_COMMAND_ABORTED`.
- Active timeout, `AbortSignal`, or `maxOutputBytes` overflow triggers single-pass termination:
  1. Destroys parent `stdout`/`stderr` stream handles to prevent hangs when background descendants inherit pipe FDs.
  2. Sends `SIGTERM`, escalating to `SIGKILL` after 250ms.
  3. Forces settlement within 500ms if OS `close` event is delayed.
  4. Throws `ERR_VM_COMMAND_TIMEOUT` (timeout) or `ERR_VM_COMMAND_UNCERTAIN` (abort / output overflow) so callers know host transport stopped while guest process state remains uncertain.

---

## 3. Verification & Test Matrix

### 3.1 Unit & Executable CLI Fixture Tests
- **Suite**: `packages/test-harness/src/m6c3-vm-lima.test.ts`
- **Command**: `node --test packages/test-harness/src/m6c3-vm-lima.test.ts`
- **Result**: **45 passed, 0 failed, 0 skipped** across **9 suites** (`7335.23ms`).

| Group | Description | Cases | Outcome |
|---|---|---|---|
| Group 1 | Production Platform Guard & Configuration Validation | 10 | 10 PASS |
| Group 2 | Structured JSON Output Parsing (`parseLimaListJsonOutput`) | 7 | 7 PASS |
| Group 3 | Instance Probing Contract (`probe()`) | 4 | 4 PASS |
| Group 4 | Lifecycle Operations (`start()`, `stop()`) | 6 | 6 PASS |
| Group 5 | Operator Diagnostic Execution (`execOperatorCommand()`) | 9 | 9 PASS |
| Group 6 | Host & Guest Environment Boundary (Secrets & `SSH_AUTH_SOCK`) | 2 | 2 PASS |
| Group 7 | Timeout, Abort, Output Caps & Uncertain Outcome Semantics | 6 | 6 PASS |
| Group 8 | Error Sanitization Helper | 1 | 1 PASS |

### 3.2 Repository Quality Gates
- `npm run typecheck` (`tsc -p tsconfig.json --noEmit`): **PASS**
- `npm run lint` (`node scripts/ci/lint.mjs`): **PASS** (170 source files checked)
- `npm run scan:secrets` (`node scripts/ci/secret-scan.mjs`): **PASS** (169 source files scanned, 0 leaks found)

---

## 4. Environment Limits & Pending Evidence
- **Native Lima Host Evidence**: **PENDING**. All Lima CLI interactions in `m6c3-vm-lima.test.ts` were verified against executable Node.js CLI fixture child processes (`testOnlyEmulator: true`). Live `limactl` execution against a real macOS VZ/QEMU guest VM was not executed in this workspace.
- **Integration Boundary**: Per ownership rules, `packages/wna/src/index.ts`, `package.json`, `.github/workflows/ci.yml`, and `packages/wna/src/vm-wsl2-backend.ts` were not modified.
