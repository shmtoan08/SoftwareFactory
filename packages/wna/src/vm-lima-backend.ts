/**
 * @file vm-lima-backend.ts
 * @description Lima VM Backend Foundation for Software Factory M6C-3.
 *
 * Implements operator-pinned Lima instance lifecycle and diagnostic execution
 * according to the structural VM contract (M6C-3 Step 5 / Issue #16).
 *
 * Primary Documentation & Reference:
 * - Lima Reference: https://lima-vm.io/docs/reference/limactl/
 * - GitHub Repository: https://github.com/lima-vm/lima
 *
 * Features & Invariants:
 * - Operator configuration pinning: absolute binary path, instance identity, optional LIMA_HOME root, optional guest user.
 * - Strict boolean type validation: testOnlyEmulator, allowLifecycle, dedicatedInstance must be booleans at runtime.
 * - Structured JSON probing: Uses `limactl list --json`, supporting both JSON Lines stream and JSON array formats.
 *   Validates exact instance identity and status; rejects missing instances, ambiguous duplicates, and corrupt schemas without default fallback.
 * - Targeted lifecycle operations: 'start' boots registered instance via `limactl start --tty=false <instance>`,
 *   'stop' invokes `limactl stop <instance>`. Strictly forbids global shutdown, creation from template, image downloads, or configuration mutations.
 * - Diagnostic execution pre-probe: Probes instance existence and status before guest execution.
 * - Bounded operator execution: Direct argv array spawn with shell: false, guest env -i isolation,
 *   minimal host environment stripped of credentials, and SSH_AUTH_SOCK explicitly purged to prevent SSH agent forwarding.
 * - Bounded timeouts, output caps & inherited pipe hang defense: Single-pass cleanup, stream destruction,
 *   and bounded settlement preventing indefinite promise hangs when background descendants retain file descriptors.
 * - Uncertain outcome reporting: Abort, timeout, or guest output overflow terminates host transport (limactl)
 *   and reports uncertain guest state, never faking process cleanup or auto-stopping the instance.
 * - Strict platform gating: Production requires darwin host platform; emulator mode requires explicit boolean testOnlyEmulator: true.
 */

import { spawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";

// ============================================================================
// Structural Contract Types (Issue #16 / INTERFACE.md)
// ============================================================================

export interface VmProbeResult {
  readonly backend: "lima";
  readonly identity: string;
  readonly present: true;
  readonly status: string;
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
  readonly guestUser?: string;
  readonly allowLifecycle?: boolean;
  readonly dedicatedInstance?: boolean;
  readonly commandTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly testOnlyEmulator?: boolean;
}

export interface LimaInstanceEntry {
  readonly name: string;
  readonly status: string;
  readonly dir?: string;
  readonly arch?: string;
  readonly vmType?: string;
  readonly sshLocalPort?: number;
  readonly [key: string]: unknown;
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
const VALID_USERNAME_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*[$]?$/;

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
 * Strips SSH_AUTH_SOCK and SSH_AGENT_PID to prevent SSH agent forwarding into the VM.
 * Purges all Factory/Gateway/DB/Git/model credentials.
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

  if (limaHome) {
    minimal.LIMA_HOME = limaHome;
    minimal.LIMAHOME = limaHome;
  }

  // Explicitly purge SSH agent forwarding credentials
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
 * Parses the structured JSON output of `limactl list --json`.
 * Supports both JSON Lines stream format and JSON array format according to official Lima schemas.
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
    } catch (err) {
      throw new Error(
        `ERR_LIMA_OUTPUT_UNRECOGNIZED: Failed to parse JSON array from limactl list: ${sanitizeErrorOutput(String(err))}`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error("ERR_LIMA_OUTPUT_UNRECOGNIZED: Expected JSON array from limactl list");
    }
    for (const item of parsed) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>)["name"] === "string" &&
        typeof (item as Record<string, unknown>)["status"] === "string"
      ) {
        entries.push(item as LimaInstanceEntry);
      } else {
        throw new Error("ERR_LIMA_OUTPUT_UNRECOGNIZED: Invalid instance schema in limactl list JSON array");
      }
    }
  } else {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        throw new Error(
          `ERR_LIMA_OUTPUT_UNRECOGNIZED: Failed to parse JSON line ${i + 1} from limactl list: ${sanitizeErrorOutput(line)}`
        );
      }
      if (
        typeof obj === "object" &&
        obj !== null &&
        typeof (obj as Record<string, unknown>)["name"] === "string" &&
        typeof (obj as Record<string, unknown>)["status"] === "string"
      ) {
        entries.push(obj as LimaInstanceEntry);
      } else {
        throw new Error(`ERR_LIMA_OUTPUT_UNRECOGNIZED: Invalid instance schema at line ${i + 1} of limactl list output`);
      }
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
    dir: entry.dir,
    arch: entry.arch,
    vmType: entry.vmType,
    sshLocalPort: entry.sshLocalPort,
  };
}

// ============================================================================
// LimaVmBackend Class
// ============================================================================

export class LimaVmBackend {
  readonly config: LimaVmBackendConfig;
  readonly commandTimeoutMs: number;
  readonly maxOutputBytes: number;

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

    // 4. Validate optional guestUser
    if (config.guestUser !== undefined) {
      if (typeof config.guestUser !== "string" || config.guestUser.trim().length === 0) {
        throw new Error("ERR_LIMA_CONFIG_INVALID: guestUser must be a non-empty string if provided");
      }
      if (config.guestUser.includes("\0") || config.guestUser.includes("\n")) {
        throw new Error("ERR_LIMA_CONFIG_INVALID: guestUser must not contain null bytes or newlines");
      }
      if (config.guestUser.startsWith("-")) {
        throw new Error("ERR_LIMA_CONFIG_INVALID: guestUser must not start with a hyphen (-)");
      }
      if (!VALID_USERNAME_REGEX.test(config.guestUser)) {
        throw new Error(`ERR_LIMA_CONFIG_INVALID: guestUser contains invalid characters: "${config.guestUser}"`);
      }
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

    this.config = Object.freeze({
      ...config,
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
        env: buildMinimalHostEnv(this.config.limaHome),
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
        } else {
          if (!forceSettlementTimer) {
            forceSettlementTimer = setTimeout(() => {
              finalizeSettlement(code, signalStr);
            }, 300);
            forceSettlementTimer.unref();
          }
        }
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
   * Probes instance existence first to avoid limactl auto-creating a new instance from template.
   */
  async start(signal?: AbortSignal): Promise<void> {
    if (!this.config.allowLifecycle || !this.config.dedicatedInstance) {
      throw new Error(
        "ERR_VM_LIFECYCLE_DISABLED: Lifecycle operations (start/stop) require both allowLifecycle=true and dedicatedInstance=true"
      );
    }

    // Pre-probe to verify existence
    const current = await this.probe(signal);
    if (current.status.toLowerCase() === "running") {
      return; // Already running
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

    // Recheck probe and pinned identity
    await this.probe(signal);

    const stopArgs = ["stop", this.config.instanceName];
    const result = await this.runHostCli(stopArgs, signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `ERR_VM_STOP_FAILED: Failed to stop instance "${this.config.instanceName}": ${sanitizeErrorOutput(result.stderr)}`
      );
    }
  }

  /**
   * Executes internal operator diagnostic command in the guest.
   * - `command` must be an absolute path inside guest (e.g. /usr/bin/uptime).
   * - Probes instance existence and status using the same AbortSignal before execution.
   * - Direct argv array execution via `limactl shell` with shell: false.
   * - Executes under guest `env -i` clean environment.
   * - Host environment is sanitized and SSH_AUTH_SOCK is stripped.
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

    // Diagnostic must verify target instance existence before execution
    await this.probe(signal);

    // Construct argv for limactl shell
    const spawnArgs: string[] = ["shell"];

    if (this.config.guestUser) {
      spawnArgs.push("--user", this.config.guestUser);
    }

    spawnArgs.push(this.config.instanceName);

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
