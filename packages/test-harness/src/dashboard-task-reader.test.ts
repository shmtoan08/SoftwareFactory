import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID, createHmac, createHash } from "node:crypto";
import { CoreApiService, CoreApiHttpServer, CORE_API_AUTH_HEADER, encodeCoreApiAuthHeader, ReadProjectionError } from "@software-factory/core-api";
import { TaskReadCursorCodec } from "../../../apps/core-api/src/task-read-projection.ts";
import { SoftwareFactoryControlPlaneStore, PostgresControlPlaneRepository, PostgresRuntimePool, buildPostgresPoolConfigFromEnv, TASK_READ_PAGE_SQL, TASK_READ_STATUSES, type ControlPlaneStore, type ProjectMemberRole } from "@software-factory/database";
import { contents, catalog } from "./dashboard-read-test-support.ts";
const roles: ProjectMemberRole[] = ["AUDITOR", "DEVELOPER", "PROJECT_APPROVER", "ORG_ADMIN"];
const tied = "2026-11-17T00:00:00.123456Z";
async function fixture(store: ControlPlaneStore, pool?: PostgresRuntimePool) {
  const a=randomUUID(), b=randomUUID(), sessions:string[]=[], ids:string[]=[];
  for (const project of [a,b]) await store.withRlsTransaction({currentProjectId:project,currentRole:"system_admin_role"},async()=>{
    await store.createProject({project_id:project,slug:`task-read-${project}`,name:"Task reader fixture",repo_bare_path:"/private/never-expose.git",initial_main_commit_hash:"a".repeat(40)});
    for(const role of roles)await store.addProjectMembership({project_id:project,principal_id:role,member_role:role});
  });
  for (const project of [a,b]) await store.withRlsTransaction({currentProjectId:project,currentPrincipalId:"ORG_ADMIN",currentRole:"core_api_service"},async()=>{
    for(let i=0;i<(project===a?2:1);i++)sessions.push((await store.createProductPipelineSession({project_id:project,title:"Session",raw_idea_text:"Private source",created_by_principal_id:"ORG_ADMIN"})).pipeline_session_id);
  });
  const emptySession=(await store.withRlsTransaction({currentProjectId:a,currentPrincipalId:"ORG_ADMIN",currentRole:"core_api_service"},()=>store.createProductPipelineSession({project_id:a,title:"Empty",raw_idea_text:"No linked tasks",created_by_principal_id:"ORG_ADMIN"}))).pipeline_session_id;
  const core=new CoreApiService(store), scope={currentProjectId:a,currentPrincipalId:"ORG_ADMIN",currentRole:"core_api_service" as const};
  const auth=(role:ProjectMemberRole="AUDITOR",projectId=a,principalId:string=role)=>core.issueAuthContext({projectId,principalId,roles:[role]});
  await store.withRlsTransaction(scope,async()=>{
    for(let i=0;i<8;i++)ids.push((await store.createTask({project_id:a,title:`Task ${i}`,task_contract:{allowed_files:[`src/${i}.ts`]}})).task_id);
  });
  if(pool){
    for(const [session,project] of [[sessions[0]!,a],[sessions[1]!,a],[sessions[2]!,b]] as [string,string][])await graph(pool,project,session);
    await pool.withRlsTransaction(scope,async()=>{
      for(let i=0;i<ids.length;i++){
        await pool.queryInActiveTx("UPDATE tasks SET updated_at=$2::timestamptz,status=$3 WHERE task_id=$1;",[ids[i],tied,i===6?"ReworkRequired":"Ready"]);
        if(i!==7)await link(pool,a,i===5?sessions[1]!:sessions[0]!,ids[i]!);
      }
    });
  }else{
    const maps=store as any;
    for(let i=0;i<ids.length;i++){
      const task=maps.tasks.get(ids[i]);task.updated_at=tied;task.status=i===6?"ReworkRequired":"Ready";
      if(i!==7)maps.taskPlanLinks.set(randomUUID(),{project_id:a,pipeline_session_id:i===5?sessions[1]:sessions[0],task_id:ids[i],assigned_profile_id:null});
    }
  }
  return {store,pool,core,a,b,scope,auth,session:sessions[0]!,emptySession,otherSession:sessions[1]!,foreignSession:sessions[2]!,ids};
}
/** Minimal real relational graph satisfying all current FK/CHECK/triggers; no disabled constraints. */
async function graph(pool:PostgresRuntimePool,project:string,session:string){
  await pool.withRlsTransaction({currentProjectId:project,currentPrincipalId:"ORG_ADMIN",currentRole:"core_api_service"},async()=>{
    const artifacts:string[]=[], hashes:string[]=[],fact=randomUUID();
    await pool.queryInActiveTx("INSERT INTO stage1_discovery_items(item_id,project_id,pipeline_session_id,kind,title,statement,rationale,confirmation_status) VALUES($1,$2,$3,'FACT','Fixture fact','Fixture statement','Fixture rationale','AUTO_VERIFIED');",[fact,project,session]);
    const stages=["STAGE_1_IDEA_DISCOVERY","STAGE_2_REQUIREMENTS","STAGE_3_ARCHITECTURE","STAGE_4_SPEC_FREEZE"];
    const kinds=["STAGE_1_DISCOVERY_BUNDLE","STAGE_2_PRD_SRS","STAGE_3_ARCHITECTURE_DESIGN","STAGE_4_VALIDATION_REPORT"];
    for(let i=0;i<4;i++){
      const id=randomUUID(),content=JSON.stringify(i===3?{passed:true}:i===1?{srs:{functional_requirements:[{req_id:"R1",source_discovery_item_ids:[fact]}]}}:{}),hash=createHash("sha256").update(content).digest("hex");artifacts.push(id);hashes.push(hash);
      await pool.queryInActiveTx("INSERT INTO stage_artifacts(artifact_id,project_id,pipeline_session_id,stage,artifact_kind,version,provider,model,prompt_id,prompt_version,prompt_sha256,content_json,artifact_sha256,created_by_principal_id) VALUES($1,$2,$3,$4,$5,1,'system','fixture','fixture','1',repeat('a',64),$6::jsonb,$7,'ORG_ADMIN');",[id,project,session,stages[i],kinds[i],content,hash]);
    }
    const gate=randomUUID(),baseline=randomUUID(),milestone=randomUUID(),epic=randomUUID();
    await pool.queryInActiveTx("INSERT INTO stage_approval_gates(gate_id,project_id,pipeline_session_id,gate_stage,target_artifact_id,target_artifact_sha256,approver_principal_id,decision) VALUES($1,$2,$3,'STAGE_4_SPEC_FREEZE',$4,$5,'ORG_ADMIN','APPROVED');",[gate,project,session,artifacts[3],hashes[3]]);
    await pool.queryInActiveTx("INSERT INTO baseline_spec_freezes(baseline_id,project_id,pipeline_session_id,stage1_artifact_id,stage1_artifact_sha256,stage2_artifact_id,stage2_artifact_sha256,stage3_artifact_id,stage3_artifact_sha256,validation_report_artifact_id,validation_report_sha256,approval_gate_id,frozen_by_principal_id,freeze_bundle_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ORG_ADMIN',repeat('c',64));",[baseline,project,session,artifacts[0],hashes[0],artifacts[1],hashes[1],artifacts[2],hashes[2],artifacts[3],hashes[3],gate]);
    await pool.queryInActiveTx("INSERT INTO dev_milestones(milestone_id,project_id,pipeline_session_id,baseline_id,milestone_key,title,description,sequence_order) VALUES($1,$2,$3,$4,'M','M','fixture',0);",[milestone,project,session,baseline]);
    await pool.queryInActiveTx("INSERT INTO dev_epics(epic_id,project_id,milestone_id,epic_key,title,description,sequence_order) VALUES($1,$2,$3,'E','E','fixture',0);",[epic,project,milestone]);
    await pool.queryInActiveTx("INSERT INTO dev_user_stories(project_id,epic_id,story_key,title,description,requirement_ids_json,ac_ids_json,sequence_order) VALUES($1,$2,'S','S','fixture','[\"R1\"]','[\"AC1\"]',0);",[project,epic]);
  });
}
async function link(pool:PostgresRuntimePool,project:string,session:string,task:string,profile:string|null=null){
  await pool.queryInActiveTx(`INSERT INTO task_plan_links(project_id,pipeline_session_id,baseline_id,story_id,task_id,assigned_profile_id,requirement_ids_json,ac_ids_json)
    SELECT $1,$2,b.baseline_id,s.story_id,$3,$4::uuid,'["R1"]','["AC1"]' FROM baseline_spec_freezes b JOIN dev_milestones m ON m.baseline_id=b.baseline_id JOIN dev_epics e ON e.milestone_id=m.milestone_id JOIN dev_user_stories s ON s.epic_id=e.epic_id WHERE b.project_id=$1 AND b.pipeline_session_id=$2;`,[project,session,task,profile]);
}
type Fx=Awaited<ReturnType<typeof fixture>>;
async function error(p:Promise<unknown>,status:number){await assert.rejects(p,(e:unknown)=>e instanceof ReadProjectionError&&e.httpStatus===status);}
function snapshot(store:SoftwareFactoryControlPlaneStore){return JSON.stringify(Object.entries(store).filter(([,v])=>v instanceof Map),(_k,v:unknown)=>v instanceof Map?[...v]:v);}
async function contract(fx:Fx){
  const server=new CoreApiHttpServer({coreApi:fx.core}),endpoint=await server.start();
  const get=async(query="",session=fx.session,auth:ReturnType<Fx["auth"]>|null=fx.auth(),project=fx.a)=>{
    const r=await fetch(`${endpoint.baseUrl}/api/v1/projects/${project}/sessions/${session}/tasks${query}`,{headers:auth?{[CORE_API_AUTH_HEADER]:encodeCoreApiAuthHeader(auth)}:{}});
    return {status:r.status,body:await r.json() as any};
  };
  try{
    for(const role of roles){const r=await get("",fx.session,fx.auth(role));assert.equal(r.status,200);assert.equal(r.body.items.length,6);assert.deepEqual(r.body.filters,{sourceStatuses:[],stage:null});assert.deepEqual(r.body.page,{limit:25,hasMore:false,nextCursor:null});assert.match(r.body.fetchedAt,/\.\d{6}Z$/);assert.equal(r.body.schemaVersion,"dashboard-read-v1");assert.equal(r.body.projectId,fx.a);assert.equal(r.body.sessionId,fx.session);}
    const empty=await get("",fx.emptySession);assert.equal(empty.status,200);assert.deepEqual(empty.body.items,[]);assert.deepEqual(empty.body.page,{limit:25,hasMore:false,nextCursor:null});
    const first=await get("?limit=2");assert.equal(first.status,200);assert.equal(first.body.page.hasMore,true);
    const item=first.body.items[0];assert.deepEqual(Object.keys(item).sort(),["taskId","projectId","sessionId","title","sourceStatus","currentAttemptNo","reworkCount","maxReworkCycles","activeLeaseEpoch","assigneeId","leaseOwnerId","leaseExpiresAt","createdAt","updatedAt"].sort());assert.equal(item.assigneeId,null);assert.equal(item.leaseOwnerId,null);assert.equal(item.leaseExpiresAt,null);assert.equal(item.activeLeaseEpoch,"0");
    const expected=fx.ids.filter((_,i)=>i!==5&&i!==7).sort().reverse(),seen:string[]=[];let page=first.body;
    while(true){seen.push(...page.items.map((x:any)=>x.taskId));if(!page.page.hasMore)break;page=(await get(`?limit=2&cursor=${page.page.nextCursor}`)).body;}
    assert.deepEqual(seen,expected);assert.doesNotMatch(JSON.stringify(first.body),/task_contract|profile_snapshot|raw_idea|never-expose|base_main/);
    const filtered=await get("?status=Ready&status=ReworkRequired&limit=100");assert.equal(filtered.body.items.length,6);assert.deepEqual(filtered.body.filters.sourceStatuses,["Ready","ReworkRequired"]);
    assert.equal((await get("?status=ReworkRequired")).body.items.length,1);
    for(const q of ["?limit=0","?limit=101","?limit=-1","?limit=1.5","?limit=01","?limit=","?limit=all","?limit=1&limit=2","?cursor=","?cursor=x","?cursor="+"a".repeat(2049),"?status=ready","?status= Ready","?status=Ready,Leased","?status=Ready&status=Ready","?stage=STAGE_4_SPEC_FREEZE","?offset=1","?projectId=x"]){assert.equal((await get(q)).status,400,q);}
    assert.equal((await get("",fx.session,null)).status,401);
    assert.equal((await get("",fx.foreignSession)).status,404);assert.equal((await get("",randomUUID())).status,404);
    assert.equal((await get("",fx.foreignSession,fx.auth(),fx.b)).status,403);assert.equal((await get("",fx.session,fx.auth("AUDITOR",fx.a,"nobody"))).status,403);
    assert.equal((await get("",fx.session,fx.auth("ORG_ADMIN",fx.a,"AUDITOR"))).status,403);
    const cursor=first.body.page.nextCursor as string;
    const ordered=(await get("?status=ReworkRequired&status=Ready&limit=2")).body.page.nextCursor;assert.equal((await get(`?status=Ready&status=ReworkRequired&limit=2&cursor=${ordered}`)).status,200);
    const expired=JSON.parse(Buffer.from(cursor.split(".")[0]!,"base64url").toString());expired.expires=Date.now()-1;
    const expiredBody=Buffer.from(JSON.stringify(expired)).toString("base64url");assert.equal((await get(`?limit=2&cursor=${expiredBody}.${fx.core.authenticator.signProjectReadCursor(expiredBody)}`)).status,409);
    assert.equal((await get("",fx.session,{...fx.auth(),signatureHex:"0".repeat(64)})).status,403);
    assert.equal((await get(`?limit=3&cursor=${cursor}`)).status,409);
    assert.equal((await get(`?limit=2&status=Ready&cursor=${cursor}`)).status,409);
    assert.equal((await get(`?limit=2&cursor=${cursor}`,fx.otherSession)).status,409);
    assert.equal((await get(`?limit=2&cursor=${cursor}`,fx.session,fx.auth("DEVELOPER"))).status,409);
    assert.equal((await get(`?limit=2&cursor=${cursor.slice(0,-1)}${cursor.endsWith("0")?"1":"0"}`)).status,400);
    const missing=await get(`?limit=2&cursor=${cursor}`,randomUUID());assert.equal(missing.status,404);
    assert.equal((await get("", "%ZZ")).status,400);
  }finally{await server.stop();}
}

describe("Dashboard P3 Task reader — memory",()=>{
  it("enforces HTTP scope, DTO, strict filters, tied keysets and cursor context",async()=>{const fx=await fixture(new SoftwareFactoryControlPlaneStore());await contract(fx);});
  it("filters every source status without inventing stage or duplicating repeated identical links",async()=>{
    const store=new SoftwareFactoryControlPlaneStore(),fx=await fixture(store),maps=store as any,task=maps.tasks.get(fx.ids[0]),one=[...maps.taskPlanLinks.values()].find((l:any)=>l.task_id===fx.ids[0]);
    maps.taskPlanLinks.set("same-association",{...one});
    for(const status of TASK_READ_STATUSES){task.status=status;const before=snapshot(store),r=await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session,new URLSearchParams({status}));assert.equal(r.items.filter(x=>x.taskId===task.task_id).length,1);assert.equal(r.items.find(x=>x.taskId===task.task_id)!.sourceStatus,status);assert.equal(snapshot(store),before);}
  });
  it("preserves all maps/nested fields, rejects legacy paths/nested reads and source corruption",async()=>{
    const store=new SoftwareFactoryControlPlaneStore(),fx=await fixture(store),before=snapshot(store),scope=structuredClone(store.getCurrentRlsSession());
    const fail=()=>{throw new Error("forbidden private side effect");};store.getTaskById=fail;store.selectVisibleTasks=fail;store.getProductPipelineSession=fail;
    const result=await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session);result.items[0]!.title="changed";assert.equal(snapshot(store),before);assert.deepEqual(store.getCurrentRlsSession(),scope);
    await store.withRlsTransaction(fx.scope,async()=>{await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);});
    const maps=store as any,task=maps.tasks.get(fx.ids[0]);
    for(const [key,value] of [["active_lease_id",randomUUID()],["active_lease_epoch",Number.MAX_SAFE_INTEGER+1],["current_attempt_no",-1],["title",null],["updated_at","bad"]] as [string,unknown][]){const old=task[key];task[key]=value;const corrupt=snapshot(store);await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);assert.equal(snapshot(store),corrupt);task[key]=old;}
    assert.equal(snapshot(store),before);
    const link=[...maps.taskPlanLinks.values()].find((l:any)=>l.task_id===fx.ids[0]);link.assigned_profile_id=undefined;await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);link.assigned_profile_id=randomUUID();maps.taskPlanLinks.set("duplicate",{...link,assigned_profile_id:randomUUID()});await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);
  });
  it("projects real lease owner/expiry and planned profile separately; never expires or refreshes by reading",async()=>{
    const store=new SoftwareFactoryControlPlaneStore(),fx=await fixture(store);let lease:any;
    await store.withRlsTransaction(fx.scope,async()=>{lease=await store.grantTaskLease({project_id:fx.a,task_id:fx.ids[0]!,worker_id:"actual-worker"});});
    const maps=store as any,profile=randomUUID();[...maps.taskPlanLinks.values()].find((l:any)=>l.task_id===fx.ids[0]).assigned_profile_id=profile;maps.taskLeases.get(lease.lease_id).expires_at="2000-01-01T00:00:00.000Z";
    const before=snapshot(store),row=(await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session)).items.find(x=>x.taskId===fx.ids[0])!;
    assert.equal(row.leaseOwnerId,"actual-worker");assert.equal(row.assigneeId,profile);assert.equal(row.leaseExpiresAt,"2000-01-01T00:00:00.000000Z");assert.equal(snapshot(store),before);
    maps.taskLeases.get(lease.lease_id).lease_epoch++;await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);
  });
  it("validates signed cursor schema, expiry and microseconds; enforces deadline and response size",async()=>{
    const fx=await fixture(new SoftwareFactoryControlPlaneStore()),mac=(x:string)=>createHmac("sha256","private-test-only").update(x).digest("hex"),codec=new TaskReadCursorCodec(mac,()=>1000),ctx={projectId:fx.a,principalId:"AUDITOR",sessionId:fx.session,sourceStatuses:[],limit:2};
    const row=(await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session)).items[0]!,token=codec.encode(ctx,row),c=codec.decode(token);assert.equal(c.anchor.updatedAt,tied);assert.equal(codec.mismatch(c,ctx),false);assert.equal(new TaskReadCursorCodec(mac,()=>901000).mismatch(c,ctx),true);
    for(const body of [{...c,extra:true},{...c,anchor:{...c.anchor,updatedAt:"2026-02-30T00:00:00.000000Z"}},{...c,sourceStatuses:["Ready","Ready"]},{...c,kind:"projects"}]){const data=Buffer.from(JSON.stringify(body)).toString("base64url");assert.throws(()=>codec.decode(`${data}.${mac(data)}`));}
    const store=fx.store as SoftwareFactoryControlPlaneStore;await assert.rejects(store.readTaskProjection({...ctx,signedRoles:["AUDITOR"],after:null,cursorContextMismatch:false,deadlineAt:Date.now()-1}));
    const maps=store as any;for(const task of maps.tasks.values())task.title="x".repeat(200000);const before=snapshot(store);await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);assert.equal(snapshot(store),before);
  });
});
const config=buildPostgresPoolConfigFromEnv();
describe("Dashboard P3 Task reader — real PostgreSQL",()=>{
  it("matches HTTP contract with SELECT-only flags and zero content/catalog delta",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{const fx=await fixture(repo,pool);
      await repo.withRlsTransaction(fx.scope,async()=>{await repo.grantTaskLease({project_id:fx.a,task_id:fx.ids[7]!,worker_id:"unlinked-live-lease"});await pool.queryInActiveTx("INSERT INTO budget_denial_intents(intent_id,project_id,outer_xid,payload_json) VALUES(gen_random_uuid(),$1,pg_current_xact_id(),$2::jsonb);",[fx.a,JSON.stringify({violation:{scope:"PROJECT_TOKENS",limit:1,usage:{tokens_used:2,cost_micro_usd:0,wall_time_ms:0},reason:"P3 pending fixture",taskId:null},preflight:null})]);});
      const before=await contents(pool,fx),schema=await catalog(pool),raw=pool.queryInActiveTx.bind(pool);let queries=0;
      pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{assert.match(sql,/^SELECT\b/);assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|CALL|INTO|FOR\s+UPDATE)\b/i);const flags=await raw("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS iso;");assert.deepEqual(flags.rows[0],{ro:"on",iso:"repeatable read"});queries++;return raw(sql,params);}) as typeof pool.queryInActiveTx;
      const fail=()=>{throw new Error("forbidden private command");};repo.getTaskById=fail;repo.selectVisibleTasks=fail;repo.getProductPipelineSession=fail;repo.getProjectBudgetSnapshot=fail;
      await contract(fx);assert.ok(queries>4);pool.queryInActiveTx=raw;assert.equal(await contents(pool,fx),before);assert.equal(await catalog(pool),schema);assert.equal(pool.getStats().activeConnections,0);
    }finally{await pool.close();}
  });
  it("keeps microsecond anchors and BIGINT epochs exact, validates active lease joins and preserves expired source lease",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{const fx=await fixture(repo,pool),profile=randomUUID();let lease:any,target="";
      await repo.withRlsTransaction(fx.scope,async()=>{
        await pool.queryInActiveTx("INSERT INTO agent_organization_profiles(profile_id,project_id,profile_key,role,principal_id,provider,model,execution_target_type,trust_tier,created_by_principal_id) VALUES($1,$2,'planned','DEVELOPER','planned-principal','fixture','fixture','factory_managed_worker','TIER_1_FACTORY_MANAGED','ORG_ADMIN');",[profile,fx.a]);
        target=(await repo.createTask({project_id:fx.a,title:"Planned assignee",task_contract:{allowed_files:["planned.ts"]}})).task_id;await link(pool,fx.a,fx.session,target,profile);
        lease=await repo.grantTaskLease({project_id:fx.a,task_id:target,worker_id:"real-recorded-worker"});await pool.queryInActiveTx("UPDATE task_leases SET expires_at='2000-01-01Z' WHERE lease_id=$1;",[lease.lease_id]);await pool.queryInActiveTx("UPDATE tasks SET active_lease_epoch=9007199254740993,updated_at=$2::timestamptz WHERE task_id=$1;",[fx.ids[1],tied]);});
      const before=await contents(pool,fx),rows=(await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session)).items;assert.equal(rows.find(x=>x.taskId===target)!.leaseOwnerId,"real-recorded-worker");assert.equal(rows.find(x=>x.taskId===target)!.assigneeId,profile);assert.equal(rows.find(x=>x.taskId===target)!.leaseExpiresAt,"2000-01-01T00:00:00.000000Z");assert.equal(rows.find(x=>x.taskId===fx.ids[1])!.activeLeaseEpoch,"9007199254740993");assert.equal(await contents(pool,fx),before);
      await pool.withRlsTransaction(fx.scope,async()=>{await pool.queryInActiveTx("UPDATE tasks SET active_lease_epoch=active_lease_epoch+1 WHERE task_id=$1;",[target]);});await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);
    }finally{await pool.close();}
  });
  it("filters all 11 statuses in SQL and orders adjacent microseconds correctly",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{const fx=await fixture(repo,pool);
      for(const status of TASK_READ_STATUSES){await pool.withRlsTransaction(fx.scope,async()=>{await pool.queryInActiveTx("UPDATE tasks SET status=$2,updated_at='2026-11-17T00:00:00.123457Z' WHERE task_id=$1;",[fx.ids[0],status]);});const before=await contents(pool,fx),r=await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session,new URLSearchParams({status}));assert.equal(r.items[0]!.taskId,fx.ids[0]);assert.equal(r.items[0]!.sourceStatus,status);assert.equal(r.items[0]!.updatedAt,"2026-11-17T00:00:00.123457Z");assert.equal(await contents(pool,fx),before);}
      const first=await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session,new URLSearchParams("limit=1"));assert.equal(first.items[0]!.taskId,fx.ids[0]);const second=await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session,new URLSearchParams({limit:"1",cursor:first.page.nextCursor!}));assert.equal(second.items[0]!.updatedAt,tied);assert.notEqual(second.items[0]!.taskId,fx.ids[0]);
    }finally{await pool.close();}
  });
  it("retains one snapshot across session check/concurrent task edits and rechecks membership next page",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}const pool=new PostgresRuntimePool(config),writer=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{const fx=await fixture(repo,pool),raw=pool.queryInActiveTx.bind(pool);let once=true;
      pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{const r=await raw(sql,params);if(once&&sql.startsWith("SELECT pipeline_session_id")){once=false;await writer.withRlsTransaction(fx.scope,async()=>{await writer.queryInActiveTx("UPDATE tasks SET title='new-title',status='ReworkRequired' WHERE task_id=$1;",[fx.ids[0]]);});await writer.withRlsTransaction({...fx.scope,currentRole:"system_admin_role"},async()=>{const changed=await writer.queryInActiveTx("UPDATE project_memberships SET member_role='DEVELOPER' WHERE project_id=$1 AND principal_id='AUDITOR';",[fx.a]);assert.equal(changed.rowCount,1);});}return r;}) as typeof pool.queryInActiveTx;
      const old=await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session);assert.equal(old.items.find(x=>x.taskId===fx.ids[0])!.title,"Task 0");pool.queryInActiveTx=raw;await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),403);const next=await fx.core.readTaskProjection(fx.auth("ORG_ADMIN"),fx.a,fx.session);assert.equal(next.items.find(x=>x.taskId===fx.ids[0])!.title,"new-title");
    }finally{await pool.close();await writer.close();}
  });
  it("fails generically on query/timeout/nested/oversize errors and releases the pool without business writes",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}const pool=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{const fx=await fixture(repo,pool),before=await contents(pool,fx),raw=pool.queryInActiveTx.bind(pool);let once=true;
      pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{if(once&&sql===TASK_READ_PAGE_SQL){once=false;await raw("SELECT pg_sleep(3);");}return raw(sql,params);}) as typeof pool.queryInActiveTx;
      await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);pool.queryInActiveTx=raw;assert.equal(pool.getStats().activeConnections,0);assert.equal(pool.getStats().waitingCount,0);pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{if(sql===TASK_READ_PAGE_SQL)throw new Error("private database fault");return raw(sql,params);}) as typeof pool.queryInActiveTx;await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);pool.queryInActiveTx=raw;assert.equal((await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session)).items.length,6);
      await pool.withRlsTransaction(fx.scope,async()=>{await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);});assert.equal(await contents(pool,fx),before);
      await pool.withRlsTransaction(fx.scope,async()=>{await pool.queryInActiveTx("UPDATE tasks SET title=repeat('x',200000) WHERE project_id=$1;",[fx.a]);});const huge=await contents(pool,fx);await error(fx.core.readTaskProjection(fx.auth(),fx.a,fx.session),500);assert.equal(await contents(pool,fx),huge);
    }finally{await pool.close();}
  });
  it("bounds a 21000-task fixture, inspects actual RLS EXPLAIN, and reads during concurrent changes without adding an index",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}const pool=new PostgresRuntimePool(config),writer=new PostgresRuntimePool(config),repo=new PostgresControlPlaneRepository(pool);
    try{const fx=await fixture(repo,pool),schema=await catalog(pool);
      await pool.withRlsTransaction(fx.scope,async()=>{
        await pool.queryInActiveTx(`INSERT INTO tasks(project_id,title,task_contract_json,status,base_main_commit_hash,updated_at) SELECT $1,'scale-'||g,'{"allowed_files":["src/**"]}'::jsonb,CASE WHEN g%2=0 THEN 'Ready' ELSE 'ReworkRequired' END,repeat('a',40),'2026-11-17T00:00:00Z'::timestamptz+(g%10)*interval '1 microsecond' FROM generate_series(1,21000) g;`,[fx.a]);
        await pool.queryInActiveTx(`INSERT INTO task_plan_links(project_id,pipeline_session_id,baseline_id,story_id,task_id,requirement_ids_json,ac_ids_json) SELECT $1,$2,b.baseline_id,s.story_id,t.task_id,'["R1"]','["AC1"]' FROM tasks t CROSS JOIN baseline_spec_freezes b JOIN dev_milestones m ON m.baseline_id=b.baseline_id JOIN dev_epics e ON e.milestone_id=m.milestone_id JOIN dev_user_stories s ON s.epic_id=e.epic_id WHERE t.project_id=$1 AND t.title LIKE 'scale-%' AND substring(t.title FROM 7)::int<=10000 AND b.project_id=$1 AND b.pipeline_session_id=$2;`,[fx.a,fx.session]);
        await pool.queryInActiveTx(`INSERT INTO task_plan_links(project_id,pipeline_session_id,baseline_id,story_id,task_id,requirement_ids_json,ac_ids_json) SELECT $1,$2,b.baseline_id,s.story_id,t.task_id,'["R1"]','["AC1"]' FROM tasks t CROSS JOIN baseline_spec_freezes b JOIN dev_milestones m ON m.baseline_id=b.baseline_id JOIN dev_epics e ON e.milestone_id=m.milestone_id JOIN dev_user_stories s ON s.epic_id=e.epic_id WHERE t.project_id=$1 AND t.title LIKE 'scale-%' AND substring(t.title FROM 7)::int BETWEEN 10001 AND 11000 AND b.project_id=$1 AND b.pipeline_session_id=$2;`,[fx.a,fx.otherSession]);
      });
      let plan:any;
      await pool.withReadOnlyRlsTransaction(fx.scope,async()=>{const r=await pool.queryInActiveTx("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+TASK_READ_PAGE_SQL,[fx.a,fx.session,JSON.stringify(["Ready"]),null,null,101]);plan=r.rows[0]!["QUERY PLAN"];if(typeof plan==="string")plan=JSON.parse(plan);});
      assert.ok(plan[0]["Execution Time"]<2000);assert.equal(plan[0].Plan["Actual Rows"],101);t.diagnostic(`Task page scale: 21000 extra tasks, 10000 selected-session links, 1000 other-session links, 10000 unlinked; EXPLAIN execution_ms=${plan[0]["Execution Time"]}; root=${plan[0].Plan["Node Type"]}; output_rows=101; existing indexes only`);
      const before=await contents(pool,fx);let reads=0;
      await Promise.all([writer.withRlsTransaction(fx.scope,async()=>{await writer.queryInActiveTx("UPDATE tasks SET title=title||'-changed' WHERE task_id=$1;",[fx.ids[0]]);for(let i=0;i<3;i++){const r=await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session,new URLSearchParams("limit=100&status=Ready"));assert.equal(r.items.length,100);assert.equal(r.page.hasMore,true);reads++;}})]);
      assert.equal(reads,3);assert.notEqual(await contents(pool,fx),before);const stable=await contents(pool,fx);await fx.core.readTaskProjection(fx.auth(),fx.a,fx.session);assert.equal(await contents(pool,fx),stable);assert.equal(await catalog(pool),schema);
    }finally{await pool.close();await writer.close();}
  });
});
