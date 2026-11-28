import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  buildPostgresPoolConfigFromEnv,
  PostgresControlPlaneRepository,
  PostgresRuntimePool,
  SoftwareFactoryControlPlaneStore,
} from "../src/index.ts";

const project = "10000000-0000-0000-0000-000000000291";
const session = "20000000-0000-0000-0000-000000000291";
const otherSession = "20000000-0000-0000-0000-000000000292";
const task = "30000000-0000-0000-0000-000000000291";
const context = {
  currentProjectId: project,
  currentRole: "system_admin_role",
  currentPrincipalId: "fixture",
};
const otherContext = { ...context, currentPrincipalId: "other" };

async function fixture(store = new SoftwareFactoryControlPlaneStore(), fixtureIds = { project, task, session, otherSession }) {
  const { project, task, session, otherSession } = fixtureIds;
  const admin = { ...context, currentProjectId: project };
  const scope = { ...admin, currentRole: "core_api_service" };
  await store.withRlsTransaction(admin, () => store.createProject({
      project_id: project,
      slug: `probe-${project}`,
      name: "Probe",
      repo_bare_path: "/unused",
      initial_main_commit_hash: "a".repeat(40),
  }));
  await store.withRlsTransaction(scope, async () => {
    await store.createTask({
      project_id: project,
      task_id: task,
      title: "Probe",
      task_contract: {},
      base_main_commit_hash: "a".repeat(40),
    });
    for (const costSessionId of [session, otherSession]) {
      await store.createCostSession({
        project_id: project,
        cost_session_id: costSessionId,
        task_id: task,
        max_tokens_per_request: 10,
        max_cost_micro_usd_per_request: 10,
        session_token_budget: 10,
        session_cost_budget_micro_usd: 10,
      });
    }
  });
  const finalize = (amount, sessionId = session) => store.finalizeModelCallLedger({
    project_id: project,
    cost_session_id: sessionId,
    stage: "probe",
    provider: "anthropic",
    model: "fixture",
    prompt_id: "probe",
    prompt_version: "1",
    prompt_sha256: "a".repeat(64),
    request_sha256: "b".repeat(64),
    estimated_input_tokens: 1,
    reserved_output_tokens: 0,
    actual_input_tokens: amount,
    actual_output_tokens: 0,
    estimated_cost_micro_usd: 1,
    actual_cost_micro_usd: amount,
    outcome: "ALLOWED",
    latency_ms: 0,
  });
  return { store, finalize, scope, session };
}

function snapshot(store, scope = context, costSessionId = session) {
  return store.withRlsTransaction(scope, async () => {
    const row = await store.getCostSession(costSessionId);
    const ledgers = await store.listModelCallLedgers({ cost_session_id: costSessionId });
    return {
      totals: [row.tokens_used_total, row.cost_used_micro_usd],
      actuals: ledgers.map(ledger => ledger.actual_cost_micro_usd).sort(),
    };
  });
}

async function verifyInterleaving({ store, finalize, scope, session }, commit, waitForSecond) {
  const staged = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const rollback = new Error("fixture rollback");
  const first = store.withRlsTransaction(scope, async () => {
    await finalize(1);
    staged.resolve();
    await finish.promise;
    if (!commit) throw rollback;
  });
  await Promise.race([staged.promise, first]);

  let secondFinished = false;
  const second = store.withRlsTransaction({ ...scope, currentPrincipalId: "other" }, () => finalize(2)).then(() => {
    secondFinished = true;
  });
  try {
    await waitForSecond();
    assert.equal(secondFinished, false);
  } finally {
    finish.resolve();
    if (commit) await first;
    else await assert.rejects(first, error => error === rollback);
    await second;
  }
  assert.deepEqual(await snapshot(store, scope, session), commit
    ? { totals: [3, 3], actuals: [1, 2] }
    : { totals: [2, 2], actuals: [2] });
}

const pgConfig = buildPostgresPoolConfigFromEnv();
for (const commit of [false, true]) {
  const outcome = commit ? "commit" : "roll back";
  test(`memory waits for the first finalize transaction to ${outcome}`, { timeout: 3000 }, async () => {
    await verifyInterleaving(await fixture(), commit, () => new Promise(resolve => setImmediate(resolve)));
  });
  test(`PostgreSQL waits for the first finalize transaction to ${outcome}`,
    { skip: !pgConfig && "PostgreSQL connection required", timeout: 10000 }, async () => {
      const pool = new PostgresRuntimePool(pgConfig);
      try {
        const ids = { project: randomUUID(), task: randomUUID(), session: randomUUID(), otherSession: randomUUID() };
        const pg = await fixture(new PostgresControlPlaneRepository(pool), ids);
        await verifyInterleaving(pg, commit, () => new Promise(resolve => setTimeout(resolve, 100)));
      } finally {
        await pool.close();
      }
    });
}

test("nested calls in the same transaction reuse the cost-session lock", { timeout: 3000 }, async () => {
  const { store, finalize } = await fixture();
  await store.withRlsTransaction(context, async () => {
    await finalize(1);
    await store.withRlsTransaction(context, () => finalize(2));
  });
  assert.deepEqual(await snapshot(store), { totals: [3, 3], actuals: [1, 2] });
});

test("a different cost session can finalize while the owner is still open", { timeout: 3000 }, async () => {
  const { store, finalize } = await fixture();
  const staged = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const first = store.withRlsTransaction(context, async () => {
    await finalize(1);
    staged.resolve();
    await finish.promise;
  });
  await Promise.race([staged.promise, first]);
  try {
    const result = await store.withRlsTransaction(otherContext, () => finalize(2, otherSession));
    assert.equal(result.session.cost_used_micro_usd, 2);
  } finally {
    finish.resolve();
    await first;
  }
});

test("an error inside finalize releases the lock on rollback", { timeout: 3000 }, async () => {
  const { store, finalize } = await fixture();
  const clockError = new Error("fixture clock failure");
  store.setClock(() => { throw clockError; });
  await assert.rejects(store.withRlsTransaction(context, () => finalize(1)), error => error === clockError);
  store.setClock(() => new Date());
  await store.withRlsTransaction(context, () => finalize(2));
  assert.deepEqual(await snapshot(store), { totals: [2, 2], actuals: [2] });
});
