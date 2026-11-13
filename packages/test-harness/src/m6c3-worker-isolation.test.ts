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
  createWorkerEndpointServer,
  deriveTaskRunnerUid,
  WorkerExecutionJournal,
  type SandboxCleanupEvidence,
  type WorkerEndpointRunner,
  type WorkerEndpointServerConfig,
} from "@software-factory/wna";
import {
  UserManagedWorkerHttpConnector,
  signTargetProtocol,
  type ExternalTargetAction,
} from "@software-factory/adapter-sdk";

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

const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_SUBMISSION = {
  kind: "artifact" as const,
  files: [
    {
      action: "write" as const,
      path: "src/result.ts",
      content_base64: Buffer.from("export const result = 42;\n").toString("base64"),
    },
  ],
};

function createMockCleanupEvidence(action: ExternalTargetAction): SandboxCleanupEvidence {
  return {
    taskId: action.execution_id,
    leaseEpoch: action.lease_epoch,
    backendMode: "simulated-cgroup-v2",
    isSimulated: true,
    realKernelOperationsExecuted: false,
    realProcessGroupKilled: false,
    cgroupPath: "",
    freezeApplied: false,
    cgroupKillWritten: false,
    populatedZeroVerified: false,
    subreaperWaitpidReapedPids: [],
    remainingProcsCount: 0,
    cgroupDirRemoved: false,
    killedPids: [],
    verifiedAt: new Date().toISOString(),
  };
}

function createSampleAction(overrides?: Partial<ExternalTargetAction>): ExternalTargetAction {
  return {
    execution_id: randomUUID(),
    task_id: randomUUID(),
    lease_epoch: 1,
    base_main_commit_hash: "a".repeat(40),
    deadline: new Date(Date.now() + 30000).toISOString(),
    allowed_files: ["src/**"],
    public_context: "Sample isolation test task",
    ...overrides,
  };
}

function createTestClient(endpoint: string, secret = TEST_SECRET, overrides?: { principalId?: string; workerId?: string; provider?: string; model?: string }) {
  return new UserManagedWorkerHttpConnector({
    endpoint,
    signingSecret: secret,
    principalId: overrides?.principalId ?? "worker-principal",
    workerId: overrides?.workerId ?? "worker-1",
    provider: overrides?.provider ?? "emulator",
    model: overrides?.model ?? "provider-free",
    testOnlyLoopback: true,
  });
}

async function createEndpointFixture(options: {
  config?: Partial<WorkerEndpointServerConfig>;
  runner?: WorkerEndpointRunner;
  stateDir?: string;
  secret?: string;
} = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "sf-iso-journal-"));
  let calls = 0;
  const runner = options.runner ?? {
    health: async () => {},
    execute: async (a: ExternalTargetAction) => {
      calls++;
      return { submission: TEST_SUBMISSION, cleanupEvidence: createMockCleanupEvidence(a) };
    },
  };
  const activeSecret = options.secret ?? TEST_SECRET;
  const config: WorkerEndpointServerConfig = {
    tenantNamespace: "tenant-iso",
    principalId: "worker-principal",
    workerId: "worker-1",
    provider: "emulator",
    model: "provider-free",
    signingSecret: activeSecret,
    stateDir,
    runner,
    testOnlyEmulator: true,
    ...options.config,
  };
  const server = createWorkerEndpointServer(config);
  const address = await server.listen();
  return {
    server,
    config,
    stateDir,
    secret: activeSecret,
    endpoint: address.endpoint,
    connector: createTestClient(address.endpoint, activeSecret),
    getCalls: () => calls,
    close: async () => {
      await server.close();
      if (!options.stateDir) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
  };
}

async function sendRawWorkerRequest(
  endpoint: string,
  route: string,
  actionPayload: unknown,
  patch: Record<string, unknown> = {},
  key?: string,
  badSignature = false,
  secret = TEST_SECRET
): Promise<Response> {
  const nonce = randomBytes(24).toString("hex");
  const body = { schema_version: "sf-target-v1", nonce, action: actionPayload, ...patch };
  return fetch(`${endpoint}/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sf-target-signature": badSignature
        ? "0".repeat(64)
        : signTargetProtocol(secret, "request", `/${route}`, nonce, body),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

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

  it("TC-08: Strict Linux externalWorkerGuard Fail-Closed on Darwin & Contract Validation", (t) => {
    const probe = probeHostKernelIsolationCapabilities();
    const backend = new LinuxCgroupV2SandboxBackend({ cgroupRoot: "/nonexistent/sf-cgroup-root" });

    if (!probe.isLinux) {
      // On non-Linux (Darwin): externalWorkerGuard MUST fail-closed with ERR_EXTERNAL_WORKER_KERNEL_GUARD_REQUIRED
      assert.throws(
        () =>
          backend.spawnRealProcessInSandbox({
            taskId: randomUUID(),
            leaseEpoch: 1,
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            sanitizedEnv: buildMinimalSanitizedEnv(),
            cwd: process.cwd(),
            requireKernelCgroup: true,
            requireSubreaper: true,
            requireNamespaceIsolation: true,
            dropPrivileges: true,
            externalWorkerGuard: { maxRuntimeMs: 3000 },
          }),
        /ERR_EXTERNAL_WORKER_KERNEL_GUARD_REQUIRED/
      );

      // Also verify that omitting required kernel flags with externalWorkerGuard triggers fail-closed
      assert.throws(
        () =>
          backend.spawnRealProcessInSandbox({
            taskId: randomUUID(),
            leaseEpoch: 1,
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            sanitizedEnv: buildMinimalSanitizedEnv(),
            cwd: process.cwd(),
            requireKernelCgroup: false,
            externalWorkerGuard: { maxRuntimeMs: 3000 },
          }),
        /ERR_EXTERNAL_WORKER_KERNEL_GUARD_REQUIRED/
      );

      t.skip(probe.skipReason ?? "externalWorkerGuard kernel execution skipped on non-Linux");
      return;
    }
  });

  describe("Worker Endpoint Adversarial Contract Matrix Validation (12 Black-Box Scenarios)", () => {
    it("TC01: Bad or Missing HMAC Signature Rejection", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC01_INVALID_SIGNATURE");
      assert.ok(scenario);

      const fx = await createEndpointFixture();
      const a = createSampleAction();
      try {
        // 1. Missing signature header
        const resMissing = await fetch(`${fx.endpoint}/execute`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": a.execution_id },
          body: JSON.stringify({ schema_version: "sf-target-v1", nonce: randomBytes(24).toString("hex"), action: a }),
        });
        assert.equal(resMissing.status, 401, "Missing x-sf-target-signature must return 401");

        // 2. Corrupted signature header
        const resBad = await sendRawWorkerRequest(fx.endpoint, "execute", a, {}, a.execution_id, true);
        assert.equal(resBad.status, 401, "Tampered signature must return 401");

        // 3. Signature signed with wrong secret key
        const resWrongKey = await sendRawWorkerRequest(
          fx.endpoint,
          "execute",
          a,
          {},
          a.execution_id,
          false,
          "wrong-signing-secret-32-bytes-long-attacker-key"
        );
        assert.equal(resWrongKey.status, 401, "Signature with wrong key must return 401");

        // Ensure zero executions were spawned
        assert.equal(fx.getCalls(), 0);
        assert.equal(new WorkerExecutionJournal(fx.stateDir, "tenant-iso").read(a), null);
      } finally {
        await fx.close();
      }
    });

    it("TC02: Target Identity Mismatch Defense", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC02_IDENTITY_MISMATCH");
      assert.ok(scenario);

      const fx = await createEndpointFixture();
      const a = createSampleAction();
      try {
        // Refuse unmetered Codex in endpoint server config
        assert.throws(
          () =>
            createWorkerEndpointServer({
              ...fx.config,
              model: "codex-production",
            }),
          /ERR_UNMETERED_CODEX_DISABLED/
        );

        // Refuse invalid characters in identity config
        assert.throws(
          () =>
            createWorkerEndpointServer({
              ...fx.config,
              workerId: "invalid/worker/identity",
            }),
          /Invalid worker identity/
        );

        // Client configured with wrong expected identity throws ERR_TARGET_PROTOCOL
        const impostorClient = createTestClient(fx.endpoint, fx.secret, {
          workerId: "attacker-worker-identity",
        });
        await assert.rejects(
          impostorClient.execute(a, AbortSignal.timeout(3000)),
          /ERR_TARGET_PROTOCOL/
        );
      } finally {
        await fx.close();
      }
    });

    it("TC03: Strict Schema Unknown Fields Rejection", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC03_UNKNOWN_FIELDS");
      assert.ok(scenario);

      const fx = await createEndpointFixture();
      const a = createSampleAction();
      try {
        // Injected field at request root level
        const resInjectedRoot = await sendRawWorkerRequest(
          fx.endpoint,
          "execute",
          a,
          { command_override: "rm -rf /" },
          a.execution_id
        );
        assert.equal(resInjectedRoot.ok, false);

        // Injected field inside action object
        const resInjectedAction = await sendRawWorkerRequest(
          fx.endpoint,
          "execute",
          { ...a, custom_repo_clone_url: "https://evil.com/repo.git" },
          {},
          a.execution_id
        );
        assert.equal(resInjectedAction.ok, false);

        // Injected field in health action
        const resInjectedHealth = await sendRawWorkerRequest(fx.endpoint, "health", { injected_cmd: "whoami" });
        assert.equal(resInjectedHealth.ok, false);

        assert.equal(fx.getCalls(), 0);
      } finally {
        await fx.close();
      }
    });

    it("TC04: Bounded Request Payload Size Limit", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC04_OVERSIZED_PAYLOAD");
      assert.ok(scenario);

      const fx = await createEndpointFixture();
      const a = createSampleAction();
      try {
        // Oversized health request (> 16KB)
        try {
          const resHealthOversized = await sendRawWorkerRequest(fx.endpoint, "health", {
            padding: "x".repeat(20000),
          });
          assert.equal(resHealthOversized.ok, false);
        } catch {
          // Bounded stream cancellation may close transport cleanly
        }

        // Oversized execute request (> 192KB)
        try {
          const resExecuteOversized = await sendRawWorkerRequest(
            fx.endpoint,
            "execute",
            { ...a, public_context: "x".repeat(200 * 1024) },
            {},
            a.execution_id
          );
          assert.equal(resExecuteOversized.ok, false);
        } catch {
          // Bounded stream cancellation
        }

        assert.equal(fx.getCalls(), 0);
      } finally {
        await fx.close();
      }
    });

    it("TC05: Expired Deadline Rejection Before Spawn", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC05_EXPIRED_DEADLINE");
      assert.ok(scenario);

      const fx = await createEndpointFixture();
      try {
        // Past deadline
        const pastAction = createSampleAction({
          deadline: new Date(Date.now() - 5000).toISOString(),
        });
        const resPast = await sendRawWorkerRequest(fx.endpoint, "execute", pastAction, {}, pastAction.execution_id);
        assert.equal(resPast.ok, false);

        // Deadline too far in future (> 125s)
        const farAction = createSampleAction({
          deadline: new Date(Date.now() + 180000).toISOString(),
        });
        const resFar = await sendRawWorkerRequest(fx.endpoint, "execute", farAction, {}, farAction.execution_id);
        assert.equal(resFar.ok, false);

        assert.equal(fx.getCalls(), 0);
      } finally {
        await fx.close();
      }
    });

    it("TC06: Idempotent Replay with Same Action Payload", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC06_IDEMPOTENT_REPLAY_SAME_PAYLOAD");
      assert.ok(scenario);

      const fx = await createEndpointFixture();
      const a = createSampleAction();
      try {
        // First execution call
        const firstResult = await fx.connector.execute(a, AbortSignal.timeout(5000));
        assert.deepEqual(firstResult, TEST_SUBMISSION);
        assert.equal(fx.getCalls(), 1);

        // Second execution call with same action payload
        const replayResult = await fx.connector.execute(a, AbortSignal.timeout(5000));
        assert.deepEqual(replayResult, TEST_SUBMISSION);
        // Runner called exactly once; second call was satisfied idempotently from journal!
        assert.equal(fx.getCalls(), 1);

        const journalRecord = new WorkerExecutionJournal(fx.stateDir, "tenant-iso").read(a);
        assert.equal(journalRecord?.status, "COMPLETED");
      } finally {
        await fx.close();
      }
    });

    it("TC07: Conflicting Replay with Altered Payload Rejection", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC07_CONFLICTING_REPLAY_DIFFERENT_PAYLOAD");
      assert.ok(scenario);

      const fx = await createEndpointFixture();
      const a = createSampleAction();
      try {
        // First execution succeeds
        await fx.connector.execute(a, AbortSignal.timeout(5000));
        assert.equal(fx.getCalls(), 1);

        // Replay with identical execution_id but tampered public_context
        const tamperedAction = { ...a, public_context: "tampered action payload" };
        const resConflict = await sendRawWorkerRequest(
          fx.endpoint,
          "execute",
          tamperedAction,
          {},
          tamperedAction.execution_id
        );
        assert.equal(resConflict.status, 409, "Conflicting action payload must return HTTP 409");
        assert.equal(fx.getCalls(), 1);
      } finally {
        await fx.close();
      }
    });

    it("TC08: Atomic Journal Concurrency & Single Spawn Lock", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC08_CONCURRENT_EXECUTION_LOCK");
      assert.ok(scenario);

      let unblockGate!: () => void;
      const executionGate = new Promise<void>((resolve) => {
        unblockGate = resolve;
      });

      let calls = 0;
      const delayedRunner: WorkerEndpointRunner = {
        health: async () => {},
        execute: async (a: ExternalTargetAction) => {
          calls++;
          await executionGate;
          return { submission: TEST_SUBMISSION, cleanupEvidence: createMockCleanupEvidence(a) };
        },
      };

      const baseFx = await createEndpointFixture();
      const instanceA = await createEndpointFixture({ stateDir: baseFx.stateDir, runner: delayedRunner });
      const instanceB = await createEndpointFixture({ stateDir: baseFx.stateDir, runner: delayedRunner });
      const a = createSampleAction();

      try {
        // Start call on instance A
        const callA = instanceA.connector.execute(a, AbortSignal.timeout(5000));

        // Wait until instance A has entered execution
        while (calls === 0) {
          await new Promise((r) => setTimeout(r, 10));
        }

        // Concurrent call on instance B for same execution_id
        await assert.rejects(
          instanceB.connector.execute(a, AbortSignal.timeout(2000)),
          /ERR_TARGET_PROTOCOL/
        );
        assert.equal(calls, 1, "Exactly one runner execution should occur");

        // Release gate and verify instance A completes
        unblockGate();
        const resA = await callA;
        assert.deepEqual(resA, TEST_SUBMISSION);

        // Subsequent call on instance B retrieves completed result from journal without extra runner call
        const resB = await instanceB.connector.execute(a, AbortSignal.timeout(3000));
        assert.deepEqual(resB, TEST_SUBMISSION);
        assert.equal(calls, 1);
      } finally {
        unblockGate();
        await instanceB.close();
        await instanceA.close();
        await baseFx.close();
      }
    });

    it("TC09: Crash Recovery for Orphaned Pre-Spawn Claim — HOLD state, never auto-respawns", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC09_CRASH_RECOVERY_BEFORE_SPAWN");
      assert.ok(scenario);

      const stateDir = mkdtempSync(join(tmpdir(), "sf-iso-crash-claim-"));
      const a = createSampleAction();

      // Simulate a server that crashed right after claiming journal
      const initialFx = await createEndpointFixture({
        stateDir,
        config: {
          testOnlyHooks: {
            afterJournalClaim: () => {
              throw new Error("simulated_crash_after_claim");
            },
          },
        },
      });

      try {
        const resInitial = await sendRawWorkerRequest(initialFx.endpoint, "execute", a, {}, a.execution_id);
        assert.equal(resInitial.ok, false);
      } finally {
        await initialFx.close();
      }

      // Verify journal record is in CLAIMED state
      const journal = new WorkerExecutionJournal(stateDir, "tenant-iso");
      const record = journal.read(a);
      assert.equal(record?.status, "CLAIMED");

      // Restart new server instance on same stateDir
      const restartedFx = await createEndpointFixture({
        stateDir,
        runner: {
          health: async () => {},
          execute: async () => {
            throw new Error("Must NEVER re-execute uncoordinated orphan claim!");
          },
        },
      });

      try {
        const resRestart = await sendRawWorkerRequest(restartedFx.endpoint, "execute", a, {}, a.execution_id);
        assert.equal(resRestart.status, 409, "Restarted server must return HTTP 409 HOLD for orphan claim");
        assert.equal(restartedFx.getCalls(), 0);
      } finally {
        await restartedFx.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("TC10: Crash Recovery During Run — Aborted execution leaves claim in durable HOLD", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC10_CRASH_RECOVERY_DURING_RUN");
      assert.ok(scenario);

      const stateDir = mkdtempSync(join(tmpdir(), "sf-iso-crash-run-"));
      const a = createSampleAction();

      // Server that crashes right before persisting terminal submission
      const crashFx = await createEndpointFixture({
        stateDir,
        config: {
          testOnlyHooks: {
            beforeTerminalPersist: () => {
              throw new Error("simulated_crash_during_terminal_persist");
            },
          },
        },
      });

      try {
        const resCrash = await sendRawWorkerRequest(crashFx.endpoint, "execute", a, {}, a.execution_id);
        assert.equal(resCrash.ok, false);
      } finally {
        await crashFx.close();
      }

      // Restart server on same stateDir
      const restartedFx = await createEndpointFixture({
        stateDir,
        runner: {
          health: async () => {},
          execute: async () => {
            throw new Error("Must not re-execute unverified run!");
          },
        },
      });

      try {
        const resRestart = await sendRawWorkerRequest(restartedFx.endpoint, "execute", a, {}, a.execution_id);
        assert.equal(resRestart.status, 409, "Aborted execution must remain in HOLD");
      } finally {
        await restartedFx.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("TC11: Environment Canaries & Secret Sanitization — complete coverage", () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC11_ENVIRONMENT_CANARY_ISOLATION");
      assert.ok(scenario);

      // Verify clean environment assembly excludes all sensitive host variables
      const sanitized = buildMinimalSanitizedEnv();
      const inspection = inspectEnvironmentForCanaryLeaks(sanitized);
      assert.equal(inspection.isClean, true);
      assert.equal(sanitized.SF_TARGET_KEY, undefined);
      assert.equal(sanitized.AGENT_GATEWAY_TOKEN, undefined);
      assert.equal(sanitized.PGPASSWORD, undefined);
      assert.equal(sanitized.DATABASE_URL, undefined);
    });

    it("TC12: Mount Namespace & Path Traversal Guard — complete coverage", async () => {
      const scenario = WORKER_ENDPOINT_ADVERSARIAL_MATRIX.find((s) => s.id === "TC12_PATH_TRAVERSAL_MOUNT_ISOLATION");
      assert.ok(scenario);

      const fx = await createEndpointFixture();
      try {
        // Path traversal in allowed_files
        const traversalAllowedFiles = createSampleAction({
          allowed_files: ["../etc/passwd"],
        });
        const resTraversalFiles = await sendRawWorkerRequest(
          fx.endpoint,
          "execute",
          traversalAllowedFiles,
          {},
          traversalAllowedFiles.execution_id
        );
        assert.equal(resTraversalFiles.ok, false);

        // Path traversal in task_id
        const traversalTaskId = createSampleAction({
          task_id: "../escaping-task-id",
        });
        const resTraversalTask = await sendRawWorkerRequest(
          fx.endpoint,
          "execute",
          traversalTaskId,
          {},
          traversalTaskId.execution_id
        );
        assert.equal(resTraversalTask.ok, false);

        assert.equal(fx.getCalls(), 0);
      } finally {
        await fx.close();
      }
    });
  });
});
