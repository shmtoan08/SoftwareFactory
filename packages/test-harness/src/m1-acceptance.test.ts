import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type WorkerEventEnvelope,
  computeCanonicalPayloadSha256,
  computeEventIdempotencyKey,
  computeTaskExecutionIdempotencyKey,
  sha256Hex,
} from "../../shared-types/src/index.ts";
import {
  type TaskContractSpec,
  evaluatePathPolicyPrecedence,
  validateGitTreeImport,
} from "../../task-contract/src/index.ts";
import {
  PostgresRlsError,
  SoftwareFactoryControlPlaneStore,
} from "../../database/src/index.ts";
import {
  LinuxCgroupV2SandboxBackend,
  LocalOutboxBuffer,
} from "../../wna/src/index.ts";
import { AgentGatewayService } from "../../../apps/agent-gateway/src/index.ts";
import { CoreApiService } from "../../../apps/core-api/src/index.ts";
import { WebApprovalConsoleController } from "../../../apps/web/src/index.ts";
import { FakeAgentHarnessAdapter } from "./index.ts";

const DEFAULT_CONTRACT: TaskContractSpec = {
  allowed_files: ["src/**/*.ts", "packages/*/src/**/*.ts"],
  protected_paths: ["src/security/**", "packages/database/migrations/**"],
  forbidden_paths: ["secrets/**", ".env*"],
  max_changed_files: 10,
  max_deleted_lines: 200,
};

const INITIAL_MAIN_SHA = "1111111111111111111111111111111111111111";
const INITIAL_TREE_SHA = "2222222222222222222222222222222222222222";

function createTestEnvironment(initialNow = new Date("2026-11-10T09:00:00.000Z")) {
  let currentNow = new Date(initialNow.getTime());
  const store = new SoftwareFactoryControlPlaneStore(() => currentNow);
  const advanceClockMs = (ms: number) => {
    currentNow = new Date(currentNow.getTime() + ms);
  };

  let projectAId = "";
  let projectBId = "";

  store.withRlsTransaction(
    {
      currentRole: "system_admin_role",
      currentPrincipalId: "bootstrap-admin",
    },
    () => {
      const pA = store.createProject({
        project_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        slug: "project-alpha",
        name: "Project Alpha",
        repo_bare_path: "/var/lib/software-factory/repos/project-alpha.git",
        initial_main_commit_hash: INITIAL_MAIN_SHA,
        initial_main_tree_hash: INITIAL_TREE_SHA,
      });
      const pB = store.createProject({
        project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        slug: "project-beta",
        name: "Project Beta",
        repo_bare_path: "/var/lib/software-factory/repos/project-beta.git",
        initial_main_commit_hash: INITIAL_MAIN_SHA,
        initial_main_tree_hash: INITIAL_TREE_SHA,
      });
      projectAId = pA.project_id;
      projectBId = pB.project_id;
    }
  );

  const coreApi = new CoreApiService(store);
  const gatewayA = new AgentGatewayService({
    store,
    projectId: projectAId,
    workerPrincipalId: "wna-worker-alpha-01",
  });
  const webConsole = new WebApprovalConsoleController(coreApi);
  const sandboxBackend = new LinuxCgroupV2SandboxBackend();
  const fakeAgent = new FakeAgentHarnessAdapter();

  return {
    store,
    coreApi,
    gatewayA,
    webConsole,
    sandboxBackend,
    fakeAgent,
    projectAId,
    projectBId,
    advanceClockMs,
    getCurrentClock: () => currentNow,
  };
}

describe("Milestone M1 Gate — Part 1: 8-Scenario PostgreSQL RLS Isolation Matrix (RLS-T1 .. RLS-T8)", () => {
  it("RLS-T1: Default Deny when app.current_project_id is unset or empty", async () => {
    const { store, coreApi, projectAId } = createTestEnvironment();
    await coreApi.createTask(projectAId, "dev-1", {
      title: "Task Alpha 1",
      task_contract: DEFAULT_CONTRACT,
    });

    // Query without setting app.current_project_id
    const visibleWithoutContext = store.selectVisibleTasks();
    assert.equal(visibleWithoutContext.length, 0, "RLS-T1: Unscoped SELECT must return 0 rows");

    // Attempt INSERT without setting app.current_project_id
    assert.throws(
      () =>
        store.createTask({
          project_id: projectAId,
          title: "Unauthorized Insert",
          task_contract: DEFAULT_CONTRACT,
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "42501"
    );
  });

  it("RLS-T2: Cross-Tenant SELECT Isolation (Project B cannot see Project A rows)", async () => {
    const { store, coreApi, projectAId, projectBId } = createTestEnvironment();
    const taskA = await coreApi.createTask(projectAId, "dev-a", {
      title: "Alpha Secret Task",
      task_contract: DEFAULT_CONTRACT,
    });
    const taskB = await coreApi.createTask(projectBId, "dev-b", {
      title: "Beta Task",
      task_contract: DEFAULT_CONTRACT,
    });

    const visibleInB = await store.withRlsTransaction(
      {
        currentProjectId: projectBId,
        currentPrincipalId: "dev-b",
        currentRole: "core_api_service",
      },
      () => store.selectVisibleTasks()
    );

    assert.equal(visibleInB.length, 1);
    assert.equal(visibleInB[0]?.task_id, taskB.task_id);
    assert.notEqual(visibleInB[0]?.task_id, taskA.task_id);
  });

  it("RLS-T3: Cross-Tenant INSERT Blocked by WITH CHECK (42501 insufficient_privilege)", async () => {
    const { store, projectAId, projectBId } = createTestEnvironment();

    await assert.rejects(
      async () =>
        store.withRlsTransaction(
          {
            currentProjectId: projectAId,
            currentPrincipalId: "dev-a",
            currentRole: "core_api_service",
          },
          () =>
            store.createTask({
              project_id: projectBId, // Mismatched tenant!
              title: "Spoofed cross-tenant insert",
              task_contract: DEFAULT_CONTRACT,
            })
        ),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "42501"
    );
  });

  it("RLS-T4: Cross-Tenant UPDATE Returns 0 Rows and Leaves Target Row Untouched", async () => {
    const { store, coreApi, projectAId, projectBId } = createTestEnvironment();
    const taskA = await coreApi.createTask(projectAId, "dev-a", {
      title: "Original Alpha Title",
      task_contract: DEFAULT_CONTRACT,
    });

    const updatedCount = await store.withRlsTransaction(
      {
        currentProjectId: projectBId,
        currentPrincipalId: "dev-b",
        currentRole: "core_api_service",
      },
      () => store.updateTaskTitleRls(taskA.task_id, "Tampered Title From Project B")
    );

    assert.equal(updatedCount, 0);

    const checkTaskA = await store.withRlsTransaction(
      {
        currentProjectId: projectAId,
        currentPrincipalId: "dev-a",
        currentRole: "core_api_service",
      },
      () => store.getTaskById(taskA.task_id)
    );
    assert.equal(checkTaskA?.title, "Original Alpha Title");
  });

  it("RLS-T5: Cross-Tenant DELETE Blocked (Project B cannot delete Project A rows)", async () => {
    const { store, coreApi, projectAId, projectBId } = createTestEnvironment();
    const taskA = await coreApi.createTask(projectAId, "dev-a", {
      title: "Task Alpha",
      task_contract: DEFAULT_CONTRACT,
    });

    // Cross-tenant delete attempt from Project B returns 0 rows
    const deletedCrossTenant = await store.withRlsTransaction(
      {
        currentProjectId: projectBId,
        currentPrincipalId: "dev-b",
        currentRole: "core_api_service",
      },
      () => store.deleteTaskRls(taskA.task_id)
    );
    assert.equal(deletedCrossTenant, 0);
  });

  it("RLS-T6: Connection Pool Reuse Safety (SET LOCAL Resets on Transaction Completion / DISCARD ALL)", async () => {
    const { store, coreApi, projectAId } = createTestEnvironment();
    await coreApi.createTask(projectAId, "dev-a", {
      title: "Scoped Task",
      task_contract: DEFAULT_CONTRACT,
    });

    // Inside transaction, 1 row is visible
    const insideCount = await store.withRlsTransaction(
      {
        currentProjectId: projectAId,
        currentPrincipalId: "dev-a",
        currentRole: "core_api_service",
      },
      () => store.selectVisibleTasks().length
    );
    assert.equal(insideCount, 1);

    // Immediately after transaction returns to pool, context is reset to Default Deny (0 rows)
    const afterPoolReturnCount = store.selectVisibleTasks().length;
    assert.equal(afterPoolReturnCount, 0);
  });

  it("RLS-T7: Tier 3 Append-Only Evidence Immutability (processed_worker_events Prohibits DELETE with 42501)", async () => {
    const { store, coreApi, gatewayA, projectAId } = createTestEnvironment();
    const taskA = await coreApi.createTask(projectAId, "dev-a", {
      title: "Task Alpha Evidence",
      task_contract: DEFAULT_CONTRACT,
    });
    const leaseA = await coreApi.dispatchTaskLease(projectAId, "dev-a", {
      task_id: taskA.task_id,
      worker_id: "worker-1",
    });

    const payload = { step: "accepted" };
    const ack = await gatewayA.submitEvent({
      schema_version: "1.5",
      project_id: projectAId,
      task_id: taskA.task_id,
      attempt_no: leaseA.attempt_no,
      lease_id: leaseA.lease_id,
      lease_epoch: leaseA.lease_epoch,
      worker_id: leaseA.worker_id,
      sequence_no: 1,
      event_type: "task.accepted",
      task_execution_idempotency_key: leaseA.task_execution_idempotency_key,
      event_idempotency_key: computeEventIdempotencyKey(
        leaseA.lease_id,
        leaseA.lease_epoch,
        1,
        "task.accepted"
      ),
      payload_sha256: computeCanonicalPayloadSha256(payload),
      emitted_at: new Date().toISOString(),
      payload,
    });
    assert.equal(ack.ack_status, "ACCEPTED");

    // RLS-T7: Attempting to DELETE from Tier 3 processed_worker_events throws 42501
    assert.throws(
      () => store.deleteProcessedWorkerEventRls("any-event-id"),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "42501"
    );
  });

  it("RLS-T8: Composite 8-Field Foreign Key Prevents Cross-Tenant or Mismatched Hash Approval Binding", async () => {
    const { coreApi, gatewayA, projectAId, projectBId } = createTestEnvironment();
    const taskA = await coreApi.createTask(projectAId, "dev-a", {
      title: "Task Alpha",
      task_contract: DEFAULT_CONTRACT,
    });
    const leaseA = await coreApi.dispatchTaskLease(projectAId, "dev-a", {
      task_id: taskA.task_id,
      worker_id: "worker-1",
    });

    const stagingRef = `refs/heads/sf/staging/${taskA.task_id}/${leaseA.lease_epoch}`;
    const agentCommit = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const verifiedTree = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
    const candidateHash = "cccc3333cccc3333cccc3333cccc3333cccc3333";

    await gatewayA.authorizeAndPushStagingRef({
      task_id: taskA.task_id,
      lease_id: leaseA.lease_id,
      lease_epoch: leaseA.lease_epoch,
      staging_ref: stagingRef,
      agent_commit_hash: agentCommit,
      verified_tree_hash: verifiedTree,
      parent_commit_hashes: [INITIAL_MAIN_SHA],
    });

    const { mergeCandidate } = await coreApi.importAndBuildCandidate(projectAId, "dev-a", {
      task_id: taskA.task_id,
      lease_id: leaseA.lease_id,
      lease_epoch: leaseA.lease_epoch,
      staging_ref: stagingRef,
      base_main_commit_hash: INITIAL_MAIN_SHA,
      merge_candidate_hash: candidateHash,
      candidate_input: {
        agent_commit_hash: agentCommit,
        verified_tree_hash: verifiedTree,
        parent_commit_hashes: [INITIAL_MAIN_SHA],
        expected_base_main_commit_hash: INITIAL_MAIN_SHA,
        contract: DEFAULT_CONTRACT,
        changes: [
          {
            path: "src/feature.ts",
            mode: "100644",
            size_bytes: 256,
            is_binary: false,
            added_lines: 15,
            deleted_lines: 2,
            blob_sha: "dddd4444dddd4444dddd4444dddd4444dddd4444",
          },
        ],
      },
    });

    const { verificationRun, reviewArtifact } =
      await coreApi.recordVerificationAndIndependentReview(projectAId, "dev-a", {
        task_id: taskA.task_id,
        merge_candidate_id: mergeCandidate.merge_candidate_id,
        merge_candidate_hash: candidateHash,
        verified_tree_hash: verifiedTree,
        verifier_image_digest: "sha256:9999888877776666555544443333222211110000",
        verification_verdict: "PASS",
        exit_code: 0,
        duration_ms: 1200,
        report_sha256: sha256Hex("verifier-report-ok"),
        writer_provider: "anthropic",
        writer_model: "claude-3-7-sonnet",
        reviewer_provider: "openai",
        reviewer_model: "gpt-4.1",
        review_verdict: "PASS",
      });

    // Attempt 1: Cross-tenant binding from Project B referencing Project A's candidate -> rejected 23503
    await assert.rejects(
      async () =>
        coreApi.submitHumanApproval(projectBId, "approver-b", {
          task_id: taskA.task_id,
          merge_candidate_id: mergeCandidate.merge_candidate_id,
          agent_commit_hash: agentCommit,
          base_main_commit_hash: INITIAL_MAIN_SHA,
          verified_tree_hash: verifiedTree,
          merge_candidate_hash: candidateHash,
          verification_run_id: verificationRun.verification_run_id,
          review_artifact_id: reviewArtifact.review_artifact_id,
          decision: "APPROVED",
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23503"
    );

    // Attempt 2: Tampered verified_tree_hash in 8-field approval payload -> rejected 23503
    await assert.rejects(
      async () =>
        coreApi.submitHumanApproval(projectAId, "approver-a", {
          task_id: taskA.task_id,
          merge_candidate_id: mergeCandidate.merge_candidate_id,
          agent_commit_hash: agentCommit,
          base_main_commit_hash: INITIAL_MAIN_SHA,
          verified_tree_hash: "9999999999999999999999999999999999999999", // tampered!
          merge_candidate_hash: candidateHash,
          verification_run_id: verificationRun.verification_run_id,
          review_artifact_id: reviewArtifact.review_artifact_id,
          decision: "APPROVED",
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23503"
    );
  });
});

describe("Milestone M1 Gate — Part 2: 10 Adversarial & Recovery Scenarios (Fake Agent Harness)", () => {
  it("Scenario 1: Happy-Path Full Vertical Slice (Task -> Lease -> Outbox Events -> Import -> Candidate -> Verifier -> 3D Reviewer -> 8-Field Approval -> Atomic CAS Merge)", async () => {
    const {
      store,
      coreApi,
      gatewayA,
      webConsole,
      sandboxBackend,
      fakeAgent,
      projectAId,
    } = createTestEnvironment();

    const tempDir = mkdtempSync(join(tmpdir(), "sf-outbox-s1-"));
    try {
      const task = await coreApi.createTask(projectAId, "operator-1", {
        title: "Implement deterministic lease coordinator",
        task_contract: DEFAULT_CONTRACT,
      });
      assert.equal(task.status, "QUEUED");

      const lease = await coreApi.dispatchTaskLease(projectAId, "operator-1", {
        task_id: task.task_id,
        worker_id: "wna-node-01",
      });
      assert.equal(lease.status, "ACTIVE");
      assert.equal(lease.lease_epoch, 1);

      const outbox = new LocalOutboxBuffer({
        projectId: projectAId,
        taskId: task.task_id,
        attemptNo: lease.attempt_no,
        leaseId: lease.lease_id,
        leaseEpoch: lease.lease_epoch,
        workerId: lease.worker_id,
        sandboxBackend,
        outboxDir: tempDir,
      });

      // Verify .jsonl file permissions are 0600
      outbox.enqueueEvent("task.accepted", { worker: lease.worker_id });
      outbox.enqueueEvent("task.started", { sandbox: "cgroup-v2" });
      outbox.enqueueEvent("task.progress", { step: "writing code", pct: 50 });
      outbox.enqueueEvent("task.heartbeat", { cpu_pct: 12 });

      if (outbox.outboxFilePath) {
        const mode = statSync(outbox.outboxFilePath).mode & 0o777;
        assert.equal(mode, 0o600, "Outbox .jsonl must enforce 0600 permissions");
      }

      // Execute FakeAgentHarnessAdapter
      const agentCtx = {
        projectId: projectAId,
        taskId: task.task_id,
        leaseId: lease.lease_id,
        leaseEpoch: lease.lease_epoch,
        worktreePath: "/tmp/worktree",
        baseMainCommitHash: INITIAL_MAIN_SHA,
        taskTitle: task.title,
        taskContract: DEFAULT_CONTRACT,
      };
      const execResult = await fakeAgent.parseExecutionResult(agentCtx, 0, "done", "");

      // Push to staging ref while lease is ACTIVE
      const stagingRef = `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`;
      const pushRes = await gatewayA.authorizeAndPushStagingRef({
        task_id: task.task_id,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: stagingRef,
        agent_commit_hash: execResult.agentCommitHash,
        verified_tree_hash: execResult.verifiedTreeHash,
        parent_commit_hashes: [INITIAL_MAIN_SHA],
        changes: [
          {
            path: "src/calculator.ts",
            mode: "100644",
            size_bytes: 120,
            added_lines: 10,
            deleted_lines: 0,
            is_binary: false,
            blob_sha: INITIAL_MAIN_SHA,
          },
        ],
      });
      assert.equal(pushRes.allowed, true);

      // Enqueue terminal task.completed event and flush all 5 events in order
      outbox.enqueueEvent("task.completed", {
        agent_commit_hash: execResult.agentCommitHash,
        verified_tree_hash: execResult.verifiedTreeHash,
        staging_ref: stagingRef,
      });

      const acks = await outbox.sendOrReplay(gatewayA);
      assert.equal(acks.length, 5);
      assert.equal(acks[4]?.ack_status, "ACCEPTED");
      assert.equal(acks[4]?.task_status, "AGENT_COMPLETED");
      assert.equal(acks[4]?.lease_status, "COMPLETED");

      // Import & Build Candidate C_candidate
      const candidateHash = sha256Hex(`candidate:${execResult.agentCommitHash}:${INITIAL_MAIN_SHA}`).slice(0, 40);
      const { mergeCandidate } = await coreApi.importAndBuildCandidate(projectAId, "operator-1", {
        task_id: task.task_id,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        staging_ref: stagingRef,
        base_main_commit_hash: INITIAL_MAIN_SHA,
        merge_candidate_hash: candidateHash,
        candidate_input: {
          agent_commit_hash: execResult.agentCommitHash,
          verified_tree_hash: execResult.verifiedTreeHash,
          parent_commit_hashes: [INITIAL_MAIN_SHA],
          expected_base_main_commit_hash: INITIAL_MAIN_SHA,
          contract: DEFAULT_CONTRACT,
          changes: [
            {
              path: "src/coordinator.ts",
              mode: "100644",
              size_bytes: 1024,
              is_binary: false,
              added_lines: 45,
              deleted_lines: 5,
              blob_sha: sha256Hex("blob-1").slice(0, 40),
            },
          ],
        },
      });

      // Verify & 3D Independent Review (Anthropic writer != OpenAI reviewer)
      const { verificationRun, reviewArtifact } =
        await coreApi.recordVerificationAndIndependentReview(projectAId, "operator-1", {
          task_id: task.task_id,
          merge_candidate_id: mergeCandidate.merge_candidate_id,
          merge_candidate_hash: mergeCandidate.merge_candidate_hash,
          verified_tree_hash: mergeCandidate.verified_tree_hash,
          verifier_image_digest: "sha256:abcdef0123456789abcdef0123456789",
          verification_verdict: "PASS",
          exit_code: 0,
          duration_ms: 850,
          report_sha256: sha256Hex("report-pass"),
          writer_provider: execResult.writerProvider,
          writer_model: execResult.writerModel,
          reviewer_provider: "google",
          reviewer_model: "gemini-2.5-pro",
          review_verdict: "PASS",
        });

      // 8-Field Human Approval via Web Console Controller
      const approval = await webConsole.approveCandidateWith8FieldBinding({
        approverPrincipalId: "tech-lead-01",
        candidate: mergeCandidate,
        verificationRun,
        reviewArtifact,
      });
      assert.equal(approval.status, "ACTIVE");

      // Execute Atomic CAS Merge
      const mergeResult = await coreApi.executeCasMerge(projectAId, "operator-1", {
        task_id: task.task_id,
        merge_candidate_id: mergeCandidate.merge_candidate_id,
        approval_id: approval.approval_id,
      });
      assert.equal(mergeResult.status, "MERGED_BY_CAS");
      assert.equal(mergeResult.task_status, "MERGED");
      assert.equal(mergeResult.main_ref_commit_hash, candidateHash);

      const finalTask = await store.withRlsTransaction(
        { currentProjectId: projectAId, currentRole: "core_api_service" },
        () => store.getTaskById(task.task_id)
      );
      assert.equal(finalTask?.status, "MERGED");
      assert.equal(finalTask?.merged_commit_hash, candidateHash);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("Scenario 2: Duplicate Event Retry & Payload Tampering Detection (200 DUPLICATE_RETRY_NOP vs 409 ERR_IDEMPOTENCY_PAYLOAD_MISMATCH)", async () => {
    const { store, coreApi, gatewayA, projectAId } = createTestEnvironment();
    const task = await coreApi.createTask(projectAId, "op-1", {
      title: "Idempotency test",
      task_contract: DEFAULT_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectAId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-1",
    });

    const payload = { message: "accepting task" };
    const env1: WorkerEventEnvelope = {
      schema_version: "1.5",
      project_id: projectAId,
      task_id: task.task_id,
      attempt_no: lease.attempt_no,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      worker_id: lease.worker_id,
      sequence_no: 1,
      event_type: "task.accepted",
      task_execution_idempotency_key: lease.task_execution_idempotency_key,
      event_idempotency_key: computeEventIdempotencyKey(
        lease.lease_id,
        lease.lease_epoch,
        1,
        "task.accepted"
      ),
      payload_sha256: computeCanonicalPayloadSha256(payload),
      emitted_at: new Date().toISOString(),
      payload,
    };

    const firstAck = await gatewayA.submitEvent(env1);
    assert.equal(firstAck.http_status, 200);
    assert.equal(firstAck.ack_status, "ACCEPTED");

    const outboxCountAfterFirst = await store.withRlsTransaction(
      { currentProjectId: projectAId, currentRole: "core_api_service" },
      () => store.listOutboxEventsForProject().length
    );

    // Exact duplicate retry -> 200 DUPLICATE_RETRY_NOP without creating duplicate outbox events
    const retryAck = await gatewayA.submitEvent(env1);
    assert.equal(retryAck.http_status, 200);
    assert.equal(retryAck.ack_status, "DUPLICATE_RETRY_NOP");
    assert.equal(retryAck.expected_next_seq, 2);

    const outboxCountAfterRetry = await store.withRlsTransaction(
      { currentProjectId: projectAId, currentRole: "core_api_service" },
      () => store.listOutboxEventsForProject().length
    );
    assert.equal(outboxCountAfterRetry, outboxCountAfterFirst);

    // Same sequence_no / idempotency key with different payload -> 409 REJECTED_CONFLICT_PAYLOAD
    const tamperedPayload = { message: "DIFFERENT PAYLOAD" };
    const tamperedAck = await gatewayA.submitEvent({
      ...env1,
      payload: tamperedPayload,
      payload_sha256: computeCanonicalPayloadSha256(tamperedPayload),
    });
    assert.equal(tamperedAck.http_status, 409);
    assert.equal(tamperedAck.ack_status, "REJECTED_CONFLICT_PAYLOAD");
    assert.equal(tamperedAck.error_code, "ERR_IDEMPOTENCY_PAYLOAD_MISMATCH");
  });

  it("Scenario 3: Out-of-Order Sequence Gap Rejection (seq=1 -> seq=3 returns 409 ERR_SEQ_GAP) & Automatic LocalOutboxBuffer Gap Replay", async () => {
    const { coreApi, gatewayA, sandboxBackend, projectAId } = createTestEnvironment();
    const task = await coreApi.createTask(projectAId, "op-1", {
      title: "Out of order sequence test",
      task_contract: DEFAULT_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectAId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-1",
    });

    const outbox = new LocalOutboxBuffer({
      projectId: projectAId,
      taskId: task.task_id,
      attemptNo: lease.attempt_no,
      leaseId: lease.lease_id,
      leaseEpoch: lease.lease_epoch,
      workerId: lease.worker_id,
      sandboxBackend,
    });

    const ev1 = outbox.enqueueEvent("task.accepted", { seq: 1 });
    const _ev2 = outbox.enqueueEvent("task.started", { seq: 2 });
    const ev3 = outbox.enqueueEvent("task.progress", { seq: 3 });

    // Send seq=1 directly
    const ack1 = await gatewayA.submitEvent(ev1);
    assert.equal(ack1.ack_status, "ACCEPTED");
    assert.equal(ack1.expected_next_seq, 2);

    // Send seq=3 skipping seq=2 -> must be rejected with 409 ERR_SEQ_GAP and expected_next_seq = 2
    const ack3Premature = await gatewayA.submitEvent(ev3);
    assert.equal(ack3Premature.http_status, 409);
    assert.equal(ack3Premature.ack_status, "REJECTED_OUT_OF_ORDER");
    assert.equal(ack3Premature.error_code, "ERR_SEQ_GAP");
    assert.equal(ack3Premature.expected_next_seq, 2);

    // LocalOutboxBuffer reconnect sync & replay automatically fills seq=2 then seq=3!
    const { sync, acks } = await outbox.syncAndReplayAfterReconnect(gatewayA);
    assert.equal(sync.expected_next_seq, 2);
    assert.equal(acks.length, 2);
    assert.equal(acks[0]?.acked_sequence_no, 2);
    assert.equal(acks[1]?.acked_sequence_no, 3);
    assert.equal(acks[1]?.task_status, "IN_PROGRESS");
  });

  it("Scenario 4: Invalid State Transition Rejection (task.completed directly from LEASED without task.accepted/started -> 422 ERR_INVALID_STATE_TRANSITION)", async () => {
    const { coreApi, gatewayA, projectAId } = createTestEnvironment();
    const task = await coreApi.createTask(projectAId, "op-1", {
      title: "Invalid state transition test",
      task_contract: DEFAULT_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectAId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-1",
    });

    const payload = { premature: true };
    const ack = await gatewayA.submitEvent({
      schema_version: "1.5",
      project_id: projectAId,
      task_id: task.task_id,
      attempt_no: lease.attempt_no,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      worker_id: lease.worker_id,
      sequence_no: 1,
      event_type: "task.completed", // Illegal from LEASED!
      task_execution_idempotency_key: lease.task_execution_idempotency_key,
      event_idempotency_key: computeEventIdempotencyKey(
        lease.lease_id,
        lease.lease_epoch,
        1,
        "task.completed"
      ),
      payload_sha256: computeCanonicalPayloadSha256(payload),
      emitted_at: new Date().toISOString(),
      payload,
    });

    assert.equal(ack.http_status, 422);
    assert.equal(ack.ack_status, "REJECTED_INVALID_TRANSITION");
    assert.equal(ack.error_code, "ERR_INVALID_STATE_TRANSITION");
  });

  it("Scenario 5: Concurrent Lease Revocation Race & Real-Time clock_timestamp() Expiry + Zombie Process Tree Termination (killAndVerifyClean)", async () => {
    const {
      coreApi,
      gatewayA,
      sandboxBackend,
      projectAId,
      advanceClockMs,
    } = createTestEnvironment();

    const task = await coreApi.createTask(projectAId, "op-1", {
      title: "Concurrency race & cgroup kill test",
      task_contract: DEFAULT_CONTRACT,
    });
    const lease1 = await coreApi.dispatchTaskLease(projectAId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-zombie-1",
      heartbeat_interval_ms: 10_000,
      lease_ttl_ms: 30_000,
    });

    // Spawn simulated agent + grandchild processes inside Linux cgroup v2 sandbox
    sandboxBackend.spawnProcessInSandbox({
      taskId: task.task_id,
      leaseEpoch: lease1.lease_epoch,
      pid: 50001,
      childPids: [50002, 50003],
    });
    assert.equal(sandboxBackend.getActivePids(task.task_id, lease1.lease_epoch).length, 3);

    const outbox1 = new LocalOutboxBuffer({
      projectId: projectAId,
      taskId: task.task_id,
      attemptNo: lease1.attempt_no,
      leaseId: lease1.lease_id,
      leaseEpoch: lease1.lease_epoch,
      workerId: lease1.worker_id,
      sandboxBackend,
    });
    outbox1.enqueueEvent("task.accepted", { step: 1 });

    // Fire Revoke Lease and Worker Event concurrently on the same task lock:
    const revokePromise = coreApi.revokeTaskLease(projectAId, "op-1", {
      task_id: task.task_id,
      lease_id: lease1.lease_id,
      reason: "OPERATOR_PREEMPT_AND_REVOKE",
      requeueTask: true,
    });
    const sendPromise = outbox1.sendOrReplay(gatewayA);

    const [_revokedLease, acks] = await Promise.all([revokePromise, sendPromise]);
    assert.equal(acks[0]?.http_status, 409);
    assert.equal(acks[0]?.ack_status, "REJECTED_STALE_LEASE");
    assert.equal(acks[0]?.error_code, "ERR_STALE_LEASE");

    // Verify LocalOutboxBuffer immediately invoked killAndVerifyClean on receiving 409 ERR_STALE_LEASE
    assert.equal(outbox1.isFenced(), true);
    assert.equal(sandboxBackend.getActivePids(task.task_id, lease1.lease_epoch).length, 0);
    const cleanupEvidence = sandboxBackend.getLastCleanupEvidence(task.task_id, lease1.lease_epoch);
    assert.ok(cleanupEvidence);
    assert.equal(cleanupEvidence.populatedZeroVerified, true);
    assert.deepEqual(cleanupEvidence.killedPids, [50001, 50002, 50003]);

    // Also verify clock_timestamp() expiry during a re-leased attempt (epoch = 2)
    const lease2 = await coreApi.dispatchTaskLease(projectAId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-2",
      heartbeat_interval_ms: 10_000,
      lease_ttl_ms: 30_000,
    });
    assert.equal(lease2.lease_epoch, 2);

    // Advance real-time clock past lease2.expires_at (31s > 30s)
    advanceClockMs(31_000);

    const payload = { late: true };
    const expiredAck = await gatewayA.submitEvent({
      schema_version: "1.5",
      project_id: projectAId,
      task_id: task.task_id,
      attempt_no: lease2.attempt_no,
      lease_id: lease2.lease_id,
      lease_epoch: lease2.lease_epoch,
      worker_id: lease2.worker_id,
      sequence_no: 1,
      event_type: "task.accepted",
      task_execution_idempotency_key: lease2.task_execution_idempotency_key,
      event_idempotency_key: computeEventIdempotencyKey(
        lease2.lease_id,
        lease2.lease_epoch,
        1,
        "task.accepted"
      ),
      payload_sha256: computeCanonicalPayloadSha256(payload),
      emitted_at: new Date().toISOString(),
      payload,
    });
    assert.equal(expiredAck.http_status, 409);
    assert.equal(expiredAck.ack_status, "REJECTED_STALE_LEASE");
    assert.equal(expiredAck.lease_status, "EXPIRED");
  });

  it("Scenario 6: Orphaned Git Push Recovery When Worker Crashes Before Sending task.completed", async () => {
    const { store, coreApi, gatewayA, projectAId, advanceClockMs } = createTestEnvironment();
    const task = await coreApi.createTask(projectAId, "op-1", {
      title: "Recover orphaned staging push",
      task_contract: DEFAULT_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectAId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-crash-after-push",
      heartbeat_interval_ms: 10_000,
      lease_ttl_ms: 30_000,
    });

    // Worker sends task.accepted & task.started
    for (const [seq, evType] of [
      [1, "task.accepted"],
      [2, "task.started"],
    ] as const) {
      const p = { seq };
      const ack = await gatewayA.submitEvent({
        schema_version: "1.5",
        project_id: projectAId,
        task_id: task.task_id,
        attempt_no: lease.attempt_no,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        worker_id: lease.worker_id,
        sequence_no: seq,
        event_type: evType,
        task_execution_idempotency_key: lease.task_execution_idempotency_key,
        event_idempotency_key: computeEventIdempotencyKey(
          lease.lease_id,
          lease.lease_epoch,
          seq,
          evType
        ),
        payload_sha256: computeCanonicalPayloadSha256(p),
        emitted_at: new Date().toISOString(),
        payload: p,
      });
      assert.equal(ack.ack_status, "ACCEPTED");
    }

    // Worker pushes valid commit to refs/heads/sf/staging/<task_id>/<lease_epoch>, then crashes before sending task.completed!
    const stagingRef = `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`;
    const orphanCommit = "7777777777777777777777777777777777777777";
    const orphanTree = "8888888888888888888888888888888888888888";
    const pushRes = await gatewayA.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: stagingRef,
      agent_commit_hash: orphanCommit,
      verified_tree_hash: orphanTree,
      parent_commit_hashes: [INITIAL_MAIN_SHA],
      changes: [
        {
          path: "src/calculator.ts",
          mode: "100644",
          size_bytes: 120,
          added_lines: 10,
          deleted_lines: 0,
          is_binary: false,
          blob_sha: INITIAL_MAIN_SHA,
        },
      ],
    });
    assert.equal(pushRes.allowed, true);

    // Lease expires after 35s
    advanceClockMs(35_000);

    // Run LeaseExpiryReconciler -> detects valid staging push and recovers task to AGENT_COMPLETED!
    const reconciled = await store.runLeaseExpiryAndOrphanedPushReconciler((stagingInfo) => ({
      agent_commit_hash: stagingInfo.agent_commit_hash,
      verified_tree_hash: stagingInfo.verified_tree_hash,
      parent_commit_hashes: stagingInfo.parent_commit_hashes,
      expected_base_main_commit_hash: INITIAL_MAIN_SHA,
      contract: DEFAULT_CONTRACT,
      changes: [
        {
          path: "src/recovered.ts",
          mode: "100644",
          size_bytes: 512,
          is_binary: false,
          added_lines: 20,
          deleted_lines: 0,
          blob_sha: sha256Hex("recovered-blob").slice(0, 40),
        },
      ],
    }));

    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.outcome, "RECOVERED_ORPHANED_PUSH");

    const recoveredTask = await store.withRlsTransaction(
      { currentProjectId: projectAId, currentRole: "core_api_service" },
      () => store.getTaskById(task.task_id)
    );
    assert.equal(recoveredTask?.status, "AGENT_COMPLETED");
  });

  it("Scenario 7: TrustedImportValidator 6-Step Defense (Path Precedence forbidden > protected > allowed > Default Deny, Symlinks 120000, Submodules 160000, Binary/Size & Abnormal Diff)", () => {
    // 1. Precedence check: forbidden > protected > allowed > Default Deny
    const contract: TaskContractSpec = {
      allowed_files: ["src/**"],
      protected_paths: ["src/protected/**"],
      forbidden_paths: ["src/protected/forbidden/**"],
      max_changed_files: 3,
      max_deleted_lines: 50,
    };

    assert.deepEqual(evaluatePathPolicyPrecedence("src/index.ts", contract), {
      allowed: true,
      matchedRule: "src/**",
    });
    assert.deepEqual(evaluatePathPolicyPrecedence("src/protected/auth.ts", contract), {
      allowed: false,
      reason: "PROTECTED_PATH",
      matchedRule: "src/protected/**",
    });
    assert.deepEqual(
      evaluatePathPolicyPrecedence("src/protected/forbidden/key.ts", contract),
      {
        allowed: false,
        reason: "FORBIDDEN_PATH",
        matchedRule: "src/protected/forbidden/**",
      }
    );
    assert.deepEqual(evaluatePathPolicyPrecedence("README.md", contract), {
      allowed: false,
      reason: "DEFAULT_DENY_NOT_IN_ALLOWED_FILES",
    });

    // 2. Reject Symlink (mode 120000)
    const symlinkRes = validateGitTreeImport({
      agent_commit_hash: INITIAL_MAIN_SHA,
      verified_tree_hash: INITIAL_TREE_SHA,
      parent_commit_hashes: [INITIAL_MAIN_SHA],
      expected_base_main_commit_hash: INITIAL_MAIN_SHA,
      contract,
      changes: [
        {
          path: "src/evil-symlink.ts",
          mode: "120000",
          size_bytes: 32,
          is_binary: false,
          added_lines: 1,
          deleted_lines: 0,
          blob_sha: INITIAL_MAIN_SHA,
        },
      ],
    });
    assert.equal(symlinkRes.valid, false);
    if (!symlinkRes.valid) {
      assert.equal(symlinkRes.error_code, "ERR_IMPORT_FORBIDDEN_GIT_MODE");
    }

    // 3. Reject Submodule (mode 160000)
    const submoduleRes = validateGitTreeImport({
      agent_commit_hash: INITIAL_MAIN_SHA,
      verified_tree_hash: INITIAL_TREE_SHA,
      parent_commit_hashes: [INITIAL_MAIN_SHA],
      expected_base_main_commit_hash: INITIAL_MAIN_SHA,
      contract,
      changes: [
        {
          path: "src/submodule",
          mode: "160000",
          size_bytes: 0,
          is_binary: false,
          added_lines: 1,
          deleted_lines: 0,
          blob_sha: INITIAL_MAIN_SHA,
        },
      ],
    });
    assert.equal(submoduleRes.valid, false);
    if (!submoduleRes.valid) {
      assert.equal(submoduleRes.error_code, "ERR_IMPORT_FORBIDDEN_GIT_MODE");
    }

    // 4. Reject Abnormal Diff Threshold (deleted_lines > max_deleted_lines)
    const abnormalDiffRes = validateGitTreeImport({
      agent_commit_hash: INITIAL_MAIN_SHA,
      verified_tree_hash: INITIAL_TREE_SHA,
      parent_commit_hashes: [INITIAL_MAIN_SHA],
      expected_base_main_commit_hash: INITIAL_MAIN_SHA,
      contract,
      changes: [
        {
          path: "src/massive-delete.ts",
          mode: "100644",
          size_bytes: 120,
          is_binary: false,
          added_lines: 1,
          deleted_lines: 500, // > 50!
          blob_sha: INITIAL_MAIN_SHA,
        },
      ],
    });
    assert.equal(abnormalDiffRes.valid, false);
    if (!abnormalDiffRes.valid) {
      assert.equal(abnormalDiffRes.error_code, "ERR_IMPORT_ABNORMAL_DIFF_THRESHOLD");
    }
  });

  it("Scenario 8: 3D Independent Reviewer Guard Rejects Same Provider+Model as Writer (23514 chk_independent_reviewer_model)", async () => {
    const { coreApi, gatewayA, projectAId } = createTestEnvironment();
    const task = await coreApi.createTask(projectAId, "op-1", {
      title: "3D Reviewer independence check",
      task_contract: DEFAULT_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectAId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-1",
    });

    const stagingRef = `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`;
    const agentCommit = "1212121212121212121212121212121212121212";
    const verifiedTree = "3434343434343434343434343434343434343434";
    const candidateHash = "5656565656565656565656565656565656565656";

    await gatewayA.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: stagingRef,
      agent_commit_hash: agentCommit,
      verified_tree_hash: verifiedTree,
      parent_commit_hashes: [INITIAL_MAIN_SHA],
    });

    const { mergeCandidate } = await coreApi.importAndBuildCandidate(projectAId, "op-1", {
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: stagingRef,
      base_main_commit_hash: INITIAL_MAIN_SHA,
      merge_candidate_hash: candidateHash,
      candidate_input: {
        agent_commit_hash: agentCommit,
        verified_tree_hash: verifiedTree,
        parent_commit_hashes: [INITIAL_MAIN_SHA],
        expected_base_main_commit_hash: INITIAL_MAIN_SHA,
        contract: DEFAULT_CONTRACT,
        changes: [
          {
            path: "src/module.ts",
            mode: "100644",
            size_bytes: 200,
            is_binary: false,
            added_lines: 10,
            deleted_lines: 0,
            blob_sha: sha256Hex("module").slice(0, 40),
          },
        ],
      },
    });

    // Attempting to review with identical (writer_provider, writer_model) == (reviewer_provider, reviewer_model) -> rejected 23514!
    await assert.rejects(
      async () =>
        coreApi.recordVerificationAndIndependentReview(projectAId, "op-1", {
          task_id: task.task_id,
          merge_candidate_id: mergeCandidate.merge_candidate_id,
          merge_candidate_hash: candidateHash,
          verified_tree_hash: verifiedTree,
          verifier_image_digest: "sha256:1234",
          verification_verdict: "PASS",
          exit_code: 0,
          duration_ms: 500,
          report_sha256: sha256Hex("ok"),
          writer_provider: "anthropic",
          writer_model: "claude-3-7-sonnet",
          reviewer_provider: "anthropic",
          reviewer_model: "claude-3-7-sonnet", // Self-review forbidden!
          review_verdict: "PASS",
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );
  });

  it("Scenario 9: CAS Conflict When main Advances Mid-Approval -> Invalidates Old Approval, Marks Task NEEDS_REBASE, and Requires Re-Verification + Re-Approval on New Candidate", async () => {
    const { store, coreApi, gatewayA, webConsole, projectAId } = createTestEnvironment();
    const task = await coreApi.createTask(projectAId, "op-1", {
      title: "CAS conflict & candidate re-approval test",
      task_contract: DEFAULT_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectAId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-1",
    });

    const stagingRef = `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`;
    const agentCommit = "aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000";
    const treeV1 = "bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000";
    const candidateHashV1 = "cccc0000cccc0000cccc0000cccc0000cccc0000";

    await gatewayA.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: stagingRef,
      agent_commit_hash: agentCommit,
      verified_tree_hash: treeV1,
      parent_commit_hashes: [INITIAL_MAIN_SHA],
    });

    const { mergeCandidate: mc1 } = await coreApi.importAndBuildCandidate(projectAId, "op-1", {
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: stagingRef,
      base_main_commit_hash: INITIAL_MAIN_SHA,
      merge_candidate_hash: candidateHashV1,
      candidate_input: {
        agent_commit_hash: agentCommit,
        verified_tree_hash: treeV1,
        parent_commit_hashes: [INITIAL_MAIN_SHA],
        expected_base_main_commit_hash: INITIAL_MAIN_SHA,
        contract: DEFAULT_CONTRACT,
        changes: [
          {
            path: "src/app.ts",
            mode: "100644",
            size_bytes: 300,
            is_binary: false,
            added_lines: 12,
            deleted_lines: 1,
            blob_sha: sha256Hex("app-v1").slice(0, 40),
          },
        ],
      },
    });

    const { verificationRun: vr1, reviewArtifact: ra1 } =
      await coreApi.recordVerificationAndIndependentReview(projectAId, "op-1", {
        task_id: task.task_id,
        merge_candidate_id: mc1.merge_candidate_id,
        merge_candidate_hash: mc1.merge_candidate_hash,
        verified_tree_hash: mc1.verified_tree_hash,
        verifier_image_digest: "sha256:verifier-v1",
        verification_verdict: "PASS",
        exit_code: 0,
        duration_ms: 900,
        report_sha256: sha256Hex("vr1"),
        writer_provider: "anthropic",
        writer_model: "claude-3-7-sonnet",
        reviewer_provider: "openai",
        reviewer_model: "gpt-4.1",
        review_verdict: "PASS",
      });

    const approval1 = await webConsole.approveCandidateWith8FieldBinding({
      approverPrincipalId: "approver-1",
      candidate: mc1,
      verificationRun: vr1,
      reviewArtifact: ra1,
    });

    // Another task merges into refs/heads/main BEFORE mc1 executes CAS!
    const newMainSha = "9999000099990000999900009999000099990000";
    store.forceSetMainRefCommitHashForTest(projectAId, newMainSha);

    // Execute CAS Merge -> must detect CAS conflict, invalidate approval1 & ra1, and transition task to NEEDS_REBASE
    const casConflictResult = await coreApi.executeCasMerge(projectAId, "op-1", {
      task_id: task.task_id,
      merge_candidate_id: mc1.merge_candidate_id,
      approval_id: approval1.approval_id,
    });

    assert.equal(casConflictResult.status, "CAS_CONFLICT_NEEDS_REBASE");
    assert.equal(casConflictResult.task_status, "NEEDS_REBASE");
    assert.equal(casConflictResult.invalidated_approval_id, approval1.approval_id);

    const checkInvalidatedApproval = await store.withRlsTransaction(
      { currentProjectId: projectAId, currentRole: "core_api_service" },
      () => store.getApprovalById(approval1.approval_id)
    );
    assert.equal(checkInvalidatedApproval?.status, "INVALIDATED");

    const checkInvalidatedReview = await store.withRlsTransaction(
      { currentProjectId: projectAId, currentRole: "core_api_service" },
      () => store.getReviewArtifactById(ra1.review_artifact_id)
    );
    assert.equal(checkInvalidatedReview?.is_invalidated, true);
  });

  it("Scenario 10: Post-Merge Crash Recovery (Git update-ref Succeeded Before DB Commit Crashed) & Approval TTL Expiry Guard", async () => {
    const {
      store,
      coreApi,
      gatewayA,
      webConsole,
      projectAId,
      advanceClockMs,
    } = createTestEnvironment();

    const task = await coreApi.createTask(projectAId, "op-1", {
      title: "Post-merge reconciler & TTL guard test",
      task_contract: DEFAULT_CONTRACT,
    });
    const lease = await coreApi.dispatchTaskLease(projectAId, "op-1", {
      task_id: task.task_id,
      worker_id: "worker-1",
    });

    const stagingRef = `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`;
    const agentCommit = "eeee1111eeee1111eeee1111eeee1111eeee1111";
    const verifiedTree = "ffff2222ffff2222ffff2222ffff2222ffff2222";
    const candidateHash = "abcd3333abcd3333abcd3333abcd3333abcd3333";

    await gatewayA.authorizeAndPushStagingRef({
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: stagingRef,
      agent_commit_hash: agentCommit,
      verified_tree_hash: verifiedTree,
      parent_commit_hashes: [INITIAL_MAIN_SHA],
    });

    const { mergeCandidate } = await coreApi.importAndBuildCandidate(projectAId, "op-1", {
      task_id: task.task_id,
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: stagingRef,
      base_main_commit_hash: INITIAL_MAIN_SHA,
      merge_candidate_hash: candidateHash,
      candidate_input: {
        agent_commit_hash: agentCommit,
        verified_tree_hash: verifiedTree,
        parent_commit_hashes: [INITIAL_MAIN_SHA],
        expected_base_main_commit_hash: INITIAL_MAIN_SHA,
        contract: DEFAULT_CONTRACT,
        changes: [
          {
            path: "src/reconcile.ts",
            mode: "100644",
            size_bytes: 400,
            is_binary: false,
            added_lines: 18,
            deleted_lines: 0,
            blob_sha: sha256Hex("reconcile").slice(0, 40),
          },
        ],
      },
    });

    const { verificationRun, reviewArtifact } =
      await coreApi.recordVerificationAndIndependentReview(projectAId, "op-1", {
        task_id: task.task_id,
        merge_candidate_id: mergeCandidate.merge_candidate_id,
        merge_candidate_hash: candidateHash,
        verified_tree_hash: verifiedTree,
        verifier_image_digest: "sha256:verifier-v2",
        verification_verdict: "PASS",
        exit_code: 0,
        duration_ms: 700,
        report_sha256: sha256Hex("vr2"),
        writer_provider: "anthropic",
        writer_model: "claude-3-7-sonnet",
        reviewer_provider: "openai",
        reviewer_model: "gpt-4.1",
        review_verdict: "PASS",
      });

    // Part A: Approval with 60s TTL that expires before CAS Merge -> returns APPROVAL_EXPIRED
    const shortApproval = await webConsole.approveCandidateWith8FieldBinding({
      approverPrincipalId: "approver-1",
      candidate: mergeCandidate,
      verificationRun,
      reviewArtifact,
      ttlMs: 60_000,
    });
    advanceClockMs(61_000);

    const expiredMergeAttempt = await coreApi.executeCasMerge(projectAId, "op-1", {
      task_id: task.task_id,
      merge_candidate_id: mergeCandidate.merge_candidate_id,
      approval_id: shortApproval.approval_id,
    });
    assert.equal(expiredMergeAttempt.status, "APPROVAL_EXPIRED");
    assert.equal(expiredMergeAttempt.task_status, "REVIEWED_PASS");

    // Part B: Issue fresh approval, then simulate crash AFTER `git update-ref refs/heads/main <candidateHash>` succeeded
    const freshApproval = await webConsole.approveCandidateWith8FieldBinding({
      approverPrincipalId: "approver-1",
      candidate: mergeCandidate,
      verificationRun,
      reviewArtifact,
      ttlMs: 3_600_000,
    });

    // Simulate that Git `refs/heads/main` was already updated to `candidateHash` before DB transaction crashed
    store.forceSetMainRefCommitHashForTest(projectAId, candidateHash);

    // Retry executeCasMerge -> Post-Merge Reconciler detects `currentMainSha === candidateHash` and reconciles DB to MERGED!
    const reconciledMerge = await coreApi.executeCasMerge(projectAId, "op-1", {
      task_id: task.task_id,
      merge_candidate_id: mergeCandidate.merge_candidate_id,
      approval_id: freshApproval.approval_id,
    });
    assert.equal(reconciledMerge.status, "RECONCILED_ALREADY_MERGED");
    assert.equal(reconciledMerge.task_status, "MERGED");
    assert.equal(reconciledMerge.merged_commit_hash, candidateHash);
  });
});
