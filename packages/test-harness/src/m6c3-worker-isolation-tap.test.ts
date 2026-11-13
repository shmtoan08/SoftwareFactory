import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VALIDATOR_SCRIPT = resolve(process.cwd(), "scripts/ci/worker-isolation-tap-summary.sh");
const REQUIRED_PREFIX = "Strict acceptance requires an executed TAP summary";

interface RunValidatorResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runValidator(args: readonly string[]): RunValidatorResult {
  const result = spawnSync("bash", [VALIDATOR_SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function withTempLog(content: string, fn: (logPath: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), "sf-tap-test-"));
  const logPath = join(tempDir, "tap.log");
  try {
    writeFileSync(logPath, content, "utf8");
    fn(logPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("M6C-3 Step 5 — Strict TAP Summary Validator (worker-isolation-tap-summary.sh)", () => {
  describe("CLI Argument Handling (Exit 2)", () => {
    it("fails with exit 2 when no arguments are passed", () => {
      const res = runValidator([]);
      assert.equal(res.status, 2);
      assert.ok(res.stderr.includes("Usage:"), `Expected usage in stderr, got: ${res.stderr}`);
    });

    it("fails with exit 2 when multiple arguments are passed", () => {
      const res = runValidator(["path1", "path2"]);
      assert.equal(res.status, 2);
      assert.ok(res.stderr.includes("Usage:"), `Expected usage in stderr, got: ${res.stderr}`);
    });

    it("fails with exit 2 when option flag is passed", () => {
      const res = runValidator(["--help"]);
      assert.equal(res.status, 2);
      assert.ok(res.stderr.includes("Usage:"), `Expected usage in stderr, got: ${res.stderr}`);
    });

    it("fails with exit 2 when empty argument is passed", () => {
      const res = runValidator([""]);
      assert.equal(res.status, 2);
      assert.ok(res.stderr.includes("Usage:"), `Expected usage in stderr, got: ${res.stderr}`);
    });
  });

  describe("File Access & Read Errors (Exit 1)", () => {
    it("fails with exit 1 and required prefix when log file does not exist", () => {
      const nonExistent = join(tmpdir(), `sf-nonexistent-${Date.now()}.log`);
      const res = runValidator([nonExistent]);
      assert.equal(res.status, 1);
      assert.ok(res.stderr.startsWith(REQUIRED_PREFIX), `Stderr must start with '${REQUIRED_PREFIX}', got: ${res.stderr}`);
    });

    it("fails with exit 1 and required prefix when log path is a directory", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "sf-tap-dir-"));
      try {
        const res = runValidator([tempDir]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX), `Stderr must start with '${REQUIRED_PREFIX}', got: ${res.stderr}`);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails with exit 1 and required prefix when log file is completely empty", () => {
      withTempLog("", (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX), `Stderr must start with '${REQUIRED_PREFIX}', got: ${res.stderr}`);
        assert.ok(res.stderr.includes("missing"), `Expected missing counter message, got: ${res.stderr}`);
      });
    });
  });

  describe("Valid TAP Output Validation (Exit 0)", () => {
    it("passes with exit 0 on a clean TAP summary with tests == pass and zero skips/failures", () => {
      const validTap = [
        "TAP version 13",
        "# Subtest: Suite A",
        "    ok 1 - test 1",
        "    ok 2 - test 2",
        "    1..2",
        "ok 1 - Suite A",
        "1..1",
        "# tests 2",
        "# suites 1",
        "# pass 2",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
        "# duration_ms 42.123",
      ].join("\n");

      withTempLog(validTap, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 0, `Expected exit 0, got ${res.status} (stderr: ${res.stderr})`);
        assert.equal(res.stderr, "");
      });
    });

    it("ignores indented subtest counters and only validates root-level summary", () => {
      const tapWithSubtestCounters = [
        "TAP version 13",
        "# Subtest: Suite A",
        "    # tests 5",
        "    # pass 3",
        "    # skipped 2",
        "    ok 1 - subtest",
        "    1..1",
        "ok 1 - Suite A",
        "# tests 15",
        "# pass 15",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapWithSubtestCounters, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 0, `Expected exit 0, got ${res.status} (stderr: ${res.stderr})`);
        assert.equal(res.stderr, "");
      });
    });

    it("accepts summary regardless of field ordering among root counters", () => {
      const reorderedTap = [
        "# todo 0",
        "# pass 25",
        "# skipped 0",
        "# fail 0",
        "# cancelled 0",
        "# tests 25",
      ].join("\n");

      withTempLog(reorderedTap, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 0, `Expected exit 0, got ${res.status} (stderr: ${res.stderr})`);
      });
    });
  });

  describe("Incomplete or Missing Counters (Exit 1)", () => {
    it("fails with exit 1 when '# pass' counter is missing", () => {
      const tapMissingPass = [
        "# tests 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapMissingPass, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("# pass"));
      });
    });

    it("fails with exit 1 when '# tests' counter is missing", () => {
      const tapMissingTests = [
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapMissingTests, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("# tests"));
      });
    });

    it("fails with exit 1 when '# fail' counter is missing", () => {
      const tapMissingFail = [
        "# tests 10",
        "# pass 10",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapMissingFail, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("# fail"));
      });
    });

    it("fails with exit 1 when '# cancelled' counter is missing", () => {
      const tapMissingCancelled = [
        "# tests 10",
        "# pass 10",
        "# fail 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapMissingCancelled, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("# cancelled"));
      });
    });

    it("fails with exit 1 when '# skipped' counter is missing", () => {
      const tapMissingSkipped = [
        "# tests 10",
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapMissingSkipped, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("# skipped"));
      });
    });

    it("fails with exit 1 when '# todo' counter is missing", () => {
      const tapMissingTodo = [
        "# tests 10",
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
      ].join("\n");

      withTempLog(tapMissingTodo, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("# todo"));
      });
    });
  });

  describe("Duplicate Counters (Exit 1)", () => {
    it("fails with exit 1 when duplicate root '# tests' counters are present", () => {
      const tapDupTests = [
        "# tests 10",
        "# tests 10",
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapDupTests, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("duplicate"));
      });
    });

    it("fails with exit 1 when duplicate root '# pass' counters are present", () => {
      const tapDupPass = [
        "# tests 10",
        "# pass 10",
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapDupPass, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("duplicate"));
      });
    });
  });

  describe("Inconsistent Totals & Non-Zero Failures (Exit 1)", () => {
    it("fails with exit 1 when pass count is strictly less than tests count", () => {
      const tapPassLessThanTests = [
        "# tests 10",
        "# pass 9",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapPassLessThanTests, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("does not match tests count"));
      });
    });

    it("fails with exit 1 when pass count is greater than tests count", () => {
      const tapPassGreaterThanTests = [
        "# tests 10",
        "# pass 12",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapPassGreaterThanTests, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("does not match tests count"));
      });
    });

    it("fails with exit 1 when tests count is zero", () => {
      const tapZeroTests = [
        "# tests 0",
        "# pass 0",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapZeroTests, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("must be > 0"));
      });
    });

    it("fails with exit 1 when skipped count is non-zero", () => {
      const tapSkipped = [
        "# tests 10",
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 2",
        "# todo 0",
      ].join("\n");

      withTempLog(tapSkipped, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("skipped count must be 0"));
      });
    });

    it("fails with exit 1 when fail count is non-zero", () => {
      const tapFail = [
        "# tests 10",
        "# pass 10",
        "# fail 1",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapFail, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("fail count must be 0"));
      });
    });

    it("fails with exit 1 when cancelled count is non-zero", () => {
      const tapCancelled = [
        "# tests 10",
        "# pass 10",
        "# fail 0",
        "# cancelled 1",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapCancelled, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("cancelled count must be 0"));
      });
    });

    it("fails with exit 1 when todo count is non-zero", () => {
      const tapTodo = [
        "# tests 10",
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 1",
      ].join("\n");

      withTempLog(tapTodo, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("todo count must be 0"));
      });
    });
  });

  describe("Malformed Counter Lines (Exit 1)", () => {
    it("fails with exit 1 on negative counter values", () => {
      const tapNegative = [
        "# tests -1",
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapNegative, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("malformed"));
      });
    });

    it("fails with exit 1 on non-integer counter values", () => {
      const tapNonInt = [
        "# tests ten",
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapNonInt, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("malformed"));
      });
    });

    it("fails with exit 1 on missing counter value", () => {
      const tapMissingVal = [
        "# tests",
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapMissingVal, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("malformed"));
      });
    });

    it("fails with exit 1 on trailing tokens after integer value", () => {
      const tapTrailing = [
        "# tests 10 unexpected_token",
        "# pass 10",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
      ].join("\n");

      withTempLog(tapTrailing, (logPath) => {
        const res = runValidator([logPath]);
        assert.equal(res.status, 1);
        assert.ok(res.stderr.startsWith(REQUIRED_PREFIX));
        assert.ok(res.stderr.includes("malformed"));
      });
    });
  });
});


describe("TAP decimal counter precision", () => {
  const summary = (tests: string, passed: string) => `# tests ${tests}\n# pass ${passed}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  it("rejects unequal decimal counts that round to the same awk floating-point number", () => {
    withTempLog(summary("9007199254740992", "9007199254740993"), (path) => {
      const result = runValidator([path]);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.startsWith(REQUIRED_PREFIX));
      assert.ok(result.stderr.includes("does not match"));
    });
  });
  it("accepts exactly equal decimal counts beyond floating-point precision", () => {
    withTempLog(summary("9007199254740993", "9007199254740993"), (path) => assert.equal(runValidator([path]).status, 0));
  });
  it("compares leading-zero decimal counters canonically", () => {
    withTempLog(summary("0002", "2"), (path) => assert.equal(runValidator([path]).status, 0));
  });
});
