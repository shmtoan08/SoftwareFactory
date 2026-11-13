/**
 * @file vm-lima-backend.ts
 * @description Lima VM Backend Foundation for Software Factory M6C-3 (Step 6).
 *
 * Implements operator-pinned Lima instance probing, lifecycle, and diagnostic
 * execution foundation according to the structural VM contract (Issue #16).
 *
 * Primary Documentation & Reference (Pinned to Lima v2.0.3):
 * - Lima CLI Reference: https://lima-vm.io/docs/reference/limactl_shell/
 * - shell.go (v2.0.3): https://raw.githubusercontent.com/lima-vm/lima/v2.0.3/cmd/limactl/shell.go
 * - start.go (v2.0.3): https://raw.githubusercontent.com/lima-vm/lima/v2.0.3/cmd/limactl/start.go
 *
 * Features & Invariants:
 * - Operator configuration pinning: absolute binary path, instance identity, optional LIMA_HOME root.
 *   Host environment is snapshotted at construction time so later process.env mutations cannot alter targets.
 * - Strict boolean type validation: testOnlyEmulator, allowLifecycle, dedicatedInstance must be booleans at runtime.
 * - Unsupported flag rejection: guestUser is rejected because Lima v2.0.3 `limactl shell` has no `--user` flag.
 * - Structured JSON probing: Uses `limactl list --json` (JSONL or JSON array). Validates exact instance identity,
 *   official Lima status enum (Running/Stopped/Installing/Broken/Uninitialized), and optional field types/bounds.
 *   Fails closed on missing, ambiguous, unknown/empty status, or corrupt schema without default fallback.
 * - Native boundary fail-closed (v2.0.3):
 *   - `start` is fail-closed in native mode (`testOnlyEmulator !== true`) because Lima v2.0.3 `limactl start`
 *     lacks an existing-only flag to eliminate template auto-create TOCTOU if an instance disappears after probe.
 *   - `execOperatorCommand` is fail-closed in native mode (`testOnlyEmulator !== true`) because Lima v2.0.3
 *     `limactl shell` uses instance ssh.config (ControlMaster/ForwardAgent) and runs a guest login shell before `/usr/bin/env -i`.
 * - Diagnostic precondition: Requires `status === "Running"` from `probe()` before invoking `limactl shell`.
 * - Bounded timeouts, output caps & inherited pipe hang defense: Single-pass cleanup, stream destruction,
 *   and bounded settlement. Keeps execution deadline armed until pipe closure ('close') so exited CLI processes
 *   with open descendant pipes do not falsely succeed.
 * - Strict platform gating: Production requires darwin host platform; emulator mode requires explicit boolean testOnlyEmulator: true.
 */

import { spawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";

// ============================================================================
// Structural Contract Types (Issue #16 / INTERFACE.md)
// ============================================================================

export type LimaInstanceStatus = "Running" | "Stopped" | "Installing" | "Broken" | "Uninitialized";

export const SUPPORTED_LIMA_STATUSES: ReadonlySet<string> = new Set<LimaInstanceStatus>([
  "Running",
  "Stopped",
  "Installing",
  "Broken",
  "Uninitialized",
]);

export interface VmProbeResult {
  readonly backend: "lima";
  readonly identity: string;
  readonly present: true;
  readonly status: LimaInstanceStatus;
  readonly dir?: string;
  readonly arch?: string;
  readonly vmType?: string;
  readonly sshLocalPort?: number;
}

export interface VmCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LimaVmBackendConfig {
  readonly binaryPath: string;
  readonly instanceName: string;
  readonly limaHome?: string;
  readonly allowLifecycle?: boolean;
  readonly dedicatedInstance?: boolean;
  readonly commandTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly testOnlyEmulator?: boolean;
}

export interface LimaInstanceEntry {
  readonly name: string;
  readonly status: LimaInstanceStatus;
  readonly dir?: string;
  readonly arch?: string;
  readonly vmType?: string;
  readonly sshLocalPort?: number;
}

// ============================================================================
// Constants & Configuration Bounds
// ============================================================================

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const MAX_ALLOWED_TIMEOUT_MS = 120_000; // 2 minutes max
const DEFAULT_MAX_OUTPUT_BYTES = 65_536; // 64 KiB
const MAX_ALLOWED_OUTPUT_BYTES = 1_048_576; // 1 MiB

const SENSITIVE_KEY_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|BEARER|CANARY|PRIVATE)/i;
const SENSITIVE_PREFIX_PATTERN = /^(?:SF_|GITHUB_|DATABASE_|OPENAI_|ANTHROPIC_|AWS_|AZURE_)/i;

const VALID_INSTANCE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// ============================================================================
// Output & Environment Helpers
// ============================================================================

/**
 * Sanitizes output for inclusion in error messages, stripping credential patterns.
 */
export function sanitizeErrorOutput(output: string): string {
  return output
    .replace(/(?:sk-[a-zA-Z0-9_-]{16,})/g, "[REDACTED_API_KEY]")
    .replace(/(?:ghp_[a-zA-Z0-9_-]{16,})/g, "[REDACTED_TOKEN]")
    .replace(/(?:canary-[a-zA-Z0-9_-]+)/g, "[REDACTED_CANARY]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

/**
 * Constructs minimal sanitized host environment for spawning limactl.
 * Strips SSH_AUTH_SOCK and SSH_AGENT_PID from the host env snapshot and purges
 * Factory/Gateway/DB/Git/model credentials. Uses official LIMA_HOME env var.
 */
export function buildMinimalHostEnv(limaHome?: string): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: process.env.TMPDIR || "/tmp",
    TEMP: process.env.TEMP || "/tmp",
    TMP: process.env.TMP || "/tmp",
    HOME: process.env.HOME || "/tmp",
    USER: process.env.USER || "lima",
    LOGNAME: process.env.LOGNAME || "lima",
  };

  const resolvedLimaHome = limaHome ?? (
    typeof process.env.LIMA_HOME === "string" && process.env.LIMA_HOME.trim().length > 0
      ? process.env.LIMA_HOME
      : undefined
  );
  if (resolvedLimaHome) {
    minimal.LIMA_HOME = resolvedLimaHome;
  }

  // Explicitly purge SSH agent forwarding env vars from host env
  delete minimal.SSH_AUTH_SOCK;
  delete minimal.SSH_AGENT_PID;

  // Explicitly purge any sensitive keys if present
  for (const key of Object.keys(minimal)) {
    if (SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_PREFIX_PATTERN.test(key)) {
      delete minimal[key];
    }
  }

  return minimal;
}

/**
 * Validates a single parsed JSON object against the official Lima v2.0.3 `limactl list --json` schema.
 * Rejects unknown/empty status values and invalid optional field types/bounds.
 */
function validateLimaInstanceEntry(raw: unknown, context: string): LimaInstanceEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`ERR_LIMA_OUTPUT_UNRECOGNIZED: Invalid instance entry (expected object) in ${context}`);
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    throw new Error(`ERR_LIMA_OUTPUT_UNRECOGNIZED: Invalid or empty instance name in ${context}`);
  }

  if (typeof obj.status !== "string" || !SUPPORTED_LIMA_STATUSES.has(obj.status)) {
    throw new Error(
      `ERR_LIMA_OUTPUT_UNRECOGNIZED: Unsupported or empty instance status in ${context} (expected one of Running, Stopped, Installing, Broken, Uninitialized)`
    );
  }

  if (obj.dir !== undefined && (typeof obj.dir !== "string" || obj.dir.trim().length === 0)) {
    throw new Error(`ERR_LIMA_OUTPUT_UNRECOGNIZED: Invalid optional field 'dir' in ${context}`);
  }
  if (obj.arch !== undefined && (typeof obj.arch !== "string" || obj.arch.trim().length === 0)) {
    throw new Error(`ERR_LIMA_OUTPUT_UNRECOGNIZED: Invalid optional field 'arch' in ${context}`);
  }
  if (obj.vmType !== undefined && (typeof obj.vmType !== "string" || obj.vmType.trim().length === 0)) {
    throw new Error(`ERR_LIMA_OUTPUT_UNRECOGNIZED: Invalid optional field 'vmType' in ${context}`);
  }
  if (
    obj.sshLocalPort !== undefined &&
    (typeof obj.sshLocalPort !== "number" ||
      !Number.isInteger(obj.sshLocalPort) ||
      obj.sshLocalPort < 0 ||
      obj.sshLocalPort > 65535)
  ) {
    throw new Error(`ERR_LIMA_OUTPUT_UNRECOGNIZED: Invalid optional field 'sshLocalPort' in ${context}`);
  }

  return {
    name: obj.name,
    status: obj.status as LimaInstanceStatus,
    ...(obj.dir !== undefined ? { dir: obj.dir } : {}),
    ...(obj.arch !== undefined ? { arch: obj.arch } : {}),
    ...(obj.vmType !== undefined ? { vmType: obj.vmType } : {}),
    ...(obj.sshLocalPort !== undefined ? { sshLocalPort: obj.sshLocalPort } : {}),
  };
}

/**
 * Parses the structured JSON output of `limactl list --json` (Lima v2.0.3).
 * Supports both JSON Lines stream format and JSON array format.
 * Never echoes raw unparsed JSON lines in error messages to avoid leaking embedded secrets.
 */
export function parseLimaListJsonOutput(rawOutput: string, targetInstance: string): VmProbeResult {
  const trimmed = rawOutput.trim();
  if (trimmed.length === 0) {
    throw new Error("ERR_LIMA_OUTPUT_UNRECOGNIZED: limactl list output is completely empty");
  }

  const entries: LimaInstanceEntry[] = [];

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("ERR_LIMA_OUTPUT_UNRECOGNIZED: Failed to parse JSON array from limactl list");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("ERR_LIMA_OUTPUT_UNRECOGNIZED: Expected JSON array from limactl list");
    }
    for (let i = 0; i < parsed.length; i++) {
      entries.push(validateLimaInstanceEntry(parsed[i], `limactl list JSON array index ${i}`));
    }
  } else {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        throw new Error(
          `ERR_LIMA_OUTPUT_UNRECOGNIZED: Failed to parse JSON line ${i + 1} from limactl list`
        );
      }
      entries.push(validateLimaInstanceEntry(obj, `limactl list line ${i + 1}`));
    }
  }

  if (entries.length === 0) {
    throw new Error("ERR_LIMA_INSTANCE_NOT_FOUND: No Lima instances found in list output");
  }

  // Exact instance match (case-sensitive as specified by operator registration)
  const matches = entries.filter((e) => e.name === targetInstance);

  if (matches.length > 1) {
    throw new Error(
      `ERR_LIMA_INSTANCE_AMBIGUOUS: Multiple entries found for Lima instance "${targetInstance}" in listing`
    );
  }

  const entry = matches[0];
  if (!entry) {
    throw new Error(
      `ERR_LIMA_INSTANCE_NOT_FOUND: Configured Lima instance "${targetInstance}" was not found in listing`
    );
  }

  return {
    backend: "lima",
    identity: entry.name,
    present: true,
    status: entry.status,
    ...(entry.dir !== undefined ? { dir: entry.dir } : {}),
    ...(entry.arch !== undefined ? { arch: entry.arch } : {}),
    ...(entry.vmType !== undefined ? { vmType: entry.vmType } : {}),
    ...(entry.sshLocalPort !== undefined ? { sshLocalPort: entry.sshLocalPort } : {}),
  };
}

// ============================================================================
// LimaVmBackend Class
// ============================================================================

export class LimaVmBackend {
  readonly config: LimaVmBackendConfig;
  readonly commandTimeoutMs: number;
  readonly maxOutputBytes: number;
  private readonly pinnedHostEnv: Readonly<NodeJS.ProcessEnv>;

  constructor(config: LimaVmBackendConfig) {
    if (!config || typeof config !== "object") {
      throw new Error("ERR_LIMA_CONFIG_INVALID: Configuration object is required");
    }

    // 1. Validate binaryPath
    if (typeof config.binaryPath !== "string" || config.binaryPath.trim().length === 0) {
      throw new Error("ERR_LIMA_CONFIG_INVALID: binaryPath must be a non-empty string");
    }
    if (config.binaryPath.includes("\0")) {
      throw new Error("ERR_LIMA_CONFIG_INVALID: binaryPath must not contain null bytes");
    }
    const isAbs = isAbsolute(config.binaryPath) || win32.isAbsolute(config.binaryPath);
    if (!isAbs) {
      throw new Error(`ERR_LIMA_CONFIG_INVALID: binaryPath must be an absolute path (received "${config.binaryPath}")`);
    }

    // 2. Validate instanceName
    if (typeof config.instanceName !== "string" || config.instanceName.trim().length === 0) {
      throw new Error("ERR_LIMA_CONFIG_INVALID: instanceName must be a non-empty string");
    }
    if (config.instanceName.includes("\0") || config.instanceName.includes("\n")) {
      throw new Error("ERR_LIMA_CONFIG_INVALID: instanceName must not contain null bytes or newlines");
    }
    if (config.instanceName.startsWith("-")) {
      throw new Error("ERR_LIMA_CONFIG_INVALID: instanceName must not start with a hyphen (-)");
    }
    if (!VALID_INSTANCE_NAME_REGEX.test(config.instanceName)) {
      throw new Error(`ERR_LIMA_CONFIG_INVALID: instanceName contains invalid characters: "${config.instanceName}"`);
    }

    // 3. Validate optional limaHome
    if (config.limaHome !== undefined) {
      if (typeof config.limaHome !== "string" || config.limaHome.trim().length === 0) {
        throw new Error("ERR_LIMA_CONFIG_INVALID: limaHome must be a non-empty string if provided");
      }
      if (config.limaHome.includes("\0")) {
        throw new Error("ERR_LIMA_CONFIG_INVALID: limaHome must not contain null bytes");
      }
      const isHomeAbs = isAbsolute(config.limaHome) || win32.isAbsolute(config.limaHome);
      if (!isHomeAbs) {
        throw new Error(`ERR_LIMA_CONFIG_INVALID: limaHome must be an absolute path (received "${config.limaHome}")`);
      }
    }

    // 4. Reject unsupported guestUser option (Lima v2.0.3 limactl shell has no --user flag)
    if ((config as unknown as Record<string, unknown>)["guestUser"] !== undefined) {
      throw new Error(
        "ERR_LIMA_UNSUPPORTED_OPTION: guestUser is not supported by limactl shell in Lima v2.0.3"
      );
    }

    // 5. Validate strict boolean options
    if (config.testOnlyEmulator !== undefined && typeof config.testOnlyEmulator !== "boolean") {
      throw new Error(
        `ERR_LIMA_CONFIG_INVALID: testOnlyEmulator must be a boolean (received ${typeof config.testOnlyEmulator})`
      );
    }
    if (config.allowLifecycle !== undefined && typeof config.allowLifecycle !== "boolean") {
      throw new Error(
        `ERR_LIMA_CONFIG_INVALID: allowLifecycle must be a boolean (received ${typeof config.allowLifecycle})`
      );
    }
    if (config.dedicatedInstance !== undefined && typeof config.dedicatedInstance !== "boolean") {
      throw new Error(
        `ERR_LIMA_CONFIG_INVALID: dedicatedInstance must be a boolean (received ${typeof config.dedicatedInstance})`
      );
    }

    // 6. Validate timeouts and bounded limits (strictly finite positive integers)
    const timeout = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (
      typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      !Number.isInteger(timeout) ||
      timeout <= 0 ||
      timeout > MAX_ALLOWED_TIMEOUT_MS
    ) {
      throw new Error(
        `ERR_LIMA_CONFIG_INVALID: commandTimeoutMs must be an integer > 0 and <= ${MAX_ALLOWED_TIMEOUT_MS} (received ${timeout})`
      );
    }
    this.commandTimeoutMs = timeout;

    const maxBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (
      typeof maxBytes !== "number" ||
      !Number.isFinite(maxBytes) ||
      !Number.isInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > MAX_ALLOWED_OUTPUT_BYTES
    ) {
      throw new Error(
        `ERR_LIMA_CONFIG_INVALID: maxOutputBytes must be an integer > 0 and <= ${MAX_ALLOWED_OUTPUT_BYTES} (received ${maxBytes})`
      );
    }
    this.maxOutputBytes = maxBytes;

    // 7. Strict platform check vs normalized boolean emulator mode
    const isEmulator = config.testOnlyEmulator === true;
    if (!isEmulator) {
      if (process.platform !== "darwin") {
        throw new Error(
          `ERR_LIMA_PLATFORM_UNSUPPORTED: Lima backend requires darwin host platform (current platform is "${process.platform}"). Use testOnlyEmulator: true for testing.`
        );
      }
    }

    // 8. Snapshot minimal host environment once at construction time
    this.pinnedHostEnv = Object.freeze(buildMinimalHostEnv(config.limaHome));

    this.config = Object.freeze({
      binaryPath: config.binaryPath,
      instanceName: config.instanceName,
      ...(config.limaHome !== undefined ? { limaHome: config.limaHome } : {}),
      allowLifecycle: config.allowLifecycle === true,
      dedicatedInstance: config.dedicatedInstance === true,
      commandTimeoutMs: this.commandTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      testOnlyEmulator: isEmulator,
    });
  }

  /**
   * Internal runner for host CLI invocations (limactl).
   */
  private runHostCli(
    args: readonly string[],
    signal?: AbortSignal,
    options?: { isGuestInvocation?: boolean }
  ): Promise<{ exitCode: number; stdout: string; stderr: string; rawStdout: Buffer; rawStderr: Buffer }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new Error("ERR_VM_COMMAND_ABORTED: Command aborted before execution"));
      }

      let settled = false;
      let terminating = false;
      let timedOut = false;
      let aborted = false;
      let overflowed = false;
      let totalBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      let executionTimer: NodeJS.Timeout | null = null;
      let killEscalationTimer: NodeJS.Timeout | null = null;
      let forceSettlementTimer: NodeJS.Timeout | null = null;
      let abortListener: (() => void) | null = null;

      const child = spawn(this.config.binaryPath, args, {
        shell: false,
        env: { ...this.pinnedHostEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const destroyStreams = () => {
        try {
          if (!child.stdout.destroyed) child.stdout.destroy();
        } catch {
          // ignore
        }
        try {
          if (!child.stderr.destroyed) child.stderr.destroy();
        } catch {
          // ignore
        }
      };

      const cleanupAllTimers = () => {
        if (executionTimer) {
          clearTimeout(executionTimer);
          executionTimer = null;
        }
        if (killEscalationTimer) {
          clearTimeout(killEscalationTimer);
          killEscalationTimer = null;
        }
        if (forceSettlementTimer) {
          clearTimeout(forceSettlementTimer);
          forceSettlementTimer = null;
        }
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
          abortListener = null;
        }
      };

      const finalizeSettlement = (exitCode: number | null, signalStr: string | null) => {
        if (settled) return;
        settled = true;
        cleanupAllTimers();
        destroyStreams();

        if (aborted) {
          return reject(
            new Error(
              "ERR_VM_COMMAND_UNCERTAIN: Host transport aborted; guest process termination is uncertain (killing limactl does not guarantee guest process stopped)"
            )
          );
        }

        if (timedOut) {
          return reject(
            new Error(
              `ERR_VM_COMMAND_TIMEOUT: Command timed out after ${this.commandTimeoutMs}ms; host transport terminated but guest process state is uncertain`
            )
          );
        }

        if (overflowed) {
          const isGuest = options?.isGuestInvocation === true;
          if (isGuest) {
            return reject(
              new Error(
                `ERR_VM_COMMAND_UNCERTAIN: Output exceeded maximum bounded limit of ${this.maxOutputBytes} bytes; host transport terminated but guest process state is uncertain`
              )
            );
          }
          return reject(
            new Error(
              `ERR_VM_OUTPUT_OVERFLOW: Output exceeded maximum bounded limit of ${this.maxOutputBytes} bytes`
            )
          );
        }

        const rawStdout = Buffer.concat(stdoutChunks);
        const rawStderr = Buffer.concat(stderrChunks);

        resolve({
          exitCode: exitCode ?? (signalStr ? 128 : -1),
          stdout: rawStdout.toString("utf8"),
          stderr: rawStderr.toString("utf8"),
          rawStdout,
          rawStderr,
        });
      };

      const terminateChildAndSettleBounded = (reason: "timeout" | "abort" | "overflow") => {
        if (terminating || settled) return;
        terminating = true;

        if (reason === "timeout") timedOut = true;
        if (reason === "abort") aborted = true;
        if (reason === "overflow") overflowed = true;

        destroyStreams();

        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }

        killEscalationTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 250);
        killEscalationTimer.unref();

        forceSettlementTimer = setTimeout(() => {
          finalizeSettlement(null, "SIGKILL");
        }, 500);
        forceSettlementTimer.unref();
      };

      if (signal) {
        abortListener = () => {
          terminateChildAndSettleBounded("abort");
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }

      executionTimer = setTimeout(() => {
        terminateChildAndSettleBounded("timeout");
      }, this.commandTimeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (terminating || settled) return;
        totalBytes += chunk.length;
        if (totalBytes > this.maxOutputBytes) {
          terminateChildAndSettleBounded("overflow");
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (terminating || settled) return;
        totalBytes += chunk.length;
        if (totalBytes > this.maxOutputBytes) {
          terminateChildAndSettleBounded("overflow");
          return;
        }
        stderrChunks.push(chunk);
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanupAllTimers();
        destroyStreams();
        reject(new Error(`ERR_VM_COMMAND_SPAWN_FAILED: ${sanitizeErrorOutput(err.message)}`));
      });

      child.on("exit", (code, signalStr) => {
        if (terminating) {
          finalizeSettlement(code, signalStr);
        }
        // Otherwise wait for complete pipe closure ('close'). The original executionTimer
        // remains armed: an exited CLI with inherited open pipes must not turn
        // incomplete output into a successful result after an arbitrary grace period.
      });

      child.on("close", (code, signalStr) => {
        finalizeSettlement(code, signalStr);
      });
    });
  }

  /**
   * Probes the configured instance without booting or running commands in the guest.
   * Runs `limactl list --json` and verifies exact instance registration and status.
   * Fails closed if missing, duplicate/ambiguous, or corrupt schema.
   */
  async probe(signal?: AbortSignal): Promise<VmProbeResult> {
    const result = await this.runHostCli(["list", "--json"], signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `ERR_LIMA_PROBE_FAILED: limactl list exited with code ${result.exitCode}: ${sanitizeErrorOutput(result.stderr)}`
      );
    }

    return parseLimaListJsonOutput(result.stdout, this.config.instanceName);
  }

  /**
   * Starts the configured dedicated instance.
   * Lifecycle operations strictly require allowLifecycle=true AND dedicatedInstance=true.
   *
   * Native boundary (Lima v2.0.3):
   * `limactl start` lacks an existing-only flag to eliminate template auto-create TOCTOU
   * if the instance disappears between probe() and start(). Therefore native start
   * fails closed unless running under explicit testOnlyEmulator: true.
   */
  async start(signal?: AbortSignal): Promise<void> {
    if (!this.config.allowLifecycle || !this.config.dedicatedInstance) {
      throw new Error(
        "ERR_VM_LIFECYCLE_DISABLED: Lifecycle operations (start/stop) require both allowLifecycle=true and dedicatedInstance=true"
      );
    }

    if (!this.config.testOnlyEmulator) {
      throw new Error(
        "ERR_LIMA_NATIVE_BOUNDARY_UNSUPPORTED: Native limactl start is fail-closed in foundation (Lima v2.0.3 start lacks an existing-only flag to eliminate template auto-create TOCTOU)"
      );
    }

    // Pre-probe to verify existence and state
    const current = await this.probe(signal);
    if (current.status === "Running") {
      return; // Already running
    }
    if (current.status !== "Stopped") {
      throw new Error(
        `ERR_VM_START_FAILED: Cannot start instance "${this.config.instanceName}" from state "${current.status}"`
      );
    }

    // Start existing instance without interactive TTY
    const startArgs = ["start", "--tty=false", this.config.instanceName];
    const result = await this.runHostCli(startArgs, signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `ERR_VM_START_FAILED: Failed to start instance "${this.config.instanceName}": ${sanitizeErrorOutput(result.stderr)}`
      );
    }
  }

  /**
   * Stops the configured dedicated instance.
   * Targeted strictly at this instance via `limactl stop <instance>`.
   */
  async stop(signal?: AbortSignal): Promise<void> {
    if (!this.config.allowLifecycle || !this.config.dedicatedInstance) {
      throw new Error(
        "ERR_VM_LIFECYCLE_DISABLED: Lifecycle operations (start/stop) require both allowLifecycle=true and dedicatedInstance=true"
      );
    }

    // Recheck probe and pinned identity/state
    const current = await this.probe(signal);
    if (current.status === "Stopped") {
      return; // Already stopped
    }
    if (current.status !== "Running") {
      throw new Error(
        `ERR_VM_STOP_FAILED: Cannot stop instance "${this.config.instanceName}" from state "${current.status}"`
      );
    }

    const stopArgs = ["stop", this.config.instanceName];
    const result = await this.runHostCli(stopArgs, signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `ERR_VM_STOP_FAILED: Failed to stop instance "${this.config.instanceName}": ${sanitizeErrorOutput(result.stderr)}`
      );
    }
  }

  /**
   * Executes internal operator diagnostic command in the guest (emulator-verified argv path).
   * - `command` must be an absolute path inside guest (e.g. /usr/bin/uptime).
   * - Native boundary (Lima v2.0.3): fails closed when testOnlyEmulator !== true because
   *   `limactl shell` uses instance ssh.config (ControlMaster/ForwardAgent) and runs a guest
   *   login shell before `/usr/bin/env -i`.
   * - Probes instance existence and requires status === "Running" before invoking `limactl shell`.
   * - Direct argv array execution via `limactl shell` with shell: false.
   */
  async execOperatorCommand(
    command: string,
    args: readonly string[],
    signal?: AbortSignal
  ): Promise<VmCommandResult> {
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error("ERR_VM_COMMAND_INVALID: command must be a non-empty string");
    }
    if (!command.startsWith("/") || command.includes("\0") || command.includes("\n") || command.includes("\r")) {
      throw new Error(
        `ERR_VM_COMMAND_INVALID: command must be an absolute Linux path without null bytes or newlines (received "${command}")`
      );
    }
    if (command.split("/").includes("..")) {
      throw new Error(`ERR_VM_COMMAND_INVALID: Path traversal (..) is strictly forbidden in command: "${command}"`);
    }

    if (!Array.isArray(args)) {
      throw new Error("ERR_VM_COMMAND_INVALID: args must be an array of strings");
    }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg !== "string" || arg.includes("\0")) {
        throw new Error(`ERR_VM_COMMAND_INVALID: Argument at index ${i} must be a string without null bytes`);
      }
    }

    if (!this.config.testOnlyEmulator) {
      throw new Error(
        "ERR_LIMA_NATIVE_BOUNDARY_UNSUPPORTED: Native limactl shell diagnostic execution is fail-closed in foundation (Lima v2.0.3 shell uses instance ssh.config ControlMaster/ForwardAgent and guest login shell before env -i; boundary not yet enforced)"
      );
    }

    // Diagnostic must verify target instance existence and Running state before execution
    const probeResult = await this.probe(signal);
    if (probeResult.status !== "Running") {
      throw new Error(
        `ERR_LIMA_INSTANCE_NOT_RUNNING: Instance "${this.config.instanceName}" is in state "${probeResult.status}"; diagnostic execution requires Running state`
      );
    }

    // Construct argv for limactl shell (Lima v2.0.3: no --user flag)
    const spawnArgs: string[] = ["shell", this.config.instanceName];

    // Wrap with /usr/bin/env -i to enforce clean guest environment
    if (command === "/usr/bin/env" && args[0] === "-i") {
      spawnArgs.push(command, ...args);
    } else {
      spawnArgs.push("/usr/bin/env", "-i", command, ...args);
    }

    const result = await this.runHostCli(spawnArgs, signal, { isGuestInvocation: true });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
