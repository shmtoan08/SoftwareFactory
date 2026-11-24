import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const source = process.env.PGDATABASE;
assert(source);
const database = `sf_m6c3_a_dispatch_${randomBytes(8).toString("hex")}`;
const args = ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", database];
const sql = (input) => execFileSync("psql", args, { input, encoding: "utf8", timeout: 10000 });
const project = "10000000-0000-0000-0000-000000000291";
const task = "30000000-0000-0000-0000-000000000291";
const lease = "40000000-0000-0000-0000-000000000291";
const reservation = "70000000-0000-0000-0000-000000000296";
const start = `SELECT telemetry.start_dispatch_attempt('${project}','80000000-0000-0000-0000-000000000296','${lease}',1);`;
const writer = "SET SESSION AUTHORIZATION sf_dispatch_writer_fixture; SET ROLE telemetry_dispatch_writer;";
const recovery = "SET SESSION AUTHORIZATION sf_dispatch_recovery_fixture; SET ROLE telemetry_dispatch_recovery;";
const release = `SELECT telemetry.release_expired_dispatch_reservation('${project}','${reservation}');`;
const update = `UPDATE public.tasks SET active_lease_epoch=2 WHERE task_id='${task}';`;

let seeded = false;
let holder;
let created = false;
async function occupy(statement) {
  holder = spawn("psql", args, { stdio: ["pipe", "pipe", "inherit"] });
  let output = "";
  holder.stdout.on("data", chunk => { output += chunk; });
  const closed = once(holder, "close");
  holder.stdin.write(`BEGIN;\n${statement}\n\\echo lock_ready\n`);
  const deadline = Date.now() + 8000;
  while (!output.includes("lock_ready")) {
    assert(holder.exitCode === null && Date.now() < deadline, "Holder failed to acquire lock");
    await delay(20);
  }
  return async (end) => {
    holder.stdin.end(`${end};\n`);
    assert.equal((await closed)[0], 0);
    holder = undefined;
  };
}

function expectState(setup, statement, condition) {
  sql(`${setup}
DO $$ BEGIN
 BEGIN ${statement}
  RAISE EXCEPTION 'Expected PostgreSQL rejection';
 EXCEPTION WHEN ${condition} THEN NULL;
 END;
END $$;`);
}

try {
  execFileSync("createdb", ["--maintenance-db", source, "--template", source, database], { timeout: 15000 });
  created = true;
  execFileSync("psql", [...args, "-v", "dispatch_concurrency_seed=1", "-f",
    fileURLToPath(new URL("./telemetry-dispatch-recovery.sql", import.meta.url))], { timeout: 15000 });
  seeded = true;

  const releaseTaskLock = await occupy(`SELECT 1 FROM public.tasks WHERE task_id='${task}' FOR UPDATE;`);
  expectState(writer, start.replace("SELECT ", "PERFORM "), "lock_not_available");
  await releaseTaskLock("ROLLBACK");

  const finishStart = await occupy(`${writer}\n${start}`);
  expectState(recovery, release.replace("SELECT ", "PERFORM "), "lock_not_available");
  expectState("SET lock_timeout='150ms';", update, "lock_not_available");
  await finishStart("COMMIT");

  expectState(`BEGIN ISOLATION LEVEL REPEATABLE READ; ${recovery}`, release.replace("SELECT ", "PERFORM "), "invalid_parameter_value");
  sql(update);
  expectState(writer, start.replace("SELECT ", "PERFORM "), "check_violation");
  assert.equal(sql("SELECT count(*) FROM telemetry.dispatch_events WHERE attempt_id='80000000-0000-0000-0000-000000000296' AND kind='DISPATCH_STARTED';").trim(), "1");
  console.log("Dispatch fence row-lock, reservation contention and stale generation checks passed.");
} finally {
  holder?.kill("SIGTERM");
  if (created) execFileSync("dropdb", ["--maintenance-db", source, "--force", database], { timeout: 15000 });
  if (seeded) execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", source], {
    input: "DROP ROLE sf_dispatch_writer_fixture, sf_dispatch_recovery_fixture;", timeout: 10000,
  });
}
