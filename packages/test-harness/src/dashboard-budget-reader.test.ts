import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { CoreApiService, CoreApiHttpServer, CORE_API_AUTH_HEADER, encodeCoreApiAuthHeader, ReadProjectionError } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore, PostgresControlPlaneRepository, PostgresRuntimePool, buildPostgresPoolConfigFromEnv, type ControlPlaneStore, type ProjectMemberRole } from "@software-factory/database";
import { contents, catalog } from "./dashboard-read-test-support.ts";

const roles: ProjectMemberRole[] = ["AUDITOR", "DEVELOPER", "PROJECT_APPROVER", "ORG_ADMIN"];
async function fixture(store: ControlPlaneStore) {
  const a = randomUUID(), b = randomUUID();
  for (const id of [a,b]) await store.withRlsTransaction({currentProjectId:id,currentRole:"system_admin_role"},async()=>{
    await store.createProject({project_id:id,slug:`budget-reader-${id}`,name:"Budget source",repo_bare_path:"/private/budget-never-expose.git",initial_main_commit_hash:"a".repeat(40)});
    for(const role of roles)await store.addProjectMembership({project_id:id,principal_id:role,member_role:role});
  });
  const core=new CoreApiService(store);
  const auth=(role:ProjectMemberRole="AUDITOR",projectId=a,principalId:string=role)=>core.issueAuthContext({projectId,principalId,roles:[role]});
  const scope={currentProjectId:a,currentPrincipalId:"ORG_ADMIN",currentRole:"core_api_service" as const};
  return {store,core,a,b,auth,scope};
}
type Fx=Awaited<ReturnType<typeof fixture>>;
async function seed(fx:Fx, projectId=fx.a) {
  await fx.store.withRlsTransaction({...fx.scope,currentProjectId:projectId},async()=>{
    const task=await fx.store.createTask({project_id:projectId,title:"Budget metric fixture",task_contract:{allowed_files:["src/**"]}});
    const session=await fx.store.createCostSession({project_id:projectId,max_tokens_per_request:10000,max_cost_micro_usd_per_request:10000,session_token_budget:100000,session_cost_budget_micro_usd:100000});
    for(const [tokens,cost,outcome,estimated] of [[10,2,"ALLOWED",false],[4,3,"FAILED_PROVIDER",true]] as const){
      await fx.store.finalizeModelCallLedger({project_id:projectId,cost_session_id:session.cost_session_id,task_id:task.task_id,stage:"budget-fixture",provider:"openai",model:"provider-free-fixture",prompt_id:"budget",prompt_version:"1",prompt_sha256:"b".repeat(64),request_sha256:randomUUID().replaceAll("-","").repeat(2),estimated_input_tokens:1,reserved_output_tokens:0,estimated_cost_micro_usd:1000,actual_input_tokens:tokens,actual_output_tokens:0,actual_cost_micro_usd:cost,outcome,usage_estimated:estimated,latency_ms:1});
    }
    for(const wall of [7,9])await fx.store.recordResourceUsageMetric({project_id:projectId,task_id:task.task_id,lease_epoch:0,attempt_no:1,phase:"DEVELOPER",wall_time_ms:wall,cpu_usage_usec:1,peak_memory_bytes:1,sandbox_backend_mode:"fixture",metrics_source:"wall-clock-only"});
    await fx.store.upsertProjectBudgetPolicy({project_id:projectId,max_project_tokens:12,max_project_cost_micro_usd:null,max_project_wall_time_ms:10});
  });
}
function snapshot(store:SoftwareFactoryControlPlaneStore) {
  return JSON.stringify(Object.entries(store).filter(([,v])=>v instanceof Map),(_k,v:unknown)=>v instanceof Map?[...v]:v);
}
async function expectError(p:Promise<unknown>,status:number){await assert.rejects(p,(e:unknown)=>e instanceof ReadProjectionError&&e.httpStatus===status);}
async function contract(fx:Fx, recovery:"clear"|"unknown") {
  const server=new CoreApiHttpServer({coreApi:fx.core});const endpoint=await server.start();
  const get=async(path=`/${fx.a}/budget-snapshot`,auth:ReturnType<Fx["auth"]>|null=fx.auth(),raw?:string)=>{
    const res=await fetch(`${endpoint.baseUrl}/api/v1/projects${path}`,{headers:raw?{[CORE_API_AUTH_HEADER]:raw}:auth?{[CORE_API_AUTH_HEADER]:encodeCoreApiAuthHeader(auth)}:{}});
    return {status:res.status,body:await res.json() as Record<string,any>};
  };
  try{
    for(const role of roles){
      const res=await get(undefined,fx.auth(role));assert.equal(res.status,200);
      assert.deepEqual(Object.keys(res.body).sort(),["schemaVersion","fetchedAt","projectId","policy","dimensions","estimatedModelUsageIncluded","recoveryState","recoveryReason","recoveryScope","usageSemantics"].sort());
      assert.equal(res.body.schemaVersion,"dashboard-read-v1");assert.equal(res.body.projectId,fx.a);assert.match(res.body.fetchedAt,/\.\d{6}Z$/);
      assert.equal(res.body.recoveryState,recovery);assert.equal(res.body.recoveryReason,recovery==="clear"?"no-visible-pending-intent":"journal-not-modeled");
      assert.equal(res.body.recoveryScope,"visible-project-budget-denial-intents-at-snapshot");assert.equal(res.body.usageSemantics,"recorded-project-ledgers-and-resource-metrics");
      assert.deepEqual(res.body.policy&&Object.keys(res.body.policy).sort(),["status","updatedAt"]);assert.equal(res.body.policy.status,"ACTIVE");
      assert.deepEqual(res.body.dimensions.tokens,{unit:"tokens",limitKind:"configured",limit:"12",consumed:"14",remaining:"-2"});
      assert.deepEqual(res.body.dimensions.costMicroUsd,{unit:"micro_usd",limitKind:"unbounded",limit:null,consumed:"5",remaining:null});
      assert.deepEqual(res.body.dimensions.wallTimeMs,{unit:"milliseconds",limitKind:"configured",limit:"10",consumed:"16",remaining:"-6"});
      assert.equal(res.body.estimatedModelUsageIncluded,true);assert.doesNotMatch(JSON.stringify(res.body),/never-expose|prompt_sha256|task_policies|task_usage|events/);
    }
    for(const query of ["?limit=1","?cursor=a","?projectId=x","?stage=1","?limit=1&limit=2"]){const r=await get(`/${fx.a}/budget-snapshot${query}`);assert.equal(r.status,400);assert.deepEqual(r.body,{error_code:"ERR_READ_QUERY_INVALID"});}
    assert.equal((await get(undefined,null)).status,401);assert.equal((await get(undefined,null,"invalid-header")).status,401);
    assert.equal((await get(`/${fx.b}/budget-snapshot`)).status,403);
    assert.equal((await get(undefined,fx.auth("AUDITOR",fx.a,"non-member"))).status,403);
    assert.equal((await get(undefined,fx.auth("ORG_ADMIN",fx.a,"AUDITOR"))).status,403);
    const empty=await get(`/${fx.b}/budget-snapshot`,fx.auth("AUDITOR",fx.b));assert.equal(empty.status,200);assert.equal(empty.body.policy,null);
    for(const dim of Object.values(empty.body.dimensions) as Record<string,unknown>[]){assert.equal(dim.limitKind,"policy-absent");assert.equal(dim.consumed,"0");assert.equal(dim.remaining,null);}
    assert.equal(empty.body.estimatedModelUsageIncluded,false);
    const encoded=await get("/%ZZ/budget-snapshot");assert.equal(encoded.status,400);
  }finally{await server.stop();}
}

describe("Dashboard P2 Budget snapshot — memory",()=>{
  it("enforces HTTP/auth/DTO/exact arithmetic contract and honestly reports missing memory journal",async()=>{
    const fx=await fixture(new SoftwareFactoryControlPlaneStore());await seed(fx);await contract(fx,"unknown");
  });
  it("does not mutate any memory map, nested value or legacy/recovery path on success or failure",async()=>{
    const store=new SoftwareFactoryControlPlaneStore();const fx=await fixture(store);await seed(fx);
    const before=snapshot(store);const session=structuredClone(store.getCurrentRlsSession());
    const fail=()=>{throw new Error("forbidden private command");};
    store.withRlsTransaction=fail;store.getProjectMembership=fail;store.getProjectById=fail;store.getProjectBudgetSnapshot=fail;
    const result=await fx.core.readBudgetProjection(fx.auth(),fx.a);result.dimensions.tokens.consumed="0";if(result.policy)result.policy.status="AUTO_PAUSED";
    await expectError(fx.core.readBudgetProjection(fx.auth(),fx.a,new URLSearchParams("limit=1")),400);
    assert.equal(snapshot(store),before);assert.deepEqual(store.getCurrentRlsSession(),session);
    await assert.rejects(store.readBudgetProjection({projectId:fx.a,principalId:"AUDITOR",signedRoles:["AUDITOR"],deadlineAt:Date.now()-1}));assert.equal(snapshot(store),before);
  });
  it("distinguishes no policy, null limits and exact aggregate beyond safe integer; rejects corrupt numeric samples",async()=>{
    const store=new SoftwareFactoryControlPlaneStore();const fx=await fixture(store);
    const empty=await fx.core.readBudgetProjection(fx.auth(),fx.a);assert.equal(empty.policy,null);assert.equal(empty.dimensions.tokens.limitKind,"policy-absent");assert.equal(empty.dimensions.tokens.consumed,"0");assert.equal(empty.estimatedModelUsageIncluded,false);
    await seed(fx);
    const backing=store as unknown as {modelCallLedgers:Map<string,{project_id:string;actual_total_tokens:number;actual_cost_micro_usd:number;usage_estimated:boolean}>};
    for(let i=0;i<3;i++)backing.modelCallLedgers.set(randomUUID(),{project_id:fx.a,actual_total_tokens:Number.MAX_SAFE_INTEGER,actual_cost_micro_usd:0,usage_estimated:false});
    const exact=await fx.core.readBudgetProjection(fx.auth(),fx.a);assert.equal(exact.dimensions.tokens.consumed,(14n+3n*BigInt(Number.MAX_SAFE_INTEGER)).toString());
    const id=randomUUID();backing.modelCallLedgers.set(id,{project_id:fx.a,actual_total_tokens:Number.MAX_SAFE_INTEGER+1,actual_cost_micro_usd:0,usage_estimated:false});
    const before=snapshot(store);await expectError(fx.core.readBudgetProjection(fx.auth(),fx.a),500);assert.equal(snapshot(store),before);
    backing.modelCallLedgers.delete(id);
  });
  it("rejects nested reads and invalid source fields with generic errors and no fallback clear",async()=>{
    const store=new SoftwareFactoryControlPlaneStore();const fx=await fixture(store);await seed(fx);
    await store.withRlsTransaction(fx.scope,async()=>expectError(fx.core.readBudgetProjection(fx.auth(),fx.a),500));
    const read=store.readBudgetProjection.bind(store);const rows=await read({projectId:fx.a,principalId:"AUDITOR",signedRoles:["AUDITOR"],deadlineAt:Date.now()+5000});
    for(const bad of [{...rows,projectId:fx.b},{...rows,usage:{...rows.usage,costMicroUsd:"1e6"}},{...rows,policy:{...rows.policy!,tokens:"0"}},{...rows,policy:{...rows.policy!,tokens:undefined as unknown as string}},{...rows,policy:{...rows.policy!,updatedAt:"PRIVATE_DETAIL"}}]){
      store.readBudgetProjection=async()=>bad;await expectError(fx.core.readBudgetProjection(fx.auth(),fx.a),500);
    }
  });
});

const config=buildPostgresPoolConfigFromEnv();
async function denial(pool:PostgresRuntimePool,fx:Fx,project=fx.a) {
  await pool.withRlsTransaction({...fx.scope,currentProjectId:project},async()=>{await pool.queryInActiveTx("INSERT INTO budget_denial_intents(intent_id,project_id,outer_xid,payload_json) VALUES($1,$2,pg_current_xact_id(),$3::jsonb);",[randomUUID(),project,JSON.stringify({violation:{scope:"PROJECT_TOKENS",limit:12,usage:{tokens_used:14,cost_micro_usd:5,wall_time_ms:16},reason:"budget snapshot pending fixture",taskId:null},preflight:null})]);});
}
describe("Dashboard P2 Budget snapshot — real PostgreSQL",()=>{
  it("runs HTTP parity, read-only flags, SELECT-only DAO, content/catalog equality and traps recovery/commands",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required; PG16/17 CI supplies it");return;}
    const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{
      const fx=await fixture(repo);await seed(fx);await denial(pool,fx,fx.b);
      const before=await contents(pool,fx),schema=await catalog(pool);const raw=pool.queryInActiveTx.bind(pool);const queries:string[]=[];
      pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{
        queries.push(sql);const flags=await raw("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS isolation;");
        assert.equal(flags.rows[0]!.ro,"on");assert.equal(flags.rows[0]!.isolation,"repeatable read");return raw(sql,params);
      }) as typeof pool.queryInActiveTx;
      await contract(fx,"clear");pool.queryInActiveTx=raw;
      for(const sql of queries){assert.match(sql,/^SELECT/);assert.doesNotMatch(sql,/SELECT \*|\b(UPDATE|INSERT|DELETE|CALL|FOR UPDATE|pg_advisory)\b/i);}
      assert.equal(await contents(pool,fx),before);assert.equal(await catalog(pool),schema);
      const fail=()=>{throw new Error("forbidden recovery/command secret");};repo.getProjectBudgetSnapshot=fail;repo.recoverBudgetDenials=fail;repo.withRlsTransaction=fail;repo.getProjectMembership=fail;repo.getProjectById=fail;
      assert.equal((await fx.core.readBudgetProjection(fx.auth(),fx.a)).recoveryState,"clear");
      assert.equal(await contents(pool,fx),before);assert.equal(pool.getStats().activeConnections,0);
    }finally{await pool.close();}
  });
  it("reports pending for committed and still-active outer transactions; preserves intents/policy/audit and historical failures are not pending",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool),outer=new PostgresRuntimePool(config);
    try{
      const fx=await fixture(repo);await seed(fx);assert.equal((await fx.core.readBudgetProjection(fx.auth(),fx.a)).recoveryState,"clear");
      await denial(pool,fx);const before=await contents(pool,fx);const read=await fx.core.readBudgetProjection(fx.auth(),fx.a);assert.equal(read.recoveryState,"pending");assert.equal(read.recoveryReason,"visible-pending-intent");assert.equal(read.policy!.status,"ACTIVE");assert.equal(await contents(pool,fx),before);
      await pool.withRlsTransaction(fx.scope,async()=>{await pool.queryInActiveTx("UPDATE budget_denial_intents SET status='COMPLETED',completed_at=clock_timestamp() WHERE project_id=$1;",[fx.a]);});
      assert.equal((await fx.core.readBudgetProjection(fx.auth(),fx.a)).recoveryState,"clear");
      await outer.withRlsTransaction(fx.scope,async()=>{
        const xid=(await outer.queryInActiveTx("SELECT pg_current_xact_id()::text AS xid;")).rows[0]!.xid;
        await pool.withRlsTransaction(fx.scope,async()=>{await pool.queryInActiveTx("INSERT INTO budget_denial_intents(intent_id,project_id,outer_xid,payload_json) VALUES($1,$2,$3::xid8,'{}');",[randomUUID(),fx.a,String(xid)]);});
        const snap=await contents(pool,fx);assert.equal((await fx.core.readBudgetProjection(fx.auth(),fx.a)).recoveryState,"pending");assert.equal(await contents(pool,fx),snap);
      });
    }finally{await outer.close();await pool.close();}
  });
  it("binds policy/usage/pending queries to one repeatable-read snapshot during a concurrent writer",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool),writer=new PostgresRuntimePool(config);
    try{
      const fx=await fixture(repo);await seed(fx);const raw=pool.queryInActiveTx.bind(pool);let armed=true;
      pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{
        const result=await raw(sql,params);
        if(armed&&sql.startsWith("SELECT status,")){armed=false;await writer.withRlsTransaction(fx.scope,async()=>{
          await writer.queryInActiveTx("UPDATE project_budget_policies SET max_project_tokens=99 WHERE project_id=$1;",[fx.a]);
          await writer.queryInActiveTx("INSERT INTO resource_usage_metrics(metric_id,project_id,task_id,lease_epoch,attempt_no,rework_cycle,phase,wall_time_ms,cpu_usage_usec,peak_memory_bytes,sandbox_backend_mode,metrics_source) SELECT gen_random_uuid(),project_id,task_id,lease_epoch,attempt_no,rework_cycle,phase,3,0,0,sandbox_backend_mode,metrics_source FROM resource_usage_metrics WHERE project_id=$1 LIMIT 1;",[fx.a]);
          await writer.queryInActiveTx("INSERT INTO budget_denial_intents(intent_id,project_id,outer_xid,payload_json) VALUES($1,$2,pg_current_xact_id(),'{}');",[randomUUID(),fx.a]);
        });}return result;
      }) as typeof pool.queryInActiveTx;
      const first=await fx.core.readBudgetProjection(fx.auth(),fx.a);assert.equal(first.dimensions.tokens.limit,"12");assert.equal(first.dimensions.wallTimeMs.consumed,"16");assert.equal(first.recoveryState,"clear");
      pool.queryInActiveTx=raw;const next=await fx.core.readBudgetProjection(fx.auth(),fx.a);assert.equal(next.dimensions.tokens.limit,"99");assert.equal(next.dimensions.wallTimeMs.consumed,"19");assert.equal(next.recoveryState,"pending");
    }finally{await writer.close();await pool.close();}
  });
  it("preserves BIGINT precision, generic failure semantics and connection cleanup without legacy recovery",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{
      const fx=await fixture(repo);await seed(fx);
      await pool.withRlsTransaction(fx.scope,async()=>{await pool.queryInActiveTx("UPDATE project_budget_policies SET max_project_cost_micro_usd=9007199254740993,status='AUTO_PAUSED' WHERE project_id=$1;",[fx.a]);});
      const exact=await fx.core.readBudgetProjection(fx.auth(),fx.a);assert.equal(exact.policy!.status,"AUTO_PAUSED");assert.equal(exact.dimensions.costMicroUsd.limit,"9007199254740993");assert.equal(exact.dimensions.costMicroUsd.remaining,"9007199254740988");
      const before=await contents(pool,fx);const raw=pool.queryInActiveTx.bind(pool);
      pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{if(sql.includes("EXISTS(SELECT 1 FROM budget_denial_intents"))throw new Error("PRIVATE relation/permission failure");return raw(sql,params);}) as typeof pool.queryInActiveTx;
      await expectError(fx.core.readBudgetProjection(fx.auth(),fx.a),500);pool.queryInActiveTx=raw;
      assert.equal(pool.getStats().activeConnections,0);assert.equal(await contents(pool,fx),before);
      await assert.rejects(repo.readBudgetProjection({projectId:fx.a,principalId:"AUDITOR",signedRoles:["AUDITOR"],deadlineAt:Date.now()-1}));
    }finally{await pool.close();}
  });
  it("sums every ledger status in SQL with exact above-safe-integer consumption and no session/estimate double count",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{
      const fx=await fixture(repo);await seed(fx);
      await pool.withRlsTransaction(fx.scope,async()=>{
        await pool.queryInActiveTx("UPDATE project_budget_policies SET max_project_cost_micro_usd=9007199254740993 WHERE project_id=$1;",[fx.a]);
        for(const status of ["BLOCKED_PREFLIGHT","BLOCKED_POSTCALL","FAILED_VALIDATION"]){
          await pool.queryInActiveTx(`INSERT INTO model_call_ledgers(call_id,project_id,cost_session_id,task_id,stage,provider,model,prompt_id,prompt_version,prompt_sha256,request_sha256,estimated_input_tokens,reserved_output_tokens,actual_input_tokens,actual_output_tokens,actual_total_tokens,estimated_cost_micro_usd,actual_cost_micro_usd,status,usage_estimated)
            SELECT $1,project_id,cost_session_id,task_id,stage,provider,model,prompt_id,prompt_version,prompt_sha256,request_sha256,0,0,0,0,0,999999,9007199254740993,$3,false FROM model_call_ledgers WHERE project_id=$2 LIMIT 1;`,[randomUUID(),fx.a,status]);
        }
      });
      const before=await contents(pool,fx),result=await fx.core.readBudgetProjection(fx.auth(),fx.a);
      assert.equal(result.dimensions.costMicroUsd.consumed,"27021597764222984");assert.equal(result.dimensions.costMicroUsd.remaining,"-18014398509481991");
      assert.equal(result.dimensions.tokens.consumed,"14");assert.equal(result.recoveryState,"clear");assert.equal(await contents(pool,fx),before);
    }finally{await pool.close();}
  });
  it("cancels a real timed-out SELECT, closes its read transaction and can read again without writes",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{
      const fx=await fixture(repo);await seed(fx);const before=await contents(pool,fx),raw=pool.queryInActiveTx.bind(pool);let inject=true;
      pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{
        if(inject&&sql.startsWith("SELECT status,")){inject=false;await raw("SELECT pg_sleep(3);");}
        return raw(sql,params);
      }) as typeof pool.queryInActiveTx;
      const started=Date.now();await expectError(fx.core.readBudgetProjection(fx.auth(),fx.a),500);assert.ok(Date.now()-started<4500);
      pool.queryInActiveTx=raw;assert.equal(pool.getStats().activeConnections,0);assert.equal(pool.getStats().waitingCount,0);
      assert.equal((await fx.core.readBudgetProjection(fx.auth(),fx.a)).dimensions.tokens.consumed,"14");assert.equal(await contents(pool,fx),before);
    }finally{await pool.close();}
  });
  it("leaves legacy budget recovery behavior intact while the new reader leaves pending intents untouched",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{
      const fx=await fixture(repo);await seed(fx);await denial(pool,fx);
      const before=await contents(pool,fx);assert.equal((await fx.core.readBudgetProjection(fx.auth(),fx.a)).recoveryState,"pending");assert.equal(await contents(pool,fx),before);
      const legacy=await fx.core.getBudgetSnapshot(fx.a,fx.auth("ORG_ADMIN"));assert.equal(legacy.policy!.status,"AUTO_PAUSED");
      const next=await fx.core.readBudgetProjection(fx.auth(),fx.a);assert.equal(next.recoveryState,"clear");assert.equal(next.policy!.status,"AUTO_PAUSED");assert.notEqual(await contents(pool,fx),before);
    }finally{await pool.close();}
  });
});
