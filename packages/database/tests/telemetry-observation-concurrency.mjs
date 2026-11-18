// Real PostgreSQL committed concurrent delivery. Clone only the test database;
// all service credentials/fixtures live in that disposable clone.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
const database = `sf_m6c3_a_t1_${suffix}`;
const role = `sf_t1_writer_${suffix}`;
const settlementMode = process.argv.includes('--settlements');
const source = process.env.PGDATABASE;
assert(source, 'PGDATABASE must identify the migrated test database');
const project = '10000000-0000-0000-0000-000000000049';
const invocation = '30000000-0000-0000-0000-000000000049';
const sql = (text) => execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', database], { input: text, encoding: 'utf8', timeout: 15000 });
const children = new Set();
function client(application) {
  const child = spawn('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', database], { env: { ...process.env, PGAPPNAME: application }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { children.delete(child); code === 0 ? resolve(output) : reject(new Error(`psql exited ${code}: ${errors}`)); });
  });
  // A failing peer may exit while the test waits for the other one.
  done.catch(() => {});
  return { child, done, output: () => output };
}
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const auth = `SET SESSION AUTHORIZATION ${role}; SET ROLE telemetry_ingestor;\n`;
const append = (revision, count) => `SELECT disposition FROM telemetry.append_unverified_usage('${project}','${invocation}','USAGE',${revision},'{"input_tokens":"${count}"}');\n`;
const callId = n => `30000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ledgerId = n => `40000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const link = (call, ledger) => `SELECT disposition FROM telemetry.link_ledger('${project}','${callId(call)}','${ledgerId(ledger)}');\n`;
let created = false;
let provisioned = false;
try {
  execFileSync('createdb', ['--maintenance-db', source, '--template', source, database], { timeout: 15000 });
  created = true;
  sql(`BEGIN;
    CREATE ROLE ${role} LOGIN NOINHERIT; GRANT telemetry_ingestor TO ${role};
    INSERT INTO public.projects(project_id,slug,name,repo_bare_path) VALUES('${project}','a4-concurrent','fixture','/unused');
    INSERT INTO public.model_cost_sessions(cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,session_token_budget,session_cost_budget_micro_usd)
      VALUES('20000000-0000-0000-0000-000000000049','${project}',10,10,100,100);
    INSERT INTO telemetry.service_projects SELECT oid,rolname,'${project}','ingest' FROM pg_roles WHERE rolname='${role}';
    COMMIT;
    ${auth}
    SELECT telemetry.register_call('${invocation}','${project}','20000000-0000-0000-0000-000000000049',NULL,NULL,'anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED');`);
  provisioned = true;
  if (settlementMode) {
    sql(`INSERT INTO public.model_call_ledgers(call_id,project_id,cost_session_id,stage,provider,model,prompt_id,prompt_version,prompt_sha256,request_sha256,estimated_input_tokens,reserved_output_tokens,estimated_cost_micro_usd,status)
      SELECT ('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'${project}','20000000-0000-0000-0000-000000000049','fixture','anthropic','fixture','fixture','1',repeat('a',64),repeat('b',64),0,0,0,'ALLOWED' FROM generate_series(49,52) n;
      ${auth}
      SELECT telemetry.register_call(('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'${project}','20000000-0000-0000-0000-000000000049',NULL,NULL,'anthropic','fixture','fixture','1',repeat('a',64),'1','UNVERIFIED') FROM generate_series(50,52) n;`);
  }
  const scenarios = settlementMode
    ? [[link(49,49),link(49,49),'duplicate'],[link(50,50),link(50,51),'conflict'],[link(51,52),link(52,52),'conflict']]
    : [[append(1,'1'),append(1,'1'),'duplicate'],[append(2,'1'),append(2,'2'),'conflict']];
  for (const [first, second, expected] of scenarios) {
    const holder = client(`holder_${suffix}`);
    holder.child.stdin.write(`BEGIN;\n${auth}${first}\\echo receipt_ready\n`);
    await until(() => holder.output().includes('receipt_ready'), 'First receipt was not held uncommitted');
    const waiterName = `waiter_${suffix}`;
    const waiter = client(waiterName);
    waiter.child.stdin.end(`${auth}${second}`);
    await until(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE datname='${database}' AND application_name='${waiterName}' AND wait_event_type='Lock';`).trim() === '1', 'Second delivery did not contend on the uncommitted receipt');
    holder.child.stdin.end('COMMIT;\n');
    await holder.done;
    const result = await waiter.done;
    assert(result.split('\n').includes(expected), `Expected ${expected}, received ${result}`);
  }
  if (settlementMode) {
    assert.equal(sql(`SELECT count(*) FROM telemetry.settlements WHERE project_id='${project}';`).trim(), '3');
    assert.equal(sql(`SELECT count(*) FROM telemetry.quality_events WHERE project_id='${project}';`).trim(), '2');
    assert.equal(sql(`SELECT count(*) FROM telemetry.settlements WHERE invocation_id='${callId(52)}';`).trim(), '0');
    assert.equal(sql(`SELECT ledger_call_id FROM telemetry.settlements WHERE invocation_id='${callId(50)}';`).trim(), ledgerId(50));
    console.log('Concurrent settlement duplicate/invocation-conflict/ledger-reuse PASS; first links and committed markers retained.');
  } else {
    assert.equal(sql(`SELECT count(*) FROM telemetry.observations WHERE project_id='${project}';`).trim(), '2');
    assert.equal(sql(`SELECT count(*) FROM telemetry.quality_events WHERE project_id='${project}';`).trim(), '1');
    assert.equal(sql(`SELECT count(*) FROM telemetry.observations WHERE project_id='${project}' AND numeric_usage->>'input_tokens'='1' AND canonical_total IS NULL;`).trim(), '2');
    console.log('Concurrent identical/conflicting delivery PASS; committed conflict marker retained, first receipts unchanged.');
  }
} finally {
  for (const child of children) child.kill('SIGTERM');
  if (created) execFileSync('dropdb', ['--maintenance-db', source, '--force', database], { timeout: 15000 });
  // Check existence as setup may have committed before its later assertion failed.
  if (created || provisioned) execFileSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', source], { input: `DROP ROLE IF EXISTS ${role};`, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
}
