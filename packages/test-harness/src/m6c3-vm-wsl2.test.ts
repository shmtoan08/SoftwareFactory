/**
 * @file m6c3-vm-wsl2.test.ts
 * @description Unit and contract test suite for Wsl2VmBackend (Issue #16 / M6C-3 VM Foundation).
 *
 * Verifies:
 * - Production platform guard: requires win32 host platform; emulator mode requires explicit boolean testOnlyEmulator: true.
 * - Configuration validation: absolute binaryPath, distributionName, guestUser, strict boolean options,
 *   strictly bounded finite integer commandTimeoutMs (<= 120000) and maxOutputBytes (<= 1048576).
 * - Real WSL CLI output decoding: UTF-16LE with BOM (\uFEFF), UTF-16LE without BOM, UTF-8 with BOM, standard UTF-8.
 * - Strict distribution probing: validates exact distribution identity, strictly requires WSL version 2
 *   (rejecting "2junk", "2.5", "02", "v2", "1"), missing distros, ambiguous duplicates, and corrupt output without default fallback.
 * - Lifecycle operations: start/stop require both allowLifecycle=true and dedicatedInstance=true.
 *   Stop invokes targeted --terminate <Distro>; strictly forbids --shutdown (which terminates all distros globally).
 * - Diagnostic execution pre-probe: execOperatorCommand validates arguments, probes pinned distro/version 2
 *   before guest invocation, and halts without secondary execution if probe fails.
 * - Operator command execution: direct argv array execution, shell: false, clean guest env-i, host env minimal,
 *   excludes canary credentials, and clears WSLENV ("").
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
  Wsl2VmBackend,
  decodeWslOutput,
  parseWslListVerboseOutput,
  sanitizeErrorOutput,
} from "../../wna/src/vm-wsl2-backend.ts";

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
  const testDir = mkdtempSync(join(tmpdir(), "sf-vm-wsl2-test-"));
  const fixturePath = join(testDir, "fake-wsl.mjs");
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

describe("M6C-3 Step 5 — WSL2 VM Backend Foundation (Wsl2VmBackend)", () => {

  // --------------------------------------------------------------------------
  // Group 1: Production Platform Guard & Configuration Validation
  // --------------------------------------------------------------------------
  describe("Group 1: Production Platform Guard & Configuration Validation", () => {
    it("production guard rejects non-win32 platforms when testOnlyEmulator is false", () => {
      if (process.platform === "win32") {
        return; // Skip on actual Windows host
      }

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/usr/bin/wsl.exe",
            distributionName: "Ubuntu-22.04",
            testOnlyEmulator: false,
          }),
        (err: Error) => {
          assert.match(err.message, /^ERR_WSL_PLATFORM_UNSUPPORTED/);
          assert.match(err.message, /requires win32 host platform/);
          assert.match(err.message, /testOnlyEmulator: true/);
          return true;
        }
      );
    });

    it("constructor rejects non-boolean testOnlyEmulator via cast ('false', 'true', 1, 0, {})", () => {
      for (const invalid of ["false", "true", 1, 0, {}, []] as const) {
        assert.throws(
          () =>
            new Wsl2VmBackend({
              binaryPath: "/bin/wsl",
              distributionName: "Ubuntu-22.04",
              testOnlyEmulator: invalid as unknown as boolean,
            }),
          /ERR_WSL_CONFIG_INVALID.*testOnlyEmulator must be a boolean/
        );
      }
    });

    it("constructor rejects non-boolean allowLifecycle and dedicatedInstance via cast", () => {
      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            allowLifecycle: "true" as unknown as boolean,
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*allowLifecycle must be a boolean/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            dedicatedInstance: 1 as unknown as boolean,
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*dedicatedInstance must be a boolean/
      );
    });

    it("constructor rejects relative or empty binaryPath", () => {
      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "wsl.exe",
            distributionName: "Ubuntu-22.04",
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*binaryPath must be an absolute path/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "",
            distributionName: "Ubuntu-22.04",
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*binaryPath must be a non-empty string/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/path/to\0/wsl",
            distributionName: "Ubuntu-22.04",
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*binaryPath must not contain null bytes/
      );
    });

    it("constructor rejects invalid distributionName", () => {
      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "",
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*distributionName must be a non-empty string/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "--shutdown",
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*distributionName must not start with a hyphen/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "distro\0name",
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*distributionName must not contain null bytes/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "invalid;distro&name",
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*distributionName contains invalid characters/
      );
    });

    it("constructor rejects invalid guestUser", () => {
      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            guestUser: "-root",
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*guestUser must not start with a hyphen/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            guestUser: "user\0name",
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*guestUser must not contain null bytes/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            guestUser: "user with spaces",
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*guestUser contains invalid characters/
      );
    });

    it("constructor validates commandTimeoutMs bounds and integer type", () => {
      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            commandTimeoutMs: -100,
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*commandTimeoutMs must be an integer > 0/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            commandTimeoutMs: 100.5,
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*commandTimeoutMs must be an integer > 0/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            commandTimeoutMs: Number.NaN,
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*commandTimeoutMs must be an integer > 0/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            commandTimeoutMs: 200_000, // > 120_000 max
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*commandTimeoutMs must be an integer > 0 and <= 120000/
      );
    });

    it("constructor validates maxOutputBytes bounds and integer type", () => {
      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            maxOutputBytes: 0,
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*maxOutputBytes must be an integer > 0/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            maxOutputBytes: 1024.5,
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*maxOutputBytes must be an integer > 0/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            maxOutputBytes: Number.NaN,
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*maxOutputBytes must be an integer > 0/
      );

      assert.throws(
        () =>
          new Wsl2VmBackend({
            binaryPath: "/bin/wsl",
            distributionName: "Ubuntu-22.04",
            maxOutputBytes: 2 * 1024 * 1024, // > 1 MiB max
            testOnlyEmulator: true,
          }),
        /ERR_WSL_CONFIG_INVALID.*maxOutputBytes must be an integer > 0 and <= 1048576/
      );
    });

    it("constructor applies default lifecycle and bounding options", () => {
      const backend = new Wsl2VmBackend({
        binaryPath: "/bin/wsl",
        distributionName: "Ubuntu-22.04",
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
  // Group 2: Output Decoding (UTF-16LE, BOM, UTF-8)
  // --------------------------------------------------------------------------
  describe("Group 2: Output Decoding (UTF-16LE, BOM, UTF-8)", () => {
    it("decodeWslOutput decodes UTF-16LE with BOM (\\uFEFF)", () => {
      const text = "  NAME    STATE    VERSION\n* Ubuntu  Running  2\n";
      const bom = Buffer.from([0xff, 0xfe]);
      const body = Buffer.from(text, "utf16le");
      const raw = Buffer.concat([bom, body]);

      const decoded = decodeWslOutput(raw);
      assert.strictEqual(decoded, text);
    });

    it("decodeWslOutput decodes UTF-16LE without BOM (console pipe default)", () => {
      const text = "  NAME    STATE    VERSION\n* Ubuntu  Running  2\n";
      const raw = Buffer.from(text, "utf16le");

      const decoded = decodeWslOutput(raw);
      assert.strictEqual(decoded, text);
    });

    it("decodeWslOutput decodes UTF-8 with BOM", () => {
      const text = "  NAME    STATE    VERSION\n* Ubuntu  Running  2\n";
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const body = Buffer.from(text, "utf8");
      const raw = Buffer.concat([bom, body]);

      const decoded = decodeWslOutput(raw);
      assert.strictEqual(decoded, text);
    });

    it("decodeWslOutput decodes standard UTF-8", () => {
      const text = "  NAME    STATE    VERSION\n* Ubuntu  Running  2\n";
      const raw = Buffer.from(text, "utf8");

      const decoded = decodeWslOutput(raw);
      assert.strictEqual(decoded, text);
    });

    it("decodeWslOutput returns empty string for empty buffer", () => {
      assert.strictEqual(decodeWslOutput(Buffer.alloc(0)), "");
    });
  });

  // --------------------------------------------------------------------------
  // Group 3: Distribution Probing & Version 2 Contract (probe())
  // --------------------------------------------------------------------------
  describe("Group 3: Distribution Probing & Version 2 Contract (probe())", () => {
    it("probe succeeds with version 2 distribution from UTF-16LE BOM output", async () => {
      const table =
        "  NAME                   STATE           VERSION\r\n" +
        "* Ubuntu-22.04           Running         2\r\n" +
        "  docker-desktop-data    Running         2\r\n" +
        "  Debian                 Stopped         1\r\n";

      const script = `#!/usr/bin/env node
        import { writeFileSync } from 'node:fs';
        const bom = Buffer.from([0xff, 0xfe]);
        const body = Buffer.from(${JSON.stringify(table)}, 'utf16le');
        process.stdout.write(Buffer.concat([bom, body]));
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          testOnlyEmulator: true,
        });

        const probe = await backend.probe();
        assert.strictEqual(probe.backend, "wsl2");
        assert.strictEqual(probe.identity, "Ubuntu-22.04");
        assert.strictEqual(probe.present, true);
        assert.strictEqual(probe.wslVersion, 2);
        assert.strictEqual(probe.state, "Running");
      });
    });

    it("probe succeeds with version 2 distribution from UTF-8 output and stopped state", async () => {
      const table =
        "  NAME            STATE           VERSION\n" +
        "  Ubuntu-22.04    Stopped         2\n" +
        "* Debian          Running         1\n";

      const script = `#!/usr/bin/env node
        process.stdout.write(${JSON.stringify(table)});
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          testOnlyEmulator: true,
        });

        const probe = await backend.probe();
        assert.strictEqual(probe.identity, "Ubuntu-22.04");
        assert.strictEqual(probe.wslVersion, 2);
        assert.strictEqual(probe.state, "Stopped");
      });
    });

    it("probe succeeds when target distribution is not the default (* marks another distro)", async () => {
      const table =
        "  NAME                   STATE           VERSION\n" +
        "* Default-Distro         Running         2\n" +
        "  Target-Worker-Distro   Running         2\n";

      const script = `#!/usr/bin/env node
        process.stdout.write(${JSON.stringify(table)});
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Target-Worker-Distro",
          testOnlyEmulator: true,
        });

        const probe = await backend.probe();
        assert.strictEqual(probe.identity, "Target-Worker-Distro");
        assert.strictEqual(probe.wslVersion, 2);
      });
    });

    it("probe rejects distribution configured with WSL version 1 (fail-closed)", async () => {
      const table =
        "  NAME            STATE           VERSION\n" +
        "* Ubuntu-22.04    Stopped         1\n";

      const script = `#!/usr/bin/env node
        process.stdout.write(${JSON.stringify(table)});
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          testOnlyEmulator: true,
        });

        await assert.rejects(
          async () => backend.probe(),
          /ERR_WSL_VERSION_UNSUPPORTED.*strictly require version 2/
        );
      });
    });

    it("parseWslListVerboseOutput rejects '2junk' as malformed version", () => {
      const table =
        "  NAME            STATE           VERSION\n" +
        "* Ubuntu-22.04    Running         2junk\n";
      assert.throws(
        () => parseWslListVerboseOutput(table, "Ubuntu-22.04"),
        /ERR_WSL_VERSION_UNSUPPORTED.*unsupported or malformed WSL version "2junk"/
      );
    });

    it("parseWslListVerboseOutput rejects '2.5' as malformed version", () => {
      const table =
        "  NAME            STATE           VERSION\n" +
        "* Ubuntu-22.04    Running         2.5\n";
      assert.throws(
        () => parseWslListVerboseOutput(table, "Ubuntu-22.04"),
        /ERR_WSL_VERSION_UNSUPPORTED.*unsupported or malformed WSL version "2.5"/
      );
    });

    it("parseWslListVerboseOutput rejects '02' as malformed version", () => {
      const table =
        "  NAME            STATE           VERSION\n" +
        "* Ubuntu-22.04    Running         02\n";
      assert.throws(
        () => parseWslListVerboseOutput(table, "Ubuntu-22.04"),
        /ERR_WSL_VERSION_UNSUPPORTED.*unsupported or malformed WSL version "02"/
      );
    });

    it("parseWslListVerboseOutput rejects 'v2' as malformed version", () => {
      const table =
        "  NAME            STATE           VERSION\n" +
        "* Ubuntu-22.04    Running         v2\n";
      assert.throws(
        () => parseWslListVerboseOutput(table, "Ubuntu-22.04"),
        /ERR_WSL_VERSION_UNSUPPORTED.*unsupported or malformed WSL version "v2"/
      );
    });

    it("probe rejects missing distribution without falling back to default distro", async () => {
      const table =
        "  NAME            STATE           VERSION\n" +
        "* Ubuntu-22.04    Running         2\n" +
        "  Debian          Running         2\n";

      const script = `#!/usr/bin/env node
        process.stdout.write(${JSON.stringify(table)});
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Missing-Distro",
          testOnlyEmulator: true,
        });

        await assert.rejects(
          async () => backend.probe(),
          /ERR_WSL_DISTRO_NOT_FOUND.*was not found in WSL distributions/
        );
      });
    });

    it("probe rejects duplicate / ambiguous distribution entries", async () => {
      const table =
        "  NAME            STATE           VERSION\n" +
        "* Ubuntu-22.04    Running         2\n" +
        "  Ubuntu-22.04    Stopped         2\n";

      const script = `#!/usr/bin/env node
        process.stdout.write(${JSON.stringify(table)});
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          testOnlyEmulator: true,
        });

        await assert.rejects(
          async () => backend.probe(),
          /ERR_WSL_DISTRO_AMBIGUOUS.*Multiple entries found/
        );
      });
    });

    it("probe rejects unparseable output missing header", async () => {
      const table = "Ubuntu-22.04    Running    2\n";

      const script = `#!/usr/bin/env node
        process.stdout.write(${JSON.stringify(table)});
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          testOnlyEmulator: true,
        });

        await assert.rejects(
          async () => backend.probe(),
          /ERR_WSL_OUTPUT_UNRECOGNIZED.*Expected header line/
        );
      });
    });

    it("probe rejects unparseable output with corrupt data rows", async () => {
      const table =
        "  NAME            STATE           VERSION\n" +
        "  corrupt single token line\n";

      const script = `#!/usr/bin/env node
        process.stdout.write(${JSON.stringify(table)});
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          testOnlyEmulator: true,
        });

        await assert.rejects(
          async () => backend.probe(),
          /ERR_WSL_OUTPUT_UNRECOGNIZED.*Unable to parse line 2/
        );
      });
    });

    it("probe rejects completely empty output", async () => {
      const script = `#!/usr/bin/env node
        // Prints nothing
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          testOnlyEmulator: true,
        });

        await assert.rejects(
          async () => backend.probe(),
          /ERR_WSL_OUTPUT_UNRECOGNIZED.*completely empty/
        );
      });
    });

    it("probe handles localized headers and state descriptions", () => {
      const french =
        "  NOM             ÉTAT                    VERSION\n" +
        "* Ubuntu-22.04    En cours d'exécution   2\n";
      const result = parseWslListVerboseOutput(french, "Ubuntu-22.04");
      assert.strictEqual(result.identity, "Ubuntu-22.04");
      assert.strictEqual(result.wslVersion, 2);
      assert.strictEqual(result.state, "En cours d'exécution");
    });
  });

  // --------------------------------------------------------------------------
  // Group 4: Lifecycle Operations (start() and stop())
  // --------------------------------------------------------------------------
  describe("Group 4: Lifecycle Operations (start() and stop())", () => {
    it("lifecycle operations fail closed when allowLifecycle is false", async () => {
      const backend = new Wsl2VmBackend({
        binaryPath: "/bin/wsl",
        distributionName: "Ubuntu-22.04",
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
      const backend = new Wsl2VmBackend({
        binaryPath: "/bin/wsl",
        distributionName: "Ubuntu-22.04",
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

    it("start() probes and invokes targeted boot command for stopped distro", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          const logFile = ${JSON.stringify(join(testDir, "invocations.log"))};
          appendFileSync(logFile, JSON.stringify(args) + '\\n');

          if (args.includes('--list')) {
            process.stdout.write("  NAME            STATE           VERSION\\n  Ubuntu-22.04    Stopped         2\\n");
          } else {
            process.stdout.write("booted");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new Wsl2VmBackend({
            binaryPath: fixturePath,
            distributionName: "Ubuntu-22.04",
            allowLifecycle: true,
            dedicatedInstance: true,
            testOnlyEmulator: true,
          });

          await backend.start();

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 2);
          // First invocation: probe
          assert.deepStrictEqual(lines[0], ["--list", "--verbose"]);
          // Second invocation: non-interactive start
          assert.deepStrictEqual(lines[1], ["--distribution", "Ubuntu-22.04", "--exec", "/bin/true"]);
        }
      );
    });

    it("start() is a no-op if probe shows distro is already Running", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          const logFile = ${JSON.stringify(join(testDir, "invocations.log"))};
          appendFileSync(logFile, JSON.stringify(args) + '\\n');

          if (args.includes('--list')) {
            process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new Wsl2VmBackend({
            binaryPath: fixturePath,
            distributionName: "Ubuntu-22.04",
            allowLifecycle: true,
            dedicatedInstance: true,
            testOnlyEmulator: true,
          });

          await backend.start();

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 1);
          // Only probe ran, no secondary start command needed
          assert.deepStrictEqual(lines[0], ["--list", "--verbose"]);
        }
      );
    });

    it("stop() invokes targeted --terminate <distro> strictly, NEVER --shutdown", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          const logFile = ${JSON.stringify(join(testDir, "invocations.log"))};
          appendFileSync(logFile, JSON.stringify(args) + '\\n');

          if (args.includes('--list')) {
            process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new Wsl2VmBackend({
            binaryPath: fixturePath,
            distributionName: "Ubuntu-22.04",
            allowLifecycle: true,
            dedicatedInstance: true,
            testOnlyEmulator: true,
          });

          await backend.stop();

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 2);
          // 1. Probe
          assert.deepStrictEqual(lines[0], ["--list", "--verbose"]);
          // 2. Stop must be --terminate strictly for the configured distro
          assert.deepStrictEqual(lines[1], ["--terminate", "Ubuntu-22.04"]);

          // CRITICAL: Ensure --shutdown is never called anywhere
          const combinedArgs = lines.flat();
          assert.strictEqual(combinedArgs.includes("--shutdown"), false);
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
          import { writeFileSync, appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          if (args.includes('--list')) {
            process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
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
          const backend = new Wsl2VmBackend({
            binaryPath: fixturePath,
            distributionName: "Ubuntu-22.04",
            testOnlyEmulator: true,
          });

          const result = await backend.execOperatorCommand("/usr/bin/uptime", []);
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, "uptime-ok\n");
          assert.strictEqual(result.stderr, "");

          const record = readRecordedInvocation(recordFile);
          assert.deepStrictEqual(record.argv, [
            "--distribution",
            "Ubuntu-22.04",
            "--exec",
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
          if (args.includes('--list')) {
            process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
            process.exit(0);
          }
          writeFileSync(${JSON.stringify(join(testDir, "user-record.json"))}, JSON.stringify(args));
          process.stdout.write("1001\\n");
        `,
        async (fixturePath, testDir) => {
          const recordFile = join(testDir, "user-record.json");
          const backend = new Wsl2VmBackend({
            binaryPath: fixturePath,
            distributionName: "Ubuntu-22.04",
            guestUser: "sf-worker",
            testOnlyEmulator: true,
          });

          const result = await backend.execOperatorCommand("/usr/bin/id", ["-u"]);
          assert.strictEqual(result.exitCode, 0);

          const argv = JSON.parse(readFileSync(recordFile, "utf8"));
          assert.deepStrictEqual(argv, [
            "--distribution",
            "Ubuntu-22.04",
            "--user",
            "sf-worker",
            "--exec",
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
          if (args.includes('--list')) {
            process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
            process.exit(0);
          }
          writeFileSync(${JSON.stringify(join(testDir, "env-record.json"))}, JSON.stringify(args));
        `,
        async (fixturePath, testDir) => {
          const recordFile = join(testDir, "env-record.json");
          const backend = new Wsl2VmBackend({
            binaryPath: fixturePath,
            distributionName: "Ubuntu-22.04",
            testOnlyEmulator: true,
          });

          await backend.execOperatorCommand("/usr/bin/env", ["-i", "FOO=BAR", "/bin/sh"]);

          const argv = JSON.parse(readFileSync(recordFile, "utf8"));
          assert.deepStrictEqual(argv, [
            "--distribution",
            "Ubuntu-22.04",
            "--exec",
            "/usr/bin/env",
            "-i",
            "FOO=BAR",
            "/bin/sh",
          ]);
        }
      );
    });

    it("execOperatorCommand validates probe and rejects missing distro without invoking secondary exec command", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          appendFileSync(${JSON.stringify(join(testDir, "invocations.log"))}, JSON.stringify(args) + '\\n');
          if (args.includes('--list')) {
            // Missing Ubuntu-22.04
            process.stdout.write("  NAME            STATE           VERSION\\n* Debian          Running         2\\n");
          } else {
            process.stdout.write("secondary-command-ran\\n");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new Wsl2VmBackend({
            binaryPath: fixturePath,
            distributionName: "Ubuntu-22.04",
            testOnlyEmulator: true,
          });

          await assert.rejects(
            async () => backend.execOperatorCommand("/usr/bin/uptime", []),
            /ERR_WSL_DISTRO_NOT_FOUND/
          );

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 1);
          assert.deepStrictEqual(lines[0], ["--list", "--verbose"]);
        }
      );
    });

    it("execOperatorCommand validates probe and rejects WSL1 distro without invoking secondary exec command", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          appendFileSync(${JSON.stringify(join(testDir, "invocations.log"))}, JSON.stringify(args) + '\\n');
          if (args.includes('--list')) {
            process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         1\\n");
          } else {
            process.stdout.write("secondary-command-ran\\n");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new Wsl2VmBackend({
            binaryPath: fixturePath,
            distributionName: "Ubuntu-22.04",
            testOnlyEmulator: true,
          });

          await assert.rejects(
            async () => backend.execOperatorCommand("/usr/bin/uptime", []),
            /ERR_WSL_VERSION_UNSUPPORTED/
          );

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 1);
          assert.deepStrictEqual(lines[0], ["--list", "--verbose"]);
        }
      );
    });

    it("execOperatorCommand validates probe and rejects malformed output without invoking secondary exec command", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { appendFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          appendFileSync(${JSON.stringify(join(testDir, "invocations.log"))}, JSON.stringify(args) + '\\n');
          if (args.includes('--list')) {
            process.stdout.write("  NAME            STATE           VERSION\\n  corrupt data row\\n");
          } else {
            process.stdout.write("secondary-command-ran\\n");
          }
        `,
        async (fixturePath, testDir) => {
          const logFile = join(testDir, "invocations.log");
          const backend = new Wsl2VmBackend({
            binaryPath: fixturePath,
            distributionName: "Ubuntu-22.04",
            testOnlyEmulator: true,
          });

          await assert.rejects(
            async () => backend.execOperatorCommand("/usr/bin/uptime", []),
            /ERR_WSL_OUTPUT_UNRECOGNIZED/
          );

          const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          assert.strictEqual(lines.length, 1);
          assert.deepStrictEqual(lines[0], ["--list", "--verbose"]);
        }
      );
    });

    it("execOperatorCommand rejects non-absolute commands", async () => {
      const backend = new Wsl2VmBackend({
        binaryPath: "/bin/wsl",
        distributionName: "Ubuntu-22.04",
        testOnlyEmulator: true,
      });

      await assert.rejects(
        async () => backend.execOperatorCommand("uptime", []),
        /ERR_VM_COMMAND_INVALID.*command must be an absolute Linux path/
      );
    });

    it("execOperatorCommand rejects commands with path traversal (..)", async () => {
      const backend = new Wsl2VmBackend({
        binaryPath: "/bin/wsl",
        distributionName: "Ubuntu-22.04",
        testOnlyEmulator: true,
      });

      await assert.rejects(
        async () => backend.execOperatorCommand("/usr/bin/../../bin/sh", []),
        /ERR_VM_COMMAND_INVALID.*Path traversal \(..\) is strictly forbidden/
      );
    });

    it("execOperatorCommand rejects commands or arguments containing null bytes", async () => {
      const backend = new Wsl2VmBackend({
        binaryPath: "/bin/wsl",
        distributionName: "Ubuntu-22.04",
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
        if (args.includes('--list')) {
          process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
          process.exit(0);
        }
        process.stderr.write("failed-diagnostic\\n");
        process.exit(42);
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          testOnlyEmulator: true,
        });

        const result = await backend.execOperatorCommand("/bin/false", []);
        assert.strictEqual(result.exitCode, 42);
        assert.strictEqual(result.stderr, "failed-diagnostic\n");
      });
    });
  });

  // --------------------------------------------------------------------------
  // Group 6: Host & Guest Environment Boundary (Secrets & WSLENV)
  // --------------------------------------------------------------------------
  describe("Group 6: Host & Guest Environment Boundary (Secrets & WSLENV)", () => {
    it("host environment strictly excludes canary secrets, API keys, and purges WSLENV", async () => {
      await withTempFixture(
        (testDir) => `#!/usr/bin/env node
          import { writeFileSync } from 'node:fs';
          const args = process.argv.slice(2);
          if (args.includes('--list')) {
            process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
            process.exit(0);
          }
          writeFileSync(${JSON.stringify(join(testDir, "env-secrets-record.json"))}, JSON.stringify(process.env));
        `,
        async (fixturePath, testDir) => {
          const recordFile = join(testDir, "env-secrets-record.json");

          // Inject toxic / canary secrets into host environment before running
          process.env.CANARY_MOCK_SECRET = "canary-mock-secret-val-123";
          process.env.OPENAI_API_KEY = "canary-mock-openai-key-abc";
          process.env.ANTHROPIC_API_KEY = "canary-mock-ant-key-xyz";
          process.env.SF_TOKEN = "canary-mock-sf-token-999";
          process.env.DATABASE_URL = "postgres://canary:pass@localhost:5432/db";
          process.env.WSLENV = "PATH/l:USER/u:CUSTOM_HOST_VAR/p";

          try {
            const backend = new Wsl2VmBackend({
              binaryPath: fixturePath,
              distributionName: "Ubuntu-22.04",
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

            // WSLENV must be set strictly to "" so Windows does not translate any host env to WSL
            assert.strictEqual(env.WSLENV, "");

            // Standard host variables are present
            assert.ok(env.PATH !== undefined);
          } finally {
            delete process.env.CANARY_MOCK_SECRET;
            delete process.env.OPENAI_API_KEY;
            delete process.env.ANTHROPIC_API_KEY;
            delete process.env.SF_TOKEN;
            delete process.env.DATABASE_URL;
            delete process.env.WSLENV;
          }
        }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Group 7: Timeout, Abort, Output Caps & Uncertain Outcome Semantics
  // --------------------------------------------------------------------------
  describe("Group 7: Timeout, Abort, Output Caps & Uncertain Outcome Semantics", () => {
    it("command timeout terminates host transport and throws ERR_VM_COMMAND_TIMEOUT with uncertain outcome diagnostic", async () => {
      // Child script that hangs until killed
      const script = `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args.includes('--list')) {
          process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
          process.exit(0);
        }
        setInterval(() => {}, 1000);
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          commandTimeoutMs: 150, // Short timeout for test
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
        if (args.includes('--list')) {
          process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
          process.exit(0);
        }
        setInterval(() => {}, 1000);
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          commandTimeoutMs: 10_000,
          testOnlyEmulator: true,
        });

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);

        await assert.rejects(
          async () => backend.execOperatorCommand("/usr/bin/sleep", ["1000"], controller.signal),
          (err: Error) => {
            assert.match(err.message, /^ERR_VM_COMMAND_UNCERTAIN/);
            assert.match(err.message, /killing wsl.exe does not guarantee guest process stopped/);
            return true;
          }
        );
      });
    });

    it("pre-aborted signal rejects immediately before spawn with ERR_VM_COMMAND_ABORTED", async () => {
      const backend = new Wsl2VmBackend({
        binaryPath: "/bin/wsl",
        distributionName: "Ubuntu-22.04",
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
        if (args.includes('--list')) {
          process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
          process.exit(0);
        }
        // Generate a large payload exceeding maxOutputBytes
        const big = "X".repeat(2048);
        for (let i = 0; i < 100; i++) {
          process.stdout.write(big);
        }
      `;

      await withTempFixture(script, async (fixturePath) => {
        const backend = new Wsl2VmBackend({
          binaryPath: fixturePath,
          distributionName: "Ubuntu-22.04",
          maxOutputBytes: 1024, // 1 KiB cap
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
          if (args.includes('--list')) {
            process.stdout.write("  NAME            STATE           VERSION\\n* Ubuntu-22.04    Running         2\\n");
            process.exit(0);
          }
          // In exec: spawn a background descendant that inherits stdout/stderr
          const bg = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: ['ignore', 'inherit', 'inherit'],
          });
          writeFileSync(${JSON.stringify(join(testDir, "bg.pid"))}, String(bg.pid));
          // Direct child sleeps indefinitely
          setTimeout(() => {}, 60000);
        `,
        async (fixturePath, testDir) => {
          const pidFile = join(testDir, "bg.pid");
          let bgPid: number | null = null;
          try {
            const backend = new Wsl2VmBackend({
              binaryPath: fixturePath,
              distributionName: "Ubuntu-22.04",
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
            // Must settle bounded (< 2000ms), proving it did NOT hang waiting for descendant pipe close
            assert.ok(durationMs < 2000, `Expected bounded settlement < 2000ms, took ${durationMs}ms`);
          } finally {
            // Watchdog & cleanup: kill background descendant process if created
            try {
              if (existsSync(pidFile)) {
                bgPid = Number(readFileSync(pidFile, "utf8").trim());
                if (bgPid && !Number.isNaN(bgPid)) {
                  process.kill(bgPid, "SIGKILL");
                }
              }
            } catch {
              // ignore process kill error if already exited
            }
          }
        }
      );
    });

    it("spawn error throws ERR_VM_COMMAND_SPAWN_FAILED without leaking sensitive paths", async () => {
      const backend = new Wsl2VmBackend({
        binaryPath: "/nonexistent/path/to/wsl.exe",
        distributionName: "Ubuntu-22.04",
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
