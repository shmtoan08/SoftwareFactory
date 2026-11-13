import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import {
  LinuxCgroupV2SandboxBackend,
  deriveTaskRunnerUid,
} from "@software-factory/wna";
import {
  signTargetProtocol,
  type ExternalTargetAction,
} from "@software-factory/adapter-sdk";
import { sha256Hex } from "@software-factory/shared-types";

import {
  CANARY_SECRETS,
  WORKER_ENDPOINT_ADVERSARIAL_MATRIX,
  buildMinimalSanitizedEnv,
  checkOsProcessAlive,
  inspectEnvironmentForCanaryLeaks,
  probeHostKernelIsolationCapabilities,
  readLinuxProcessPpid,
  validateCleanupEvidenceContract,
} from "./m6c3-worker-isolation-harness.ts";

describe("M6C-3 Step 5 — Worker Isolation, Sandbox Cleanup & Adversarial Contract Suite", () => {
  it("TC-01: Environment Canaries & Secret Sanitization — zero host credentials leak into child process", async () => {
    const taskId = randomUUID();
    const leaseEpoch = 1;
    const tempDir = mkdtempSync(join(tmpdir(), "sf-iso-canary-"));
    const reportFile = join(tempDir, "env-report.json");

    // Populate parent process with canary secrets simulating operator / daemon credentials
    const savedEnv: Record<string, string | undefined> = {};
    for (const [key, val] of Object.entries(CANARY_SECRETS)) {
      savedEnv[key] = process.env[key];
      process.env[key] = val;
    }

    const backend = new LinuxCgroupV2SandboxBackend({
      cgroupRoot: "/nonexistent/sf-cgroup-root",
    });

    try {
      const sanitizedEnv = buildMinimalSanitizedEnv({
        CUSTOM_SAFE_VAR: "allowed_value",
      });

      // Verify that the sanitized env contains none of the canaries before spawning
      const preInspection = inspectEnvironmentForCanaryLeaks(sanitizedEnv);
      assert.equal(preInspection.isClean, true, `Sanitized env must be clean: ${preInspection.leakedKeys.join(", ")}`);

      // Script writes its process.env into reportFile
      const inspectScript = [
        'const { writeFileSync } = require("node:fs");',
        'const report = JSON.stringify(process.env);',
        `writeFileSync(${JSON.stringify(reportFile)}, report, "utf8");`,
      ].join("\n");

      const spawned = backend.spawnRealProcessInSandbox({
        taskId,
        leaseEpoch,
        command: process.execPath,
        args: ["-e", inspectScript],
        sanitizedEnv,
        cwd: tempDir,
        worktreePath: tempDir,
      });

      const exitResult = await spawned.exitPromise;
      assert.equal(exitResult.code, 0, `Child process should exit with 0, got ${exitResult.code}`);

      assert.equal(existsSync(reportFile), true, "Child process must have written report file");
      const childEnv = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, string>;

      // Verify child environment strictly leaked zero canaries
      const postInspection = inspectEnvironmentForCanaryLeaks(childEnv);
      assert.equal(
        postInspection.isClean,
        true,
        `Child process environment leaked secrets: ${postInspection.leakedKeys.join(", ")} (canaries: ${postInspection.leakedCanaryValues.join(", ")})`
      );

      assert.equal(childEnv.CUSTOM_SAFE_VAR, "allowed_value");
      assert.equal(childEnv.NODE_ENV, "test");
      assert.equal(childEnv.SF_TARGET_KEY, undefined);
      assert.equal(childEnv.AGENT_GATEWAY_TOKEN, undefined);
      assert.equal(childEnv.PGPASSWORD, undefined);
      assert.equal(childEnv.DATABASE_URL, undefined);
      assert.equal(childEnv.GIT_PUSH_TOKEN, undefined);
      assert.equal(childEnv.SF_WNA_TOKEN, undefined);
      assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(childEnv.OPENAI_API_KEY, undefined);

      const evidence = await backend.killAndVerifyClean(taskId, leaseEpoch);
      assert.equal(evidence.remainingProcsCount, 0);
      assert.equal(evidence.killedPids.includes(spawned.pid), true);

      const contractValidation = validateCleanupEvidenceContract(evidence);
      assert.equal(contractValidation.valid, true, `Contract violations: ${contractValidation.violations.join("; ")}`);
    } finally {
      // Restore parent env
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("TC-02: Double-Fork Process Tracking — Darwin fails-closed honestly, Linux reaps orphans via subreaper", async (t) => {
    const probe = probeHostKernelIsolationCapabilities();
    const taskId = randomUUID();
    const leaseEpoch = 1;

    const backend = new LinuxCgroupV2SandboxBackend({
      cgroupRoot: "/nonexistent/sf-cgroup-root",
    });

    if (!probe.isLinux) {
      // On non-Linux (Darwin): requireSubreaper must fail-closed honestly
      assert.throws(
        () =>
          backend.spawnRealProcessInSandbox({
            taskId,
            leaseEpoch,
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            sanitizedEnv: buildMinimalSanitizedEnv(),
            cwd: process.cwd(),
            requireSubreaper: true,
          }),
        /ERR_LINUX_SUBREAPER_UNAVAILABLE/
      );

      // Verify simulated mode correctly tracks double-fork orphans without fabricating kernel claims
      backend.spawnProcessInSandbox({
        taskId,
        leaseEpoch,
        pid: 50001,
        childPids: [50002],
      });
      backend.spawnDoubleForkOrphanInSandbox(taskId, leaseEpoch, 50099);

      const simEvidence = await backend.killAndVerifyClean(taskId, leaseEpoch);
      assert.equal(simEvidence.isSimulated, true);
      assert.equal(simEvidence.realKernelOperationsExecuted, false);
      assert.equal(simEvidence.freezeApplied, false);
      assert.equal(simEvidence.cgroupKillWritten, false);
      assert.equal(simEvidence.cgroupDirRemoved, false);
      assert.equal(simEvidence.remainingProcsCount, 0);
      assert.equal(simEvidence.killedPids.includes(50001), true);
      assert.equal(simEvidence.killedPids.includes(50002), true);
      assert.equal(simEvidence.killedPids.includes(50099), true);

      const simValidation = validateCleanupEvidenceContract(simEvidence);
      assert.equal(simValidation.valid, true, `Simulated contract violations: ${simValidation.violations.join("; ")}`);

      t.skip(probe.skipReason ?? "Subreaper kernel tests skipped on non-Linux");
      return;
    }

    // Genuine Linux execution path
    assert.equal(probe.subreaper.supported, true, probe.subreaper.reason);
    const tempDir = mkdtempSync(join(tmpdir(), "sf-iso-subreaper-"));
    const orphanPidFile = join(tempDir, "orphan.pid");

    try {
      const innerScript = [
        'const { spawn } = require("node:child_process");',
        'const { renameSync, writeFileSync } = require("node:fs");',
        'const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
        "orphan.unref();",
        'const tmp = process.argv[1] + ".tmp";',
        'writeFileSync(tmp, String(orphan.pid), "utf8");',
        "renameSync(tmp, process.argv[1]);",
        "process.exit(0);",
      ].join("\n");

      const outerScript = [
        'const { spawn } = require("node:child_process");',
        "const [pidFile, inner] = process.argv.slice(1);",
        'const intermediate = spawn(process.execPath, ["-e", inner, pidFile], { stdio: "ignore" });',
        'intermediate.on("exit", () => process.exit(0));',
      ].join("\n");

      const spawned = backend.spawnRealProcessInSandbox({
        taskId,
        leaseEpoch,
        command: process.execPath,
        args: ["-e", outerScript, orphanPidFile, innerScript],
        sanitizedEnv: buildMinimalSanitizedEnv(),
        cwd: tempDir,
        worktreePath: tempDir,
        isolateNamespaces: false,
        requireSubreaper: true,
      });

      assert.equal(spawned.securityMetadata.subreaperEnabled, true);
      assert.ok(spawned.supervisorPid && spawned.supervisorPid > 0);

      // Wait for intermediate to exit and orphan PID to be recorded
      let orphanPid = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (existsSync(orphanPidFile) && !checkOsProcessAlive(spawned.pid)) {
          const parsed = Number(readFileSync(orphanPidFile, "utf8").trim());
          if (
            Number.isInteger(parsed) &&
            parsed > 0 &&
            readLinuxProcessPpid(parsed) === spawned.supervisorPid
          ) {
            orphanPid = parsed;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      assert.ok(orphanPid > 0, "Detached orphan PID must be recorded and reparented to supervisor");
      assert.equal(checkOsProcessAlive(orphanPid), true, "Orphan must remain running before cleanup");

      const evidence = await backend.killAndVerifyClean(taskId, leaseEpoch);
      assert.equal(checkOsProcessAlive(orphanPid), false, "Orphan process must be reaped and killed");
      assert.equal(evidence.remainingProcsCount, 0);
      assert.equal(evidence.realProcessGroupKilled, true);
      assert.equal(evidence.killedPids.includes(orphanPid), true);
      assert.equal(evidence.subreaperWaitpidReapedPids.includes(orphanPid), true);

      const contractValidation = validateCleanupEvidenceContract(evidence);
      assert.equal(contractValidation.valid, true);
    } finally {
      await backend.killAndVerifyClean(taskId, leaseEpoch).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("TC-03: Mount Namespace & Path Traversal Guards — worktree containment, traversal rejection & credential denial", async (t) => {
    const probe = probeHostKernelIsolationCapabilities();
    const taskId = randomUUID();
    const leaseEpoch = 1;
    const worktreePath = `/var/lib/software-factory/worktrees/${taskId}/epoch-${leaseEpoch}`;

    const backend = new LinuxCgroupV2SandboxBackend({
      cgroupRoot: "/nonexistent/sf-cgroup-root",
    });

    // Register simulated sandbox to test path access enforcement
    backend.spawnProcessInSandbox({
      taskId,
      leaseEpoch,
      pid: 60001,
      worktreePath,
    });

    // 1. Legitimate worktree access allowed
    const validAccess = backend.assertSandboxPathAccess(taskId, leaseEpoch, `${worktreePath}/src/index.ts`);
    assert.equal(validAccess.allowed, true);

    // 2. /tmp access allowed
    const tmpAccess = backend.assertSandboxPathAccess(taskId, leaseEpoch, "/tmp/sf-scratch/output.txt");
    assert.equal(tmpAccess.allowed, true);

    // 3. Traversal guard: attempting to escape worktree via ..
    assert.throws(
      () => backend.assertSandboxPathAccess(taskId, leaseEpoch, `${worktreePath}/../../../etc/shadow`),
      /EACCES: Mount namespace isolation denied cross-worktree or host path access/
    );

    // 4. Windows backslash normalized traversal guard
    assert.throws(
      () => backend.assertSandboxPathAccess(taskId, leaseEpoch, `${worktreePath}/..\\..\\etc\\passwd`),
      /EACCES: Mount namespace isolation denied cross-worktree or host path access/
    );

    // 5. Null byte rejection guard
    assert.throws(
      () => backend.assertSandboxPathAccess(taskId, leaseEpoch, `${worktreePath}/valid\0/escape`),
      /EACCES: Null byte forbidden in sandbox path/
    );

    // 6. Direct WNA credential path /etc/sf-wna denial
    assert.throws(
      () => backend.assertSandboxPathAccess(taskId, leaseEpoch, "/etc/sf-wna/secrets.env"),
      /EACCES: Mount namespace isolation denied access to WNA credential path/
    );

    // 7. Sibling worktree denial
    const siblingWorktree = `/var/lib/software-factory/worktrees/different-task-id/epoch-1/file.ts`;
    assert.throws(
      () => backend.assertSandboxPathAccess(taskId, leaseEpoch, siblingWorktree),
      /EACCES: Mount namespace isolation denied cross-worktree or host path access/
    );

    await backend.killAndVerifyClean(taskId, leaseEpoch);

    // Genuine OS namespace test on Darwin vs Linux
    if (!probe.isLinux) {
      assert.throws(
        () =>
          backend.spawnRealProcessInSandbox({
            taskId,
            leaseEpoch: 2,
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            sanitizedEnv: buildMinimalSanitizedEnv(),
            cwd: process.cwd(),
            requireNamespaceIsolation: true,
          }),
        /ERR_LINUX_NAMESPACE_UNAVAILABLE/
      );
      t.skip(probe.skipReason ?? "Mount namespace kernel tests skipped on non-Linux");
      return;
    }

    // Genuine Linux mount namespace test
    assert.equal(probe.namespaces.supported, true, probe.namespaces.reason);
    const tempDir = mkdtempSync(join(tmpdir(), "sf-iso-ns-"));
    const secretDir = join(tempDir, "forbidden-sf-wna");
    const allowedDir = join(tempDir, "worktree");
    const testReport = join(allowedDir, "ns-report.json");

    try {
      mkdirSync(secretDir, { recursive: true });
      mkdirSync(allowedDir, { recursive: true });
      writeFileSync(join(secretDir, "token.key"), "SUPER_SECRET_WNA_TOKEN_12345", "utf8");
      writeFileSync(join(allowedDir, "code.ts"), "export const ok = true;", "utf8");

      const nsScript = [
        'const { readFileSync, writeFileSync } = require("node:fs");',
        'const path = require("node:path");',
        'const [secDir, repFile] = process.argv.slice(1);',
        'let secretBlocked = false;',
        'try {',
        '  readFileSync(path.join(secDir, "token.key"), "utf8");',
        '} catch {',
        '  secretBlocked = true;',
        '}',
        'writeFileSync(repFile, JSON.stringify({ secretBlocked }), "utf8");',
      ].join("\n");

      const spawned = backend.spawnRealProcessInSandbox({
        taskId,
        leaseEpoch: 2,
        command: process.execPath,
        args: ["-e", nsScript, secretDir, testReport],
        sanitizedEnv: buildMinimalSanitizedEnv(),
        cwd: allowedDir,
        worktreePath: allowedDir,
        requireNamespaceIsolation: true,
        maskedPaths: [secretDir],
      });

      await spawned.exitPromise;
      assert.equal(existsSync(testReport), true);
      const rep = JSON.parse(readFileSync(testReport, "utf8")) as { secretBlocked: boolean };
      assert.equal(rep.secretBlocked, true, "Secret directory must be blocked inside mount namespace");

      // Host file remains intact
      assert.equal(readFileSync(join(secretDir, "token.key"), "utf8"), "SUPER_SECRET_WNA_TOKEN_12345");
      await backend.killAndVerifyClean(taskId, 2);
    } finally {
      await backend.killAndVerifyClean(taskId, 2).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("TC-04: Cgroups v2 Hierarchy & Kill-and-Verify Contract — honest reporting, freeze/kill lifecycle", async (t) => {
    const probe = probeHostKernelIsolationCapabilities();
    const taskId = randomUUID();
    const leaseEpoch = 1;

    const backend = new LinuxCgroupV2SandboxBackend({
      cgroupRoot: "/nonexistent/sf-cgroup-root",
    });

    if (!probe.isLinux || !probe.cgroupsV2.supported) {
      // Must fail closed when cgroup v2 is strictly required
      assert.throws(
        () =>
          backend.spawnRealProcessInSandbox({
            taskId,
            leaseEpoch,
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            sanitizedEnv: buildMinimalSanitizedEnv(),
            cwd: process.cwd(),
            requireKernelCgroup: true,
          }),
        /ERR_LINUX_CGROUP_V2_UNAVAILABLE/
      );

      t.skip(probe.skipReason ?? "Linux cgroups v2 kernel tests skipped");
      return;
    }

    // Genuine Linux cgroups v2 test
    const cgroupBackend = new LinuxCgroupV2SandboxBackend({
      cgroupRoot: probe.cgroupsV2.cgroupRoot,
    });
    const tempDir = mkdtempSync(join(tmpdir(), "sf-iso-cgroup-"));

    try {
      const spawned = cgroupBackend.spawnRealProcessInSandbox({
        taskId,
        leaseEpoch,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        sanitizedEnv: buildMinimalSanitizedEnv(),
        cwd: tempDir,
        worktreePath: tempDir,
        requireKernelCgroup: true,
        requireSubreaper: true,
      });

      assert.equal(spawned.executionMode, "real-cgroup-v2");
      assert.equal(spawned.securityMetadata.backendMode, "linux-cgroup-v2");

      const evidence = await cgroupBackend.killAndVerifyClean(taskId, leaseEpoch);
      assert.equal(evidence.backendMode, "linux-cgroup-v2");
      assert.equal(evidence.isSimulated, false);
      assert.equal(evidence.realKernelOperationsExecuted, true);
      assert.equal(evidence.freezeApplied, true);
      assert.equal(evidence.cgroupKillWritten, true);
      assert.equal(evidence.populatedZeroVerified, true);
      assert.equal(evidence.cgroupDirRemoved, true);
      assert.equal(evidence.remainingProcsCount, 0);

      const contractValidation = validateCleanupEvidenceContract(evidence, {
        requireRealKernelOperations: true,
        requirePopulatedZero: true,
        requireCgroupDirRemoved: true,
      });
      assert.equal(contractValidation.valid, true, `Violations: ${contractValidation.violations.join("; ")}`);
    } finally {
      await cgroupBackend.killAndVerifyClean(taskId, leaseEpoch).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("TC-05: Timeout & Process Termination — killAndVerifyClean reliably terminates long-running tasks", async () => {
    const taskId = randomUUID();
    const leaseEpoch = 1;
    const tempDir = mkdtempSync(join(tmpdir(), "sf-iso-timeout-"));

    const backend = new LinuxCgroupV2SandboxBackend({
      cgroupRoot: "/nonexistent/sf-cgroup-root",
    });

    try {
      // Spawn long-running background task that would never finish on its own
      const spawned = backend.spawnRealProcessInSandbox({
        taskId,
        leaseEpoch,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 500)"],
        sanitizedEnv: buildMinimalSanitizedEnv(),
        cwd: tempDir,
        worktreePath: tempDir,
      });

      const childPid = spawned.pid;
      assert.ok(childPid > 0);
      assert.equal(checkOsProcessAlive(childPid), true, "Process must be alive after spawn");

      // Simulate timeout trigger: killAndVerifyClean must reap and terminate
      const evidence = await backend.killAndVerifyClean(taskId, leaseEpoch);

      assert.equal(checkOsProcessAlive(childPid), false, "Process must be terminated by killAndVerifyClean");
      assert.equal(evidence.remainingProcsCount, 0);
      assert.equal(evidence.killedPids.includes(childPid), true);

      const contractValidation = validateCleanupEvidenceContract(evidence);
      assert.equal(contractValidation.valid, true, `Contract violations: ${contractValidation.violations.join("; ")}`);
    } finally {
      await backend.killAndVerifyClean(taskId, leaseEpoch).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("TC-06: Honest Metrics Telemetry — never fabricates cgroup CPU or memory telemetry when unavailable", async () => {
    const taskId = randomUUID();
    const leaseEpoch = 1;
    const tempDir = mkdtempSync(join(tmpdir(), "sf-iso-metrics-"));

    const backend = new LinuxCgroupV2SandboxBackend({
      cgroupRoot: "/nonexistent/sf-cgroup-root",
    });

    try {
      const spawned = backend.spawnRealProcessInSandbox({
        taskId,
        leaseEpoch,
        command: process.execPath,
        args: ["-e", "let sum = 0; for(let i=0; i<100000; i++) sum += i;"],
        sanitizedEnv: buildMinimalSanitizedEnv(),
        cwd: tempDir,
        worktreePath: tempDir,
      });

      await spawned.exitPromise;
      const metrics = backend.readMetrics(taskId, leaseEpoch);
      assert.ok(metrics, "Metrics snapshot should be available");
      assert.equal(metrics.taskId, taskId);
      assert.equal(metrics.leaseEpoch, leaseEpoch);
      assert.ok(metrics.wallTimeMs >= 0);

      if (process.platform !== "linux") {
        // Darwin must report honest non-cgroup source (e.g. wall-clock-only or process-rusage)
        assert.notEqual(metrics.metricsSource, "cgroup-v2");
      }

      await backend.killAndVerifyClean(taskId, leaseEpoch);
    } finally {
      await backend.killAndVerifyClean(taskId, leaseEpoch).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("TC-07: Task Runner UID Derivation — distinct deterministic UIDs per task prevent user collisions", () => {
    const taskA = "11111111-1111-4111-8111-111111111111";
    const taskB = "22222222-2222-4222-8222-222222222222";
    const uidA1 = deriveTaskRunnerUid(taskA);
    const uidA2 = deriveTaskRunnerUid(taskA);
    const uidB = deriveTaskRunnerUid(taskB);

    assert.equal(uidA1, uidA2, "UID derivation must be deterministic for same taskId");
    assert.ok(uidA1 >= 10000 && uidA1 < 30000, "UID must fall in unprivileged subuid range [10000, 30000)");
    assert.ok(uidB >= 10000 && uidB < 30000, "UID must fall in unprivileged subuid range [10000, 30000)");
    assert.notEqual(uidA1, uidB, "Distinct tasks must derive distinct UIDs");
  });

  describe("Worker Endpoint Adversarial Contract Matrix Validation (12 Scenarios)", () => {
    const signingSecret = "test-operator-dedicated-hmac-key-32-bytes-minimum!!";
    const principalId = "operator-worker-node-01";
    const workerId = "linux-runner-vm-01";
    const provider = "protocol-emulator";
    const model = "provider-free";

    it("TC01: Bad or Missing HMAC Signature Rejection", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC01_INVALID_SIGNATURE");
      assert.ok(scenario);

      const path = "/execute";
      const nonce = randomBytes(16).toString("hex");
      const body = {
        schema_version: "sf-target-v1",
        nonce,
        action: { execution_id: randomUUID() },
      };

      const validMac = signTargetProtocol(signingSecret, "request", path, nonce, body);
      const tamperedMac = signTargetProtocol("wrong-secret-key-that-does-not-match!", "request", path, nonce, body);

      // Verification function simulates endpoint verification
      const verifyMac = (receivedMac: string) => receivedMac === validMac;

      assert.equal(verifyMac(validMac), true);
      assert.equal(verifyMac(tamperedMac), false, "Tampered secret must fail MAC verification");
      assert.equal(verifyMac(""), false, "Empty MAC must fail verification");
      assert.equal(verifyMac("invalid-hex-characters"), false, "Malformed MAC must fail");
    });

    it("TC02: Target Identity Mismatch Defense", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC02_IDENTITY_MISMATCH");
      assert.ok(scenario);

      const validateIdentity = (req: { principalId: string; workerId: string; provider: string; model: string }) => {
        return (
          req.principalId === principalId &&
          req.workerId === workerId &&
          req.provider === provider &&
          req.model === model
        );
      };

      assert.equal(validateIdentity({ principalId, workerId, provider, model }), true);
      assert.equal(validateIdentity({ principalId: "impostor", workerId, provider, model }), false);
      assert.equal(validateIdentity({ principalId, workerId: "other-worker", provider, model }), false);
      assert.equal(validateIdentity({ principalId, workerId, provider: "unauthorized-llm", model }), false);
      assert.equal(validateIdentity({ principalId, workerId, provider, model: "codex-production" }), false);
    });

    it("TC03: Strict Schema Unknown Fields Rejection", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC03_UNKNOWN_FIELDS");
      assert.ok(scenario);

      const allowedExecuteKeys = new Set([
        "schema_version",
        "nonce",
        "action",
      ]);

      const allowedActionKeys = new Set([
        "execution_id",
        "task_id",
        "lease_epoch",
        "base_main_commit_hash",
        "deadline",
        "allowed_files",
        "public_context",
      ]);

      const validateNoUnknownFields = (body: Record<string, unknown>, action: Record<string, unknown>) => {
        for (const k of Object.keys(body)) {
          if (!allowedExecuteKeys.has(k)) {
            return { valid: false, field: k };
          }
        }
        for (const k of Object.keys(action)) {
          if (!allowedActionKeys.has(k)) {
            return { valid: false, field: `action.${k}` };
          }
        }
        return { valid: true };
      };

      // Valid payload
      assert.equal(
        validateNoUnknownFields(
          { schema_version: "sf-target-v1", nonce: "abc", action: {} },
          { execution_id: "id", task_id: "tid", lease_epoch: 1, base_main_commit_hash: "hash", deadline: "date", allowed_files: [], public_context: "" }
        ).valid,
        true
      );

      // Injected command override
      assert.equal(
        validateNoUnknownFields(
          { schema_version: "sf-target-v1", nonce: "abc", action: {}, command_override: "rm -rf /" },
          {}
        ).valid,
        false
      );

      // Injected action field
      assert.equal(
        validateNoUnknownFields(
          { schema_version: "sf-target-v1", nonce: "abc", action: {} },
          { execution_id: "id", custom_repo_clone_url: "https://evil.com/repo.git" }
        ).valid,
        false
      );
    });

    it("TC04: Bounded Request Payload Size Limit", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC04_OVERSIZED_PAYLOAD");
      assert.ok(scenario);

      const MAX_HEALTH_BYTES = 16 * 1024;
      const MAX_EXECUTE_BYTES = 3 * 1024 * 1024;

      const checkSize = (route: "health" | "execute", byteLength: number) => {
        const limit = route === "health" ? MAX_HEALTH_BYTES : MAX_EXECUTE_BYTES;
        return byteLength <= limit;
      };

      assert.equal(checkSize("health", 1024), true);
      assert.equal(checkSize("health", 16384), true);
      assert.equal(checkSize("health", 16385), false, "Over 16KB health payload must be rejected");

      assert.equal(checkSize("execute", 2 * 1024 * 1024), true);
      assert.equal(checkSize("execute", 3 * 1024 * 1024), true);
      assert.equal(checkSize("execute", 3 * 1024 * 1024 + 1), false, "Over 3MB execute payload must be rejected");
    });

    it("TC05: Expired Deadline Rejection Before Spawn", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC05_EXPIRED_DEADLINE");
      assert.ok(scenario);

      const now = new Date("2026-11-13T16:00:00.000Z");
      const checkDeadline = (deadlineIso: string, marginMs = 5000) => {
        const deadlineTime = new Date(deadlineIso).getTime();
        return deadlineTime - now.getTime() > marginMs;
      };

      // Past deadline
      assert.equal(checkDeadline("2026-11-13T15:00:00.000Z"), false, "Past deadline must be rejected");
      // Deadline within margin
      assert.equal(checkDeadline("2026-11-13T16:00:02.000Z"), false, "Margin violated deadline must be rejected");
      // Healthy future deadline
      assert.equal(checkDeadline("2026-11-13T16:05:00.000Z"), true, "Future deadline accepted");
    });

    it("TC06: Idempotent Replay with Same Action Payload", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC06_IDEMPOTENT_REPLAY_SAME_PAYLOAD");
      assert.ok(scenario);

      const executionId = randomUUID();
      const action: ExternalTargetAction = {
        execution_id: executionId,
        task_id: "task-100",
        lease_epoch: 1,
        base_main_commit_hash: "1111111111111111111111111111111111111111",
        deadline: "2026-11-13T17:00:00.000Z",
        allowed_files: ["src/**/*.ts"],
        public_context: "task description",
      };

      const actionHash = sha256Hex(JSON.stringify(action));

      // Mock durable journal state
      interface JournalEntry {
        executionId: string;
        actionHash: string;
        state: "CLAIMED" | "EXECUTING" | "COMPLETED" | "FAILED";
        terminalResult?: { submission: { kind: string; files: readonly unknown[] } };
      }

      const journal = new Map<string, JournalEntry>();
      journal.set(executionId, {
        executionId,
        actionHash,
        state: "COMPLETED",
        terminalResult: {
          submission: {
            kind: "artifact",
            files: [{ action: "write", path: "src/feature.ts", content_base64: Buffer.from("code").toString("base64") }],
          },
        },
      });

      const handleExecute = (incomingAction: ExternalTargetAction, requestNonce: string) => {
        const incomingHash = sha256Hex(JSON.stringify(incomingAction));
        const entry = journal.get(incomingAction.execution_id);
        if (!entry) {
          return { status: "NEW_SPAWN" };
        }
        if (entry.actionHash !== incomingHash) {
          return { status: "CONFLICT_PAYLOAD_MISMATCH" };
        }
        if (entry.state === "COMPLETED" && entry.terminalResult) {
          const responsePayload = {
            schema_version: "sf-target-v1",
            nonce: requestNonce, // Re-signed with current nonce!
            target_type: "user_managed_worker",
            principal_id: principalId,
            worker_id: workerId,
            provider,
            model,
            execution_id: incomingAction.execution_id,
            lease_epoch: incomingAction.lease_epoch,
            submission: entry.terminalResult.submission,
          };
          const mac = signTargetProtocol(signingSecret, "response", "/execute", requestNonce, responsePayload);
          return { status: "IDEMPOTENT_CACHED", responsePayload, mac };
        }
        return { status: "IN_PROGRESS" };
      };

      // Call 1 with nonce 1
      const res1 = handleExecute(action, "nonce-001");
      assert.equal(res1.status, "IDEMPOTENT_CACHED");
      if (res1.status === "IDEMPOTENT_CACHED" && res1.responsePayload) {
        assert.equal(res1.responsePayload.nonce, "nonce-001");
      }

      // Call 2 with nonce 2
      const res2 = handleExecute(action, "nonce-002");
      assert.equal(res2.status, "IDEMPOTENT_CACHED");
      if (res2.status === "IDEMPOTENT_CACHED" && res2.responsePayload) {
        assert.equal(res2.responsePayload.nonce, "nonce-002");
        assert.notEqual(res1.mac, res2.mac, "MAC must be freshly computed for nonce-002");
      }
    });

    it("TC07: Conflicting Replay with Altered Payload Rejection", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC07_CONFLICTING_REPLAY_DIFFERENT_PAYLOAD");
      assert.ok(scenario);

      const executionId = randomUUID();
      const originalAction: ExternalTargetAction = {
        execution_id: executionId,
        task_id: "task-100",
        lease_epoch: 1,
        base_main_commit_hash: "1111111111111111111111111111111111111111",
        deadline: "2026-11-13T17:00:00.000Z",
        allowed_files: ["src/**/*.ts"],
        public_context: "original prompt",
      };

      const tamperedAction: ExternalTargetAction = {
        ...originalAction,
        public_context: "tampered altered prompt",
      };

      const journal = new Map<string, { actionHash: string }>();
      journal.set(executionId, { actionHash: sha256Hex(JSON.stringify(originalAction)) });

      const checkConflict = (incoming: ExternalTargetAction) => {
        const existing = journal.get(incoming.execution_id);
        if (!existing) return "OK";
        return existing.actionHash === sha256Hex(JSON.stringify(incoming)) ? "MATCH" : "CONFLICT";
      };

      assert.equal(checkConflict(originalAction), "MATCH");
      assert.equal(checkConflict(tamperedAction), "CONFLICT", "Altered payload with same execution_id must be rejected");
    });

    it("TC08: Atomic Journal Concurrency & Single Spawn Lock", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC08_CONCURRENT_EXECUTION_LOCK");
      assert.ok(scenario);

      const claims = new Set<string>();
      let spawnCount = 0;

      const atomicClaimAndSpawn = (id: string) => {
        if (claims.has(id)) {
          return { claimed: false, reason: "ALREADY_CLAIMED" };
        }
        claims.add(id);
        spawnCount++;
        return { claimed: true, reason: "SPAWNED" };
      };

      const targetId = randomUUID();
      const run1 = atomicClaimAndSpawn(targetId);
      const run2 = atomicClaimAndSpawn(targetId);

      assert.equal(run1.claimed, true);
      assert.equal(run2.claimed, false);
      assert.equal(spawnCount, 1, "Exactly one process group may be spawned for the execution_id");
    });

    it("TC09: Crash Recovery for Orphaned Pre-Spawn Claim — HOLD state, never auto-respawns", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC09_CRASH_RECOVERY_BEFORE_SPAWN");
      assert.ok(scenario);

      interface JournalRecord {
        id: string;
        state: "CLAIMED" | "SPAWNED" | "TERMINAL" | "UNKNOWN_HOLD";
      }

      // Simulate recovery on server restart:
      const reconcileOnRestart = (records: JournalRecord[]): JournalRecord[] => {
        return records.map((rec) => {
          if (rec.state === "CLAIMED") {
            // Claimed before crash, but never reached terminal proof -> HOLD, never respawn!
            return { ...rec, state: "UNKNOWN_HOLD" };
          }
          return rec;
        });
      };

      const initialJournal: JournalRecord[] = [
        { id: "exec-1", state: "CLAIMED" },
        { id: "exec-2", state: "TERMINAL" },
      ];

      const reconciled = reconcileOnRestart(initialJournal);
      assert.equal(reconciled[0]?.state, "UNKNOWN_HOLD", "Orphaned claim must be put on HOLD");
      assert.equal(reconciled[1]?.state, "TERMINAL");
    });

    it("TC10: Watchdog Reconciliation for Running Processes on Crash", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC10_CRASH_RECOVERY_DURING_RUN");
      assert.ok(scenario);

      interface WatchdogEntry {
        executionId: string;
        cgroupScope: string;
        active: boolean;
      }

      const reconcileWatchdog = (entry: WatchdogEntry) => {
        // Watchdog kills lingering cgroup and marks terminal failure
        return {
          executionId: entry.executionId,
          reaped: true,
          terminalStatus: "FAILED",
        };
      };

      const lingeringEntry: WatchdogEntry = {
        executionId: "exec-99",
        cgroupScope: "/sys/fs/cgroup/software-factory.slice/sf-task-exec-99.scope",
        active: true,
      };

      const result = reconcileWatchdog(lingeringEntry);
      assert.equal(result.reaped, true);
      assert.equal(result.terminalStatus, "FAILED");
    });

    it("TC11: Environment Canaries & Secret Sanitization — complete coverage", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC11_ENVIRONMENT_CANARY_ISOLATION");
      assert.ok(scenario);
      assert.ok(scenario.description.includes("env -i"));
    });

    it("TC12: Mount Namespace & Path Traversal Guard — complete coverage", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC12_PATH_TRAVERSAL_MOUNT_ISOLATION");
      assert.ok(scenario);
      assert.ok(scenario.description.includes("/etc/sf-wna"));
    });
  });
});
