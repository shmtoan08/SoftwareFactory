/**
 * @file m6c3-vm-lima.test.ts
 * @description Unit and contract test suite for LimaVmBackend (Issue #16 / M6C-3 VM Foundation).
 *
 * Verifies:
 * - Production platform guard: requires darwin host platform; emulator mode requires explicit boolean testOnlyEmulator: true.
 * - Configuration validation: absolute binaryPath, instanceName, optional limaHome, guestUser, strict boolean options,
 *   strictly bounded finite integer commandTimeoutMs (<= 120000) and maxOutputBytes (<= 1048576).
 * - Structured JSON probing: parses official JSON Lines and JSON array schemas from `limactl list --json`,
 *   validates exact instance identity and status, rejects missing instances, ambiguous duplicates, and corrupt schemas without default fallback.
 * - Targeted lifecycle operations: start/stop require both allowLifecycle=true and dedicatedInstance=true.
 *   Start invokes `limactl start --tty=false <instance>` after probe verifies instance exists (preventing template auto-creation).
 *   Stop invokes `limactl stop <instance>` strictly targeted.
 * - Diagnostic execution pre-probe: execOperatorCommand validates arguments, probes instance before guest invocation,
 *   and halts without secondary execution if probe fails.
 * - Operator command execution: direct argv array execution via `limactl shell`, shell: false, clean guest env-i, host env minimal,
 *   excludes canary credentials, and purges SSH_AUTH_SOCK to block SSH agent forwarding.
 * - Bounded settlement & inherited pipe hang defense: single-pass cleanup, stream destruction, and bounded
 *   settlement preventing hangs when descendants outlive parent.
 * - Uncertain outcome reporting: abort, timeout, or guest output overflow reports uncertain guest state,
 *   never retrying automatically or faking guest cleanup.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LimaVmBackend,
  parseLimaListJsonOutput,
  sanitizeErrorOutput,
} from "../../wna/src/vm-lima-backend.ts";

// ============================================================================
// Fixture Helpers
// ============================================================================

interface RecordedInvocation {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function withTempFixture(
  fixtureScriptContent: string | ((testDir: string) => string),
  fn: (fixturePath: string, testDir: string) => Promise<void> | void
): Promise<void> {
  const testDir = mkdtempSync(join(tmpdir(), "sf-vm-lima-test-"));
  const fixturePath = join(testDir, "fake-limactl.mjs");
  const content =
    typeof fixtureScriptContent === "function"
      ? fixtureScriptContent(testDir)
      : fixtureScriptContent;
  writeFileSync(fixturePath, content, { mode: 0o755 });
  chmodSync(fixturePath, 0o755);

  const cleanup = () => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  try {
    const result = fn(fixturePath, testDir);
    if (result instanceof Promise) {
      return result.finally(cleanup);
    }
    cleanup();
    return Promise.resolve();
  } catch (err) {
    cleanup();
    throw err;
  }
}

function readRecordedInvocation(recordFile: string): RecordedInvocation {
  const content = readFileSync(recordFile, "utf8");
  return JSON.parse(content) as RecordedInvocation;
}

// ============================================================================
// Test Suite
// ============================================================================

describe("M6C-3 Step 5 — Lima VM Backend Foundation (LimaVmBackend)", () => {

  // --------------------------------------------------------------------------
  // Group 1: Production Platform Guard & Configuration Validation
  // --------------------------------------------------------------------------
  describe("Group 1: Production Platform Guard & Configuration Validation", () => {
    it("production guard rejects non-darwin platforms when testOnlyEmulator is false", () => {
      if (process.platform === "darwin") {
        return; // Skip on native Darwin host
      }

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/usr/local/bin/limactl",
            instanceName: "worker-vm",
            testOnlyEmulator: false,
          }),
        (err: Error) => {
          assert.match(err.message, /^ERR_LIMA_PLATFORM_UNSUPPORTED/);
          assert.match(err.message, /requires darwin host platform/);
          assert.match(err.message, /testOnlyEmulator: true/);
          return true;
        }
      );
    });

    it("constructor rejects non-boolean testOnlyEmulator via cast ('false', 'true', 1, 0, {})", () => {
      for (const invalid of ["false", "true", 1, 0, {}, []] as const) {
        assert.throws(
          () =>
            new LimaVmBackend({
              binaryPath: "/bin/limactl",
              instanceName: "worker-vm",
              testOnlyEmulator: invalid as unknown as boolean,
            }),
          /ERR_LIMA_CONFIG_INVALID.*testOnlyEmulator must be a boolean/
        );
      }
    });

    it("constructor rejects non-boolean allowLifecycle and dedicatedInstance via cast", () => {
      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            allowLifecycle: "true" as unknown as boolean,
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*allowLifecycle must be a boolean/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            dedicatedInstance: 1 as unknown as boolean,
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*dedicatedInstance must be a boolean/
      );
    });

    it("constructor rejects relative or empty binaryPath", () => {
      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "limactl",
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*binaryPath must be an absolute path/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "",
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*binaryPath must be a non-empty string/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/path/to\0/limactl",
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*binaryPath must not contain null bytes/
      );
    });

    it("constructor rejects relative limaHome", () => {
      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            limaHome: "./relative/lima",
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*limaHome must be an absolute path/
      );
    });

    it("constructor rejects invalid instanceName", () => {
      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "",
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*instanceName must be a non-empty string/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "--all",
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*instanceName must not start with a hyphen/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "vm\0name",
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*instanceName must not contain null bytes/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "vm name with spaces",
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*instanceName contains invalid characters/
      );
    });

    it("constructor rejects invalid guestUser", () => {
      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            guestUser: "-root",
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*guestUser must not start with a hyphen/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            guestUser: "user\0name",
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*guestUser must not contain null bytes/
      );
    });

    it("constructor validates commandTimeoutMs bounds and integer type", () => {
      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            commandTimeoutMs: -100,
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*commandTimeoutMs must be an integer > 0/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            commandTimeoutMs: 100.5,
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*commandTimeoutMs must be an integer > 0/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            commandTimeoutMs: 200_000, // > 120_000 max
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*commandTimeoutMs must be an integer > 0 and <= 120000/
      );
    });

    it("constructor validates maxOutputBytes bounds and integer type", () => {
      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            maxOutputBytes: 0,
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*maxOutputBytes must be an integer > 0/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            maxOutputBytes: 1024.5,
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*maxOutputBytes must be an integer > 0/
      );

      assert.throws(
        () =>
          new LimaVmBackend({
            binaryPath: "/bin/limactl",
            instanceName: "worker-vm",
            maxOutputBytes: 2 * 1024 * 1024, // > 1 MiB max
            testOnlyEmulator: true,
          }),
        /ERR_LIMA_CONFIG_INVALID.*maxOutputBytes must be an integer > 0 and <= 1048576/
      );
    });

    it("constructor applies default lifecycle and bounding options", () => {
      const backend = new LimaVmBackend({
        binaryPath: "/bin/limactl",
        instanceName: "worker-vm",
        testOnlyEmulator: true,
      });

      assert.strictEqual(backend.config.allowLifecycle, false);
      assert.strictEqual(backend.config.dedicatedInstance, false);
      assert.strictEqual(backend.config.commandTimeoutMs, 10_000);
      assert.strictEqual(backend.config.maxOutputBytes, 65_536);
      assert.strictEqual(backend.config.testOnlyEmulator, true);
    });
  });

  // --------------------------------------------------------------------------
  // Group 2: Structured JSON Output Parsing (parseLimaListJsonOutput)
  // --------------------------------------------------------------------------
  describe("Group 2: Structured JSON Output Parsing (parseLimaListJsonOutput)", () => {
    it("parseLimaListJsonOutput parses standard JSON Lines (JSONL) stream output", () => {
      const jsonl = [
        JSON.stringify({ name: "default", status: "Running", dir: "/lima/default", arch: "aarch64", vmType: "vz" }),
        JSON.stringify({ name: "worker-vm", status: "Running", dir: "/lima/worker-vm", arch: "aarch64", vmType: "vz", sshLocalPort: 60022 }),
        JSON.stringify({ name: "testing-vm", status: "Stopped", dir: "/lima/testing-vm", arch: "x86_64", vmType: "qemu" }),
      ].join("\n");

      const result = parseLimaListJsonOutput(jsonl, "worker-vm");
      assert.strictEqual(result.backend, "lima");
      assert.strictEqual(result.identity, "worker-vm");
      assert.strictEqual(result.present, true);
      assert.strictEqual(result.status, "Running");
      assert.strictEqual(result.dir, "/lima/worker-vm");
      assert.strictEqual(result.arch, "aarch64");
      assert.strictEqual(result.vmType, "vz");
      assert.strictEqual(result.sshLocalPort, 60022);
    });

    it("parseLimaListJsonOutput parses JSON array format", () => {
      const jsonArray = JSON.stringify([
        { name: "default", status: "Stopped" },
        { name: "worker-vm", status: "Running", dir: "/lima/worker-vm" },
      ]);

      const result = parseLimaListJsonOutput(jsonArray, "worker-vm");
      assert.strictEqual(result.identity, "worker-vm");
      assert.strictEqual(result.status, "Running");
      assert.strictEqual(result.dir, "/lima/worker-vm");
    });

    it("parseLimaListJsonOutput rejects missing instance (no default fallback)", () => {
      const jsonl = JSON.stringify({ name: "default", status: "Running" });
      assert.throws(
        () => parseLimaListJsonOutput(jsonl, "worker-vm"),
        /ERR_LIMA_INSTANCE_NOT_FOUND.*Configured Lima instance "worker-vm" was not found/
      );
    });

    it("parseLimaListJsonOutput rejects duplicate instances with the same name", () => {
      const jsonl = [
        JSON.stringify({ name: "worker-vm", status: "Running" }),
        JSON.stringify({ name: "worker-vm", status: "Stopped" }),
      ].join("\n");

      assert.throws(
        () => parseLimaListJsonOutput(jsonl, "worker-vm"),
        /ERR_LIMA_INSTANCE_AMBIGUOUS.*Multiple entries found/
      );
    });

    it("parseLimaListJsonOutput rejects corrupt or invalid JSON lines", () => {
      const corrupt = "not a valid json string\n";
      assert.throws(
        () => parseLimaListJsonOutput(corrupt, "worker-vm"),
        /ERR_LIMA_OUTPUT_UNRECOGNIZED.*Failed to parse JSON/
      );
    });

    it("parseLimaListJsonOutput rejects invalid instance schema missing name or status", () => {
      const invalidSchema = JSON.stringify({ dir: "/lima/broken" });
      assert.throws(
        () => parseLimaListJsonOutput(invalidSchema, "worker-vm"),
        /ERR_LIMA_OUTPUT_UNRECOGNIZED.*Invalid instance schema/
      );
    });

    it("parseLimaListJsonOutput rejects completely empty output", () => {
      assert.throws(
        () => parseLimaListJsonOutput("", "worker-vm"),
        /ERR_LIMA_OUTPUT_UNRECOGNIZED.*completely empty/
      );
    });
  });

  // --------------------------------------------------------------------------
  // Group 3: Instance Probing Contract (probe())
  // --------------------------------------------------------------------------
  describe("Group 3: Instance Probing Contract (probe())", () => {
    it("probe succeeds with registered Running instance from JSON Lines output", async () => {
      const sample = JSON.stringify({
        name: "worker-vm",
        status: "Running",
        dir: "/Users/user/.lima/worker-vm",
        arch: "aarch64",
        vmType: "vz",
        sshLocalPort: 60022,
      }) + "\n";

      await withTempFixture(
        () => `#!/usr/bin/env node
          const args = process.argv.slice(2);
          if (args.includes('list') && args.includes('--json')) {
            process.stdout.write(${JSON.stringify(sample)});
            process.exit(0);
          }
          process.exit(1);
        `,
        async (fixturePath) => {
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          });

          const probe = await backend.probe();
          assert.strictEqual(probe.backend, "lima");
          assert.strictEqual(probe.identity, "worker-vm");
          assert.strictEqual(probe.present, true);
          assert.strictEqual(probe.status, "Running");
          assert.strictEqual(probe.arch, "aarch64");
          assert.strictEqual(probe.vmType, "vz");
          assert.strictEqual(probe.sshLocalPort, 60022);
        }
      );
    });

    it("probe succeeds with Stopped instance from JSON array output", async () => {
      const sample = JSON.stringify([
        { name: "default", status: "Running" },
        { name: "worker-vm", status: "Stopped", dir: "/lima/worker-vm" },
      ]);

      await withTempFixture(
        () => `#!/usr/bin/env node
          const args = process.argv.slice(2);
          if (args.includes('list') && args.includes('--json')) {
            process.stdout.write(${JSON.stringify(sample)});
            process.exit(0);
          }
          process.exit(1);
        `,
        async (fixturePath) => {
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          });

          const probe = await backend.probe();
          assert.strictEqual(probe.identity, "worker-vm");
          assert.strictEqual(probe.status, "Stopped");
        }
      );
    });

    it("probe rejects missing instance (fail-closed, no fallback to default)", async () => {
      const sample = JSON.stringify({ name: "default", status: "Running" }) + "\n";

      await withTempFixture(
        () => `#!/usr/bin/env node
          process.stdout.write(${JSON.stringify(sample)});
        `,
        async (fixturePath) => {
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          });

          await assert.rejects(
            async () => backend.probe(),
            /ERR_LIMA_INSTANCE_NOT_FOUND/
          );
        }
      );
    });

    it("probe fails when limactl list exits with non-zero code", async () => {
      await withTempFixture(
        () => `#!/usr/bin/env node
          process.stderr.write("limactl: daemon not reachable\\n");
          process.exit(1);
        `,
        async (fixturePath) => {
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          });

          await assert.rejects(
            async () => backend.probe(),
            /ERR_LIMA_PROBE_FAILED.*limactl list exited with code 1/
          );
        }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Group 4: Lifecycle Operations (start() and stop())
  // --------------------------------------------------------------------------
  describe("Group 4: Lifecycle Operations (start() and stop())", () => {
    it("lifecycle operations fail closed when allowLifecycle is false", async () => {
      const backend = new LimaVmBackend({
        binaryPath: "/bin/limactl",
        instanceName: "worker-vm",
        allowLifecycle: false,
        dedicatedInstance: true,
        testOnlyEmulator: true,
      });

      await assert.rejects(
        async () => backend.start(),
        /ERR_VM_LIFECYCLE_DISABLED.*require both allowLifecycle=true and dedicatedInstance=true/
      );

      await assert.rejects(
        async () => backend.stop(),
        /ERR_VM_LIFECYCLE_DISABLED.*require both allowLifecycle=true and dedicatedInstance=true/
      );
    });

    it("lifecycle operations fail closed when dedicatedInstance is false", async () => {
      const backend = new LimaVmBackend({
        binaryPath: "/bin/limactl",
        instanceName: "worker-vm",
        allowLifecycle: true,
        dedicatedInstance: false,
        testOnlyEmulator: true,
      });

      await assert.rejects(
        async () => backend.start(),
        /ERR_VM_LIFECYCLE_DISABLED.*require both allowLifecycle=true and dedicatedInstance=true/
      );

      await assert.rejects(
        async () => backend.stop(),
        /ERR_VM_LIFECYCLE_DISABLED.*require both allowLifecycle=true and dedicatedInstance=true/
      );
    });

    it("start() probes and invokes targeted limactl start --tty=false <instance> for stopped instance", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          const logFile = ${JSON.stringify(join(testDir, "invocations.log"))};
          appendFileSync(logFile, JSON.stringify(args) + '\\n');

          if (args.includes('list')) {
            process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Stopped" }) + '\\n');
          } else {
            process.stdout.write("started\\n");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            allowLifecycle: true,
            dedicatedInstance: true,
            testOnlyEmulator: true,
          });

          await backend.start();

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 2);
          // 1. Probe
          assert.deepStrictEqual(lines[0], ["list", "--json"]);
          // 2. Targeted start with --tty=false
          assert.deepStrictEqual(lines[1], ["start", "--tty=false", "worker-vm"]);
        }
      );
    });

    it("start() is a no-op if probe shows instance is already Running", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          const logFile = ${JSON.stringify(join(testDir, "invocations.log"))};
          appendFileSync(logFile, JSON.stringify(args) + '\\n');

          if (args.includes('list')) {
            process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            allowLifecycle: true,
            dedicatedInstance: true,
            testOnlyEmulator: true,
          });

          await backend.start();

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 1);
          assert.deepStrictEqual(lines[0], ["list", "--json"]);
        }
      );
    });

    it("start() rejects if instance does not exist (prevents auto-create from template)", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          appendFileSync(${JSON.stringify(join(testDir, "invocations.log"))}, JSON.stringify(args) + '\\n');

          if (args.includes('list')) {
            // Missing worker-vm
            process.stdout.write(JSON.stringify({ name: "other-vm", status: "Stopped" }) + '\\n');
          } else {
            process.stdout.write("auto-created\\n");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            allowLifecycle: true,
            dedicatedInstance: true,
            testOnlyEmulator: true,
          });

          await assert.rejects(
            async () => backend.start(),
            /ERR_LIMA_INSTANCE_NOT_FOUND/
          );

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 1);
          assert.deepStrictEqual(lines[0], ["list", "--json"]);
        }
      );
    });

    it("stop() invokes targeted limactl stop <instance> strictly", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          const logFile = ${JSON.stringify(join(testDir, "invocations.log"))};
          appendFileSync(logFile, JSON.stringify(args) + '\\n');

          if (args.includes('list')) {
            process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
          } else {
            process.stdout.write("stopped\\n");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            allowLifecycle: true,
            dedicatedInstance: true,
            testOnlyEmulator: true,
          });

          await backend.stop();

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 2);
          assert.deepStrictEqual(lines[0], ["list", "--json"]);
          assert.deepStrictEqual(lines[1], ["stop", "worker-vm"]);
        }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Group 5: Operator Diagnostic Execution (execOperatorCommand())
  // --------------------------------------------------------------------------
  describe("Group 5: Operator Diagnostic Execution (execOperatorCommand())", () => {
    it("execOperatorCommand executes command via direct argv array under clean guest env-i after probe", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { writeFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          if (args.includes('list')) {
            process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
            process.exit(0);
          }
          const record = {
            argv: args,
            env: process.env,
          };
          writeFileSync(${JSON.stringify(join(testDir, "exec-record.json"))}, JSON.stringify(record));
          process.stdout.write("uptime-ok\\n");
        `,
        async (fixturePath, testDir) => {
          const recordFile = join(testDir, "exec-record.json");
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          });

          const result = await backend.execOperatorCommand("/usr/bin/uptime", []);
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, "uptime-ok\n");
          assert.strictEqual(result.stderr, "");

          const record = readRecordedInvocation(recordFile);
          assert.deepStrictEqual(record.argv, [
            "shell",
            "worker-vm",
            "/usr/bin/env",
            "-i",
            "/usr/bin/uptime",
          ]);
        }
      );
    });

    it("execOperatorCommand includes --user <guestUser> when configured", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { writeFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          if (args.includes('list')) {
            process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
            process.exit(0);
          }
          writeFileSync(${JSON.stringify(join(testDir, "user-record.json"))}, JSON.stringify(args));
          process.stdout.write("1001\\n");
        `,
        async (fixturePath, testDir) => {
          const recordFile = join(testDir, "user-record.json");
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            guestUser: "sf-runner",
            testOnlyEmulator: true,
          });

          const result = await backend.execOperatorCommand("/usr/bin/id", ["-u"]);
          assert.strictEqual(result.exitCode, 0);

          const argv = JSON.parse(readFileSync(recordFile, "utf8"));
          assert.deepStrictEqual(argv, [
            "shell",
            "--user",
            "sf-runner",
            "worker-vm",
            "/usr/bin/env",
            "-i",
            "/usr/bin/id",
            "-u",
          ]);
        }
      );
    });

    it("execOperatorCommand handles commands that already use /usr/bin/env -i without duplicating", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { writeFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          if (args.includes('list')) {
            process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
            process.exit(0);
          }
          writeFileSync(${JSON.stringify(join(testDir, "env-record.json"))}, JSON.stringify(args));
        `,
        async (fixturePath, testDir) => {
          const recordFile = join(testDir, "env-record.json");
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          });

          await backend.execOperatorCommand("/usr/bin/env", ["-i", "FOO=BAR", "/bin/sh"]);

          const argv = JSON.parse(readFileSync(recordFile, "utf8"));
          assert.deepStrictEqual(argv, [
            "shell",
            "worker-vm",
            "/usr/bin/env",
            "-i",
            "FOO=BAR",
            "/bin/sh",
          ]);
        }
      );
    });

    it("execOperatorCommand validates probe and rejects missing instance without invoking secondary shell command", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          appendFileSync(${JSON.stringify(join(testDir, "invocations.log"))}, JSON.stringify(args) + '\\n');
          if (args.includes('list')) {
            process.stdout.write(JSON.stringify({ name: "other-vm", status: "Running" }) + '\\n');
          } else {
            process.stdout.write("secondary-shell-executed\\n");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          });

          await assert.rejects(
            async () => backend.execOperatorCommand("/usr/bin/uptime", []),
            /ERR_LIMA_INSTANCE_NOT_FOUND/
          );

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 1);
          assert.deepStrictEqual(lines[0], ["list", "--json"]);
        }
      );
    });

    it("execOperatorCommand validates probe and rejects corrupt listing without invoking secondary shell command", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          appendFileSync(${JSON.stringify(join(testDir, "invocations.log"))}, JSON.stringify(args) + '\\n');
          if (args.includes('list')) {
            process.stdout.write("corrupt json string\\n");
          } else {
            process.stdout.write("secondary-shell-executed\\n");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            testOnlyEmulator: true,
          });

          await assert.rejects(
            async () => backend.execOperatorCommand("/usr/bin/uptime", []),
            /ERR_LIMA_OUTPUT_UNRECOGNIZED/
          );

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 1);
          assert.deepStrictEqual(lines[0], ["list", "--json"]);
        }
      );
    });

    it("execOperatorCommand rejects non-absolute commands", async () => {
      const backend = new LimaVmBackend({
        binaryPath: "/bin/limactl",
        instanceName: "worker-vm",
        testOnlyEmulator: true,
      });

      await assert.rejects(
        async () => backend.execOperatorCommand("uptime", []),
        /ERR_VM_COMMAND_INVALID.*command must be an absolute Linux path/
      );
    });

    it("execOperatorCommand rejects commands with path traversal (..)", async () => {
      const backend = new LimaVmBackend({
        binaryPath: "/bin/limactl",
        instanceName: "worker-vm",
        testOnlyEmulator: true,
      });

      await assert.rejects(
        async () => backend.execOperatorCommand("/usr/bin/../../bin/sh", []),
        /ERR_VM_COMMAND_INVALID.*Path traversal \(..\) is strictly forbidden/
      );
    });

    it("execOperatorCommand rejects commands or arguments containing null bytes", async () => {
      const backend = new LimaVmBackend({
        binaryPath: "/bin/limactl",
        instanceName: "worker-vm",
        testOnlyEmulator: true,
      });

      await assert.rejects(
        async () => backend.execOperatorCommand("/usr/bin/cmd\0injection", []),
        /ERR_VM_COMMAND_INVALID.*command must be an absolute Linux path without null bytes/
      );

      await assert.rejects(
        async () => backend.execOperatorCommand("/usr/bin/cmd", ["arg\0null"]),
        /ERR_VM_COMMAND_INVALID.*must be a string without null bytes/
      );
    });

    it("execOperatorCommand returns non-zero exit codes cleanly in VmCommandResult", async () => {
      const script = `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args.includes('list')) {
          process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
          process.exit(0);
        }
        process.stderr.write("failed-diagnostic\\n");
        process.exit(42);
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new LimaVmBackend({
          binaryPath: fixturePath,
          instanceName: "worker-vm",
          testOnlyEmulator: true,
        });

        const result = await backend.execOperatorCommand("/bin/false", []);
        assert.strictEqual(result.exitCode, 42);
        assert.strictEqual(result.stderr, "failed-diagnostic\n");
      });
    });
  });

  // --------------------------------------------------------------------------
  // Group 6: Host & Guest Environment Boundary (Secrets & SSH_AUTH_SOCK)
  // --------------------------------------------------------------------------
  describe("Group 6: Host & Guest Environment Boundary (Secrets & SSH_AUTH_SOCK)", () => {
    it("host environment strictly excludes canary secrets, Factory credentials, and purges SSH_AUTH_SOCK", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { writeFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          if (args.includes('list')) {
            process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
            process.exit(0);
          }
          writeFileSync(${JSON.stringify(join(testDir, "env-secrets-record.json"))}, JSON.stringify(process.env));
        `,
        async (fixturePath, testDir) => {
          const recordFile = join(testDir, "env-secrets-record.json");

          // Inject toxic credentials and SSH agent forwarding credentials
          process.env.CANARY_MOCK_SECRET = "canary-mock-secret-val-123";
          process.env.OPENAI_API_KEY = "canary-mock-openai-key-abc";
          process.env.ANTHROPIC_API_KEY = "canary-mock-ant-key-xyz";
          process.env.SF_TOKEN = "canary-mock-sf-token-999";
          process.env.DATABASE_URL = "postgres://canary:pass@localhost:5432/db";
          process.env.SSH_AUTH_SOCK = "/private/tmp/com.apple.launchd.canary/Listeners";
          process.env.SSH_AGENT_PID = "12345";

          try {
            const backend = new LimaVmBackend({
              binaryPath: fixturePath,
              instanceName: "worker-vm",
              testOnlyEmulator: true,
            });

            await backend.execOperatorCommand("/usr/bin/id", []);

            const env = JSON.parse(readFileSync(recordFile, "utf8"));

            // All canary and sensitive credentials must be absent
            assert.strictEqual(env.CANARY_MOCK_SECRET, undefined);
            assert.strictEqual(env.OPENAI_API_KEY, undefined);
            assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
            assert.strictEqual(env.SF_TOKEN, undefined);
            assert.strictEqual(env.DATABASE_URL, undefined);

            // SSH agent forwarding must be purged
            assert.strictEqual(env.SSH_AUTH_SOCK, undefined);
            assert.strictEqual(env.SSH_AGENT_PID, undefined);

            // Safe environment variables present
            assert.ok(env.PATH !== undefined);
          } finally {
            delete process.env.CANARY_MOCK_SECRET;
            delete process.env.OPENAI_API_KEY;
            delete process.env.ANTHROPIC_API_KEY;
            delete process.env.SF_TOKEN;
            delete process.env.DATABASE_URL;
            delete process.env.SSH_AUTH_SOCK;
            delete process.env.SSH_AGENT_PID;
          }
        }
      );
    });

    it("host environment propagates configured limaHome to child process", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { writeFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          if (args.includes('list')) {
            process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
            process.exit(0);
          }
          writeFileSync(${JSON.stringify(join(testDir, "home-record.json"))}, JSON.stringify(process.env));
        `,
        async (fixturePath, testDir) => {
          const recordFile = join(testDir, "home-record.json");
          const customLimaHome = join(testDir, "custom-lima-home");

          const backend = new LimaVmBackend({
            binaryPath: fixturePath,
            instanceName: "worker-vm",
            limaHome: customLimaHome,
            testOnlyEmulator: true,
          });

          await backend.execOperatorCommand("/usr/bin/uptime", []);

          const env = JSON.parse(readFileSync(recordFile, "utf8"));
          assert.strictEqual(env.LIMA_HOME, customLimaHome);
          assert.strictEqual(env.LIMAHOME, customLimaHome);
        }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Group 7: Timeout, Abort, Output Caps & Uncertain Outcome Semantics
  // --------------------------------------------------------------------------
  describe("Group 7: Timeout, Abort, Output Caps & Uncertain Outcome Semantics", () => {
    it("command timeout terminates host transport and throws ERR_VM_COMMAND_TIMEOUT with uncertain outcome diagnostic", async () => {
      const script = `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args.includes('list')) {
          process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
          process.exit(0);
        }
        setInterval(() => {}, 1000);
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new LimaVmBackend({
          binaryPath: fixturePath,
          instanceName: "worker-vm",
          commandTimeoutMs: 150,
          testOnlyEmulator: true,
        });

        await assert.rejects(
          async () => backend.execOperatorCommand("/usr/bin/sleep", ["1000"]),
          (err: Error) => {
            assert.match(err.message, /^ERR_VM_COMMAND_TIMEOUT/);
            assert.match(err.message, /guest process state is uncertain/);
            assert.match(err.message, /host transport terminated/);
            return true;
          }
        );
      });
    });

    it("abort signal terminates host transport and throws ERR_VM_COMMAND_UNCERTAIN", async () => {
      const script = `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args.includes('list')) {
          process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
          process.exit(0);
        }
        setInterval(() => {}, 1000);
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new LimaVmBackend({
          binaryPath: fixturePath,
          instanceName: "worker-vm",
          commandTimeoutMs: 10_000,
          testOnlyEmulator: true,
        });

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);

        await assert.rejects(
          async () => backend.execOperatorCommand("/usr/bin/sleep", ["1000"], controller.signal),
          (err: Error) => {
            assert.match(err.message, /^ERR_VM_COMMAND_UNCERTAIN/);
            assert.match(err.message, /killing limactl does not guarantee guest process stopped/);
            return true;
          }
        );
      });
    });

    it("pre-aborted signal rejects immediately before spawn with ERR_VM_COMMAND_ABORTED", async () => {
      const backend = new LimaVmBackend({
        binaryPath: "/bin/limactl",
        instanceName: "worker-vm",
        testOnlyEmulator: true,
      });

      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () => backend.execOperatorCommand("/usr/bin/uptime", [], controller.signal),
        /ERR_VM_COMMAND_ABORTED.*Command aborted before execution/
      );
    });

    it("output exceeding maxOutputBytes during guest invocation reports ERR_VM_COMMAND_UNCERTAIN", async () => {
      const script = `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args.includes('list')) {
          process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
          process.exit(0);
        }
        const big = "X".repeat(2048);
        for (let i = 0; i < 100; i++) {
          process.stdout.write(big);
        }
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new LimaVmBackend({
          binaryPath: fixturePath,
          instanceName: "worker-vm",
          maxOutputBytes: 1024,
          testOnlyEmulator: true,
        });

        await assert.rejects(
          async () => backend.execOperatorCommand("/usr/bin/dump", []),
          /ERR_VM_COMMAND_UNCERTAIN.*Output exceeded maximum bounded limit of 1024 bytes.*guest process state is uncertain/
        );
      });
    });

    it("execOperatorCommand settles within bounded time when background descendant inherits and keeps pipe open", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { spawn } from 'node:child_process';
          import { writeFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          if (args.includes('list')) {
            process.stdout.write(JSON.stringify({ name: "worker-vm", status: "Running" }) + '\\n');
            process.exit(0);
          }
          // Spawn background descendant keeping stdout/stderr pipes open
          const bg = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: ['ignore', 'inherit', 'inherit'],
          });
          writeFileSync(${JSON.stringify(join(testDir, "bg.pid"))}, String(bg.pid));
          setTimeout(() => {}, 60000);
        `,
        async (fixturePath, testDir) => {
          const pidFile = join(testDir, "bg.pid");
          let bgPid: number | null = null;
          try {
            const backend = new LimaVmBackend({
              binaryPath: fixturePath,
              instanceName: "worker-vm",
              commandTimeoutMs: 200,
              testOnlyEmulator: true,
            });

            const startTime = Date.now();
            await assert.rejects(
              async () => backend.execOperatorCommand("/usr/bin/sleep", ["60"]),
              (err: Error) => {
                assert.match(err.message, /^ERR_VM_COMMAND_TIMEOUT/);
                assert.match(err.message, /guest process state is uncertain/);
                return true;
              }
            );
            const durationMs = Date.now() - startTime;
            assert.ok(durationMs < 2000, `Expected bounded settlement < 2000ms, took ${durationMs}ms`);
          } finally {
            try {
              if (existsSync(pidFile)) {
                bgPid = Number(readFileSync(pidFile, "utf8").trim());
                if (bgPid && !Number.isNaN(bgPid)) {
                  process.kill(bgPid, "SIGKILL");
                }
              }
            } catch {
              // ignore
            }
          }
        }
      );
    });

    it("spawn error throws ERR_VM_COMMAND_SPAWN_FAILED without leaking sensitive paths", async () => {
      const backend = new LimaVmBackend({
        binaryPath: "/nonexistent/path/to/limactl",
        instanceName: "worker-vm",
        testOnlyEmulator: true,
      });

      await assert.rejects(
        async () => backend.execOperatorCommand("/usr/bin/uptime", []),
        /ERR_VM_COMMAND_SPAWN_FAILED/
      );
    });
  });

  // --------------------------------------------------------------------------
  // Group 8: Error Sanitization Helper
  // --------------------------------------------------------------------------
  describe("Group 8: Error Sanitization Helper", () => {
    it("sanitizeErrorOutput redacts token, api key, and canary substrings", () => {
      const input = "Error with sk-mock-api-key-sample-value-12345 and ghp_sample_token_mock_123 and canary-mock-credential-val";
      const sanitized = sanitizeErrorOutput(input);
      assert.strictEqual(sanitized.includes("sk-mock-api-key-sample-value-12345"), false);
      assert.strictEqual(sanitized.includes("ghp_sample_token_mock_123"), false);
      assert.strictEqual(sanitized.includes("canary-mock-credential-val"), false);
      assert.ok(sanitized.includes("[REDACTED_API_KEY]"));
      assert.ok(sanitized.includes("[REDACTED_TOKEN]"));
      assert.ok(sanitized.includes("[REDACTED_CANARY]"));
    });
  });
});
