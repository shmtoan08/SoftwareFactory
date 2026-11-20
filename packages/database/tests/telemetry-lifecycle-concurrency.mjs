// Real PostgreSQL serialization for idempotent enrollment and event sequencing.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
const database = `sf_m6c3_a_lifecycle_${suffix}`;
const role = `sf_lifecycle_${suffix}`;
const source = process.env.PGDATABASE;
assert(source, 'PGDATABASE must identify the migrated test database');
const project = '10000000-0000-0000-0000-000000000245';
const task = '20000000-0000-0000-0000-000000000245';
const manifest = '30000000-0000-0000-0000-000000000245';
const lifecycle = '40000000-0000-0000-0000-000000000245';
const sql = text => execFileSync('psql', ['-X','-At','-v','ON_ERROR_STOP=1','-d',database], { input:text, encoding:'utf8', timeout:15000 });
const children = new Set();
function client(name) {
  const child=spawn('psql',['-X','-At','-v','ON_ERROR_STOP=1','-d',database],{env:{...process.env,PGAPPNAME:name},stdio:['pipe','pipe','pipe']});
  children.add(child); let output=''; let errors=''; child.stdout.on('data',x=>output+=String(x)); child.stderr.on('data',x=>errors+=String(x));
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{children.delete(child);code===0?resolve(output):reject(new Error(errors));});}); done.catch(()=>{});
  return {child,done,output:()=>output};
}
async function until(check,message){const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw new Error(message);await new Promise(r=>setTimeout(r,25));}}
const auth=`SET SESSION AUTHORIZATION ${role}; SET ROLE telemetry_operator;\n`;
const open=`SELECT disposition FROM telemetry.open_lifecycle('${project}','${task}','${manifest}','${lifecycle}',repeat('a',64),'1','S',1,1,false,false,false,false,false,repeat('b',40),'1');\n`;
let created=false;
try {
  execFileSync('createdb',['--maintenance-db',source,'--template',source,database],{timeout:15000}); created=true;
  sql(`CREATE ROLE ${role} LOGIN NOINHERIT; GRANT telemetry_operator TO ${role};
    INSERT INTO public.projects(project_id,slug,name,repo_bare_path) VALUES('${project}','c2-concurrent','fixture','/unused');
    INSERT INTO public.tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash) VALUES('${task}','${project}','fixture','{}','Ready',repeat('a',40));
    INSERT INTO telemetry.service_projects SELECT oid,rolname,'${project}','operator' FROM pg_roles WHERE rolname='${role}';`);
  const holder=client(`open_holder_${suffix}`); holder.child.stdin.write(`BEGIN;\n${auth}SELECT pg_advisory_xact_lock(hashtextextended('${project}:${task}',2401));\n\\echo lock_ready\n`);
  await until(()=>holder.output().includes('lock_ready'),'Enrollment lock not held');
  const waiter=client(`open_waiter_${suffix}`); waiter.child.stdin.end(`${auth}${open}`);
  await until(()=>sql(`SELECT count(*) FROM pg_stat_activity WHERE datname='${database}' AND application_name='open_waiter_${suffix}' AND wait_event_type='Lock';`).trim()==='1','Concurrent enrollment did not wait');
  holder.child.stdin.end(`${open}COMMIT;\n`); assert((await holder.done).includes('recorded')); assert((await waiter.done).includes('duplicate'));

  const eventHolder=client(`event_holder_${suffix}`); eventHolder.child.stdin.write(`BEGIN;\n${auth}SELECT pg_advisory_xact_lock(hashtextextended('${project}:${lifecycle}',2402));\n\\echo lock_ready\n`);
  await until(()=>eventHolder.output().includes('lock_ready'),'Event lock not held');
  const eventWaiter=client(`event_waiter_${suffix}`); eventWaiter.child.stdin.end(`${auth}SELECT sequence FROM telemetry.append_lifecycle_event('${project}','${lifecycle}','50000000-0000-0000-0000-000000000246','AMEND',NULL);\n`);
  await until(()=>sql(`SELECT count(*) FROM pg_stat_activity WHERE datname='${database}' AND application_name='event_waiter_${suffix}' AND wait_event_type='Lock';`).trim()==='1','Concurrent event did not wait');
  eventHolder.child.stdin.end(`SELECT sequence FROM telemetry.append_lifecycle_event('${project}','${lifecycle}','50000000-0000-0000-0000-000000000245','AMEND',NULL);\nCOMMIT;\n`);
  assert((await eventHolder.done).split('\n').includes('2')); assert((await eventWaiter.done).split('\n').includes('3'));
  assert.equal(sql(`SELECT count(*) FROM telemetry.lifecycle_events WHERE lifecycle_id='${lifecycle}' AND prior_sequence=sequence-1;`).trim(),'2');
  console.log('Concurrent lifecycle enrollment and event sequencing PASS.');
} finally {
  for(const child of children) child.kill('SIGTERM');
  if(created) execFileSync('dropdb',['--maintenance-db',source,'--force',database],{timeout:15000});
  execFileSync('psql',['-X','-v','ON_ERROR_STOP=1','-d',source],{input:`DROP ROLE IF EXISTS ${role};`,stdio:['pipe','pipe','pipe'],timeout:15000});
}
