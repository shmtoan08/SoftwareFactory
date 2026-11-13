/**
 * @file vm-wsl2-backend.ts
 * @description Windows Subsystem for Linux (WSL2) VM Backend Foundation for Software Factory M6C-3.
 *
 * Implements operator-pinned WSL2 distribution lifecycle and diagnostic execution
 * according to the structural VM contract (M6C-3 Step 5 / Issue #16).
 *
 * Features & Invariants:
 * - Operator configuration pinning: absolute binary path, distribution identity, guest user.
 * - Strict boolean type validation: testOnlyEmulator, allowLifecycle, dedicatedInstance must be booleans.
 * - Strict WSL2 validation: Probe validates distribution existence and strictly requires WSL version 2.
 *   Version tokens must strictly equal "2" (rejecting "2junk", "2.5", "02", etc.).
 * - No default fallback: Never falls back to the default distribution marked with asterisk (*).
 * - Real WSL CLI output decoding: Decodes UTF-16LE with BOM (\uFEFF), UTF-16LE without BOM, and UTF-8.
 * - Targeted lifecycle operations: 'start' boots registered distro, 'stop' invokes --terminate <Distro>.
 *   Strictly forbids --shutdown (which terminates all distros globally), install, import, or config mutation.
 * - Diagnostic execution pre-probe: Probes distribution identity and version 2 before guest execution.
 * - Bounded operator execution: Direct argv array spawn with shell: false, guest env -i isolation,
 *   minimal host environment without credential forwarding, and WSLENV explicitly cleared ("").
 * - Bounded timeouts, output caps & inherited pipe hang defense: Single-pass cleanup, stream destruction,
 *   and bounded settlement preventing inherited pipe hangs when descendants outlive parent.
 * - Uncertain outcome reporting: Abort, timeout, or guest output overflow terminates host transport (wsl.exe)
 *   and reports uncertain guest state, never faking process cleanup or auto-terminating the entire distro.
 * - Strict platform gating: Production requires win32 host platform; emulator mode requires explicit
 *   constructor flag testOnlyEmulator: true (strictly validated as boolean true).
 */

import { spawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";

// ============================================================================
// Structural Contract Types (Issue #16 / INTERFACE.md)
// ============================================================================

export interface VmProbeResult {
  readonly backend: "wsl2";
  readonly identity: string;
  readonly present: true;
  readonly wslVersion: 2;
  readonly state?: string;
}

export interface VmCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Wsl2VmBackendConfig {
  readonly binaryPath: string;
  readonly distributionName: string;
  readonly guestUser?: string;
  readonly allowLifecycle?: boolean;
  readonly dedicatedInstance?: boolean;
  readonly commandTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly testOnlyEmulator?: boolean;
}

export interface ParsedWslDistroEntry {
  readonly name: string;
  readonly state: string;
  readonly version: number | null;
  readonly rawVersion: string;
  readonly isDefault: boolean;
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

const VALID_DISTRO_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/;
const VALID_USERNAME_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*[$]?$/;

// ============================================================================
// Encoding & Output Helpers
// ============================================================================

/**
 * Decodes raw stdout/stderr bytes from wsl.exe.
 * Handles UTF-16LE with BOM, UTF-16BE with BOM, UTF-8 with BOM, UTF-16LE without BOM, and standard UTF-8.
 */
export function decodeWslOutput(raw: Buffer): string {
  if (raw.length === 0) return "";

  // UTF-16LE with BOM (0xFF, 0xFE)
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.toString("utf16le").replace(/^\uFEFF/, "");
  }

  // UTF-16BE with BOM (0xFE, 0xFF)
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.from(raw);
    swapped.swap16();
    return swapped.toString("utf16le").replace(/^\uFEFF/, "");
  }

  // UTF-8 with BOM (0xEF, 0xBB, 0xBF)
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return raw.toString("utf8").replace(/^\uFEFF/, "");
  }

  // UTF-16LE without BOM (Windows console pipe default)
  // When ASCII text is rendered in UTF-16LE, even indices hold ASCII values and odd indices are 0x00.
  if (raw.length >= 4 && raw.length % 2 === 0 && raw[1] === 0x00 && raw[3] === 0x00) {
    return raw.toString("utf16le").replace(/^\uFEFF/, "");
  }

  // Default fallback: UTF-8
  return raw.toString("utf8").replace(/^\uFEFF/, "");
}

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
 * Constructs minimal sanitized host environment for spawning wsl.exe on Windows.
 * Ensures no factory, gateway, git, db, or model credentials leak,
 * and sets WSLENV strictly to empty string to prevent host-to-guest variable translation.
 */
export function buildMinimalHostEnv(): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot || "C:\\Windows",
    SYSTEMDRIVE: process.env.SYSTEMDRIVE || "C:",
    PATH: process.env.PATH || "C:\\Windows\\System32;C:\\Windows",
    TEMP: process.env.TEMP || "C:\\Windows\\Temp",
    TMP: process.env.TMP || "C:\\Windows\\Temp",
    // CRITICAL: WSLENV controls environment variable sharing between Windows and Linux.
    // Setting it strictly to empty string prevents any host variables from leaking into WSL guest.
    WSLENV: "",
  };

  // Explicitly purge any sensitive keys if they managed to sneak in
  for (const key of Object.keys(minimal)) {
    if (SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_PREFIX_PATTERN.test(key)) {
      delete minimal[key];
    }
  }

  return minimal;
}

/**
 * Parses the tabular text output of `wsl.exe --list --verbose`.
 * Expected column format:
 *   [NAME] [STATE] [VERSION]
 * with optional leading asterisk (*) marking the default distro.
 *
 * Strict Version Parsing Contract:
 * - Version token must strictly match "1" or "2".
 * - Malformed tokens like "2junk", "2.5", "02", "v2" are NOT accepted as valid versions.
 */
export function parseWslListVerboseOutput(decoded: string, targetDistro: string): VmProbeResult {
  const lines = decoded
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    throw new Error("ERR_WSL_OUTPUT_UNRECOGNIZED: wsl --list output is completely empty");
  }

  // First non-empty line must be header line
  const headerLine = lines[0];
  if (!headerLine || /^\s*[*]?\s*\S.*\s+[12]$/.test(headerLine)) {
    throw new Error("ERR_WSL_OUTPUT_UNRECOGNIZED: Expected header line in wsl --list output, found data line");
  }

  const entries: ParsedWslDistroEntry[] = [];

  // Regex to match data rows:
  // Group 1: optional asterisk (*)
  // Group 2: distribution name (between start/* and state)
  // Group 3: state (e.g. Running, Stopped, En cours...)
  // Group 4: version column (e.g. 1, 2, or other token)
  const rowRegex = /^\s*(\*)?\s*(\S.*?)\s{2,}(\S.*?)\s{2,}(\S+)\s*$/;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const match = rowRegex.exec(line);
    if (!match || !match[2] || !match[3] || !match[4]) {
      throw new Error(
        `ERR_WSL_OUTPUT_UNRECOGNIZED: Unable to parse line ${i + 1} of wsl --list output: "${sanitizeErrorOutput(line)}"`
      );
    }

    const isDefault = match[1] === "*";
    const name = match[2].trim();
    const state = match[3].trim();
    const rawVersion = match[4].trim();

    // Strict version validation: ONLY "1" or "2" are valid version integers
    let version: number | null = null;
    if (rawVersion === "1") {
      version = 1;
    } else if (rawVersion === "2") {
      version = 2;
    }

    entries.push({
      name,
      state,
      version,
      rawVersion,
      isDefault,
    });
  }

  if (entries.length === 0) {
    throw new Error("ERR_WSL_DISTRO_NOT_FOUND: No installed WSL distributions found in output");
  }

  // Exact identity match (case-sensitive as specified by operator registration)
  const matches = entries.filter((e) => e.name === targetDistro);

  if (matches.length > 1) {
    throw new Error(
      `ERR_WSL_DISTRO_AMBIGUOUS: Multiple entries found for distribution "${targetDistro}" in WSL listing`
    );
  }

  const entry = matches[0];
  if (!entry) {
    throw new Error(
      `ERR_WSL_DISTRO_NOT_FOUND: Configured distribution "${targetDistro}" was not found in WSL distributions`
    );
  }

  // Strictly enforce WSL Version 2 (token must be strictly "2")
  if (entry.rawVersion !== "2" || entry.version !== 2) {
    throw new Error(
      `ERR_WSL_VERSION_UNSUPPORTED: Distribution "${targetDistro}" has unsupported or malformed WSL version "${entry.rawVersion}", strictly require version 2`
    );
  }

  return {
    backend: "wsl2",
    identity: entry.name,
    present: true,
    wslVersion: 2,
    state: entry.state,
  };
}

// ============================================================================
// Wsl2VmBackend Class
// ============================================================================

export class Wsl2VmBackend {
  readonly config: Wsl2VmBackendConfig;
  readonly commandTimeoutMs: number;
  readonly maxOutputBytes: number;

  constructor(config: Wsl2VmBackendConfig) {
    if (!config || typeof config !== "object") {
      throw new Error("ERR_WSL_CONFIG_INVALID: Configuration object is required");
    }

    // 1. Validate binaryPath
    if (typeof config.binaryPath !== "string" || config.binaryPath.trim().length === 0) {
      throw new Error("ERR_WSL_CONFIG_INVALID: binaryPath must be a non-empty string");
    }
    if (config.binaryPath.includes("\0")) {
      throw new Error("ERR_WSL_CONFIG_INVALID: binaryPath must not contain null bytes");
    }
    const isAbs = isAbsolute(config.binaryPath) || win32.isAbsolute(config.binaryPath);
    if (!isAbs) {
      throw new Error(`ERR_WSL_CONFIG_INVALID: binaryPath must be an absolute path (received "${config.binaryPath}")`);
    }

    // 2. Validate distributionName
    if (typeof config.distributionName !== "string" || config.distributionName.trim().length === 0) {
      throw new Error("ERR_WSL_CONFIG_INVALID: distributionName must be a non-empty string");
    }
    if (config.distributionName.includes("\0") || config.distributionName.includes("\n")) {
      throw new Error("ERR_WSL_CONFIG_INVALID: distributionName must not contain null bytes or newlines");
    }
    if (config.distributionName.startsWith("-")) {
      throw new Error("ERR_WSL_CONFIG_INVALID: distributionName must not start with a hyphen (-)");
    }
    if (!VALID_DISTRO_NAME_REGEX.test(config.distributionName)) {
      throw new Error(`ERR_WSL_CONFIG_INVALID: distributionName contains invalid characters: "${config.distributionName}"`);
    }

    // 3. Validate optional guestUser
    if (config.guestUser !== undefined) {
      if (typeof config.guestUser !== "string" || config.guestUser.trim().length === 0) {
        throw new Error("ERR_WSL_CONFIG_INVALID: guestUser must be a non-empty string if provided");
      }
      if (config.guestUser.includes("\0") || config.guestUser.includes("\n")) {
        throw new Error("ERR_WSL_CONFIG_INVALID: guestUser must not contain null bytes or newlines");
      }
      if (config.guestUser.startsWith("-")) {
        throw new Error("ERR_WSL_CONFIG_INVALID: guestUser must not start with a hyphen (-)");
      }
      if (!VALID_USERNAME_REGEX.test(config.guestUser)) {
        throw new Error(`ERR_WSL_CONFIG_INVALID: guestUser contains invalid characters: "${config.guestUser}"`);
      }
    }

    // 4. Validate strict boolean options
    if (config.testOnlyEmulator !== undefined && typeof config.testOnlyEmulator !== "boolean") {
      throw new Error(
        `ERR_WSL_CONFIG_INVALID: testOnlyEmulator must be a boolean (received ${typeof config.testOnlyEmulator})`
      );
    }
    if (config.allowLifecycle !== undefined && typeof config.allowLifecycle !== "boolean") {
      throw new Error(
        `ERR_WSL_CONFIG_INVALID: allowLifecycle must be a boolean (received ${typeof config.allowLifecycle})`
      );
    }
    if (config.dedicatedInstance !== undefined && typeof config.dedicatedInstance !== "boolean") {
      throw new Error(
        `ERR_WSL_CONFIG_INVALID: dedicatedInstance must be a boolean (received ${typeof config.dedicatedInstance})`
      );
    }

    // 5. Validate timeouts and bounded limits (strictly finite positive integers)
    const timeout = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (
      typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      !Number.isInteger(timeout) ||
      timeout <= 0 ||
      timeout > MAX_ALLOWED_TIMEOUT_MS
    ) {
      throw new Error(
        `ERR_WSL_CONFIG_INVALID: commandTimeoutMs must be an integer > 0 and <= ${MAX_ALLOWED_TIMEOUT_MS} (received ${timeout})`
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
        `ERR_WSL_CONFIG_INVALID: maxOutputBytes must be an integer > 0 and <= ${MAX_ALLOWED_OUTPUT_BYTES} (received ${maxBytes})`
      );
    }
    this.maxOutputBytes = maxBytes;

    // 6. Strict platform check vs normalized boolean emulator mode
    const isEmulator = config.testOnlyEmulator === true;
    if (!isEmulator) {
      if (process.platform !== "win32") {
        throw new Error(
          `ERR_WSL_PLATFORM_UNSUPPORTED: WSL2 backend requires win32 host platform (current platform is "${process.platform}"). Use testOnlyEmulator: true for testing.`
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
   * Internal runner for host CLI invocations (wsl.exe).
   * Features:
   * - Single-pass cleanup of timers and event listeners.
   * - Bounded settlement: destroys parent stream handles on timeout/abort/overflow so descendant
   *   processes retaining stdout/stderr file descriptors cannot hang the promise indefinitely.
   * - Differentiates guest invocations to preserve uncertain outcome diagnostics on overflow.
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
        env: buildMinimalHostEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      const destroyStreams = () => {
        try {
          if (!child.stdout.destroyed) child.stdout.destroy();
        } catch {
          // ignore stream destruction errors
        }
        try {
          if (!child.stderr.destroyed) child.stderr.destroy();
        } catch {
          // ignore stream destruction errors
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
              "ERR_VM_COMMAND_UNCERTAIN: Host transport aborted; guest process termination is uncertain (killing wsl.exe does not guarantee guest process stopped)"
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
          stdout: decodeWslOutput(rawStdout),
          stderr: decodeWslOutput(rawStderr),
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

        // Destroy parent read-end streams immediately so descendant pipe retention cannot hold parent pipe
        destroyStreams();

        // Send SIGTERM to direct child
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore kill errors
        }

        // Single escalation timer: escalate to SIGKILL after 250ms
        killEscalationTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore kill errors
          }
        }, 250);
        killEscalationTimer.unref();

        // Bounded settlement watchdog: ensure runner settles within 500ms even if pipes or exit events hang
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
        // When direct child exits, if close doesn't follow shortly (e.g. inherited pipe held by descendant),
        // bounded force settlement will ensure we do not hang!
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
   * Probes the configured distribution without booting or running commands in the guest.
   * Runs `wsl.exe --list --verbose` and verifies:
   * 1. The exact configured distribution exists.
   * 2. The distribution is using WSL version 2.
   * Fails closed if missing, WSL1, duplicate/ambiguous, or unparseable.
   */
  async probe(signal?: AbortSignal): Promise<VmProbeResult> {
    const result = await this.runHostCli(["--list", "--verbose"], signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `ERR_WSL_PROBE_FAILED: wsl.exe --list exited with code ${result.exitCode}: ${sanitizeErrorOutput(result.stderr)}`
      );
    }

    return parseWslListVerboseOutput(result.stdout, this.config.distributionName);
  }

  /**
   * Starts the configured dedicated distribution.
   * Lifecycle operations strictly require allowLifecycle=true AND dedicatedInstance=true.
   */
  async start(signal?: AbortSignal): Promise<void> {
    if (!this.config.allowLifecycle || !this.config.dedicatedInstance) {
      throw new Error(
        "ERR_VM_LIFECYCLE_DISABLED: Lifecycle operations (start/stop) require both allowLifecycle=true and dedicatedInstance=true"
      );
    }

    // Recheck probe and pinned identity
    const current = await this.probe(signal);
    if (current.state?.toLowerCase() === "running") {
      return; // Already running
    }

    // Non-interactive execution to start the dedicated distribution
    const startArgs = ["--distribution", this.config.distributionName, "--exec", "/bin/true"];
    const result = await this.runHostCli(startArgs, signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `ERR_VM_START_FAILED: Failed to start distribution "${this.config.distributionName}": ${sanitizeErrorOutput(result.stderr)}`
      );
    }
  }

  /**
   * Stops the configured dedicated distribution.
   * Invocations use `--terminate <Distro>` strictly targeted at this distribution.
   * NEVER calls `--shutdown` (which kills all distributions globally).
   */
  async stop(signal?: AbortSignal): Promise<void> {
    if (!this.config.allowLifecycle || !this.config.dedicatedInstance) {
      throw new Error(
        "ERR_VM_LIFECYCLE_DISABLED: Lifecycle operations (start/stop) require both allowLifecycle=true and dedicatedInstance=true"
      );
    }

    // Recheck probe and pinned identity
    await this.probe(signal);

    // Terminate ONLY the targeted distribution
    const stopArgs = ["--terminate", this.config.distributionName];
    const result = await this.runHostCli(stopArgs, signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `ERR_VM_STOP_FAILED: Failed to terminate distribution "${this.config.distributionName}": ${sanitizeErrorOutput(result.stderr)}`
      );
    }
  }

  /**
   * Executes internal operator diagnostic command in the guest.
   * - `command` must be an absolute path inside guest (e.g. /usr/bin/uptime).
   * - Probes distribution existence and WSL version 2 using the same AbortSignal before execution.
   * - Direct argv array execution with shell: false.
   * - Executes under guest `env -i` clean environment.
   * - Host environment is sanitized and WSLENV is set to empty string.
   * - Public task/action data must NEVER be passed as command selection.
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

    // Diagnostic must verify target distribution existence and version 2 before execution
    await this.probe(signal);

    // Construct argv for wsl.exe
    const spawnArgs: string[] = [
      "--distribution",
      this.config.distributionName,
    ];

    if (this.config.guestUser) {
      spawnArgs.push("--user", this.config.guestUser);
    }

    // Wrap with /usr/bin/env -i to enforce clean guest environment
    if (command === "/usr/bin/env" && args[0] === "-i") {
      spawnArgs.push("--exec", command, ...args);
    } else {
      spawnArgs.push("--exec", "/usr/bin/env", "-i", command, ...args);
    }

    const result = await this.runHostCli(spawnArgs, signal, { isGuestInvocation: true });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
