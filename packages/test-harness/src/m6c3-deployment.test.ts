import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCoreApiRuntime } from "../../../apps/core-api/src/runtime.ts";
import { CoreApiService, CoreApiHttpServer, encodeCoreApiAuthHeader, CORE_API_AUTH_HEADER, type ProductionDeploymentConfiguration } from "@software-factory/core-api";
import { PostgresControlPlaneRepository, PostgresRuntimePool, SoftwareFactoryControlPlaneStore, buildPostgresPoolConfigFromEnv, type ControlPlaneStore } from "@software-factory/database";
import { sha256Hex, type PipelineStageName, type StageArtifactKind } from "@software-factory/shared-types";

const secret = randomBytes(32).toString("hex"); const artifact = sha256Hex("approved artifact bytes"); const receipt = sha256Hex("provider receipt");
async function fixture(store: ControlPlaneStore, config: ProductionDeploymentConfiguration) {
  const root = mkdtempSync(join(tmpdir(),"sf-production-gate-")); const repo = join(root,"repo"); mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git",args,{cwd:repo,encoding:"utf8",stdio:"pipe",env:{...process.env,GIT_AUTHOR_NAME:"Factory",GIT_AUTHOR_EMAIL:"factory@example.test",GIT_COMMITTER_NAME:"Factory",GIT_COMMITTER_EMAIL:"factory@example.test"}}).trim();
  git(["init","--initial-branch=main"]); writeFileSync(join(repo,"source.txt"),"release\n"); git(["add","."]); git(["commit","-m","release"]); const commit=git(["rev-parse","HEAD"]);
  const projectId=randomUUID();
  await store.withRlsTransaction({currentRole:"system_admin_role"},async()=>{
    await store.createProject({project_id:projectId,slug:`deploy-${projectId}`,name:"Production gate",repo_bare_path:repo,initial_main_commit_hash:commit});
    for(const [principal,role] of [["human","PROJECT_APPROVER"],["developer","DEVELOPER"],["auditor","AUDITOR"]] as const) await store.addProjectMembership({project_id:projectId,principal_id:principal,member_role:role});
  });
  const scope={currentProjectId:projectId,currentPrincipalId:"human",currentRole:"core_api_service" as const};
  // Seed trusted Stage 9 prerequisites through store contracts. No model or cloud call.
  const release=await store.withRlsTransaction(scope,async()=>{
    const session=await store.createProductPipelineSession({project_id:projectId,title:"Release",raw_idea_text:"test",created_by_principal_id:"human"});
    const sid=session.pipeline_session_id;
    const art=async(stage:PipelineStageName,kind:StageArtifactKind,content:Record<string,unknown>)=>store.recordStageArtifact({project_id:projectId,pipeline_session_id:sid,stage,artifact_kind:kind,provider:"system",model:"fixture",prompt_id:"fixture",prompt_version:"1",prompt_sha256:sha256Hex("prompt"),content_json:content,created_by_principal_id:"human"});
    const s1=await art("STAGE_1_IDEA_DISCOVERY","STAGE_1_DISCOVERY_BUNDLE",{});
    const s2=await art("STAGE_2_REQUIREMENTS","STAGE_2_PRD_SRS",{srs:{}});
    const s3=await art("STAGE_3_ARCHITECTURE","STAGE_3_ARCHITECTURE_DESIGN",{});
    const s4=await art("STAGE_4_SPEC_FREEZE","STAGE_4_VALIDATION_REPORT",{passed:true});
    const gate=await store.recordStageApprovalGate({project_id:projectId,pipeline_session_id:sid,gate_stage:"STAGE_4_SPEC_FREEZE",target_artifact_id:s4.artifact_id,target_artifact_sha256:s4.artifact_sha256,approver_principal_id:"human",decision:"APPROVED"});
    const frozen=await store.freezeBaselineSpec({project_id:projectId,pipeline_session_id:sid,stage1_artifact_id:s1.artifact_id,stage1_artifact_sha256:s1.artifact_sha256,stage2_artifact_id:s2.artifact_id,stage2_artifact_sha256:s2.artifact_sha256,stage3_artifact_id:s3.artifact_id,stage3_artifact_sha256:s3.artifact_sha256,validation_report_artifact_id:s4.artifact_id,validation_report_sha256:s4.artifact_sha256,approval_gate_id:gate.gate_id,frozen_by_principal_id:"human"});
    return store.recordReleaseAcceptancePackage({project_id:projectId,pipeline_session_id:sid,baseline_id:frozen.baseline_id,traceability_sha256:sha256Hex("fixture trace"),coverage_percent:100,complete:true,total_requirements:1,merged_task_ids:[randomUUID()],applied_cr_ids:[],main_head_commit_hash:commit,summary_markdown:"Trusted fixture release",package_json:{fixture:true},accepted_by_principal_id:"human"});
  });
  const core=new CoreApiService(store,{productionDeployment:{...config,testOnlyEmulator:store instanceof SoftwareFactoryControlPlaneStore}});
  const human=core.issueAuthContext({projectId,principalId:"human",roles:["PROJECT_APPROVER"]});
  const developer=core.issueAuthContext({projectId,principalId:"developer",roles:["DEVELOPER"]});
  const auditor=core.issueAuthContext({projectId,principalId:"auditor",roles:["AUDITOR"]});
  const input={pipeline_session_id:release.pipeline_session_id,release_id:release.release_id,artifact_sha256:artifact,target_key:"production"};
  return{core,human,developer,auditor,input,release,projectId,scope,git,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

async function normalGate(store: ControlPlaneStore) {
  let calls=0; let started!:()=>void; let finish!:()=>void;
  const entered=new Promise<void>((r)=>{started=r;}); const released=new Promise<void>((r)=>{finish=r;});
  const fx=await fixture(store,{signingSecret:secret,executors:{production:async(action)=>{
    calls++; assert.equal(action.artifact_sha256,artifact); assert.equal(action.commit_hash,fx.release.main_head_commit_hash); assert.equal(action.release_package_sha256,fx.release.package_sha256);
    assert.equal(Object.isFrozen(action),true); assert.equal("approval_token" in action,false);
    const durable=await store.withRlsTransaction(fx.scope,()=>store.getProductionDeploymentByApproval(approved.approval.approval_id)); assert.equal(durable?.status,"RUNNING");
    started(); await released; return{receipt_sha256:receipt};
  }}});
  let approved:Awaited<ReturnType<CoreApiService["approveProductionDeployment"]>>;
  try{
    await assert.rejects(fx.core.approveProductionDeployment(fx.projectId,fx.developer,fx.input),/Authorization/);
    const disabled=new CoreApiService(store,{authenticator:fx.core.authenticator});
    await assert.rejects(disabled.approveProductionDeployment(fx.projectId,fx.human,fx.input),/not enabled/);
    approved=await fx.core.approveProductionDeployment(fx.projectId,fx.human,fx.input);
    const audit=await store.withRlsTransaction(fx.scope,()=>store.listOutboxEventsForProject());
    assert.equal(JSON.stringify(audit).includes(approved.approval_token),false);
    assert.equal(approved.approval.approver_principal_id,"human"); assert.equal(approved.approval.token_sha256,sha256Hex(approved.approval_token));
    const run={approval_id:approved.approval.approval_id,approval_token:approved.approval_token};
    const [payload,mac]=run.approval_token.split("."); const changed=JSON.parse(Buffer.from(payload!,"base64url").toString()) as Record<string,unknown>; changed.artifact_sha256="0".repeat(64);
    for(const invalid of [{...run,approval_token:`${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${mac}`},{...run,approval_id:randomUUID()},{...run,target_key:"attacker"}]) await assert.rejects(fx.core.executeProductionDeployment(fx.projectId,fx.developer,invalid));
    await assert.rejects(store.withRlsTransaction(fx.scope,()=>fx.core.executeProductionDeployment(fx.projectId,fx.developer,run)),/own committed transaction/);
    await assert.rejects(fx.core.executeProductionDeployment(randomUUID(),fx.developer,run),/project/);
    await assert.rejects(fx.core.revokeProductionDeploymentApproval(fx.projectId,fx.developer,run.approval_id),/Authorization/);
    assert.equal(calls,0);
    const first=fx.core.executeProductionDeployment(fx.projectId,fx.developer,run); await entered;
    const duplicates=await Promise.all(Array.from({length:5},()=>fx.core.executeProductionDeployment(fx.projectId,fx.developer,run)));
    assert.equal(new Set(duplicates.map((d)=>d.deployment_id)).size,1); assert.ok(duplicates.every((d)=>d.status==="RUNNING")); assert.equal(calls,1);
    const another=await fx.core.approveProductionDeployment(fx.projectId,fx.human,fx.input);
    await assert.rejects(fx.core.executeProductionDeployment(fx.projectId,fx.developer,{approval_id:another.approval.approval_id,approval_token:another.approval_token}));
    assert.equal((await store.withRlsTransaction(fx.scope,()=>store.getProductionDeploymentApproval(another.approval.approval_id)))?.status,"ACTIVE");
    await fx.core.revokeProductionDeploymentApproval(fx.projectId,fx.human,another.approval.approval_id);
    finish(); const done=await first; assert.equal(done.status,"SUCCEEDED"); assert.equal(done.receipt_sha256,receipt);
    assert.equal((await fx.core.executeProductionDeployment(fx.projectId,fx.developer,run)).deployment_id,done.deployment_id); assert.equal(calls,1);
    assert.equal((await fx.core.getProductionDeployment(fx.projectId,fx.auditor,run.approval_id))?.status,"SUCCEEDED");
    await assert.rejects(fx.core.executeProductionDeployment(fx.projectId,fx.auditor,run),/Authorization/);
    await assert.rejects(fx.core.revokeProductionDeploymentApproval(fx.projectId,fx.human,run.approval_id));
    return{approval:approved.approval,deployment:done,projectId:fx.projectId,scope:fx.scope};
  }finally{finish();fx.cleanup();}
}

async function faultGate(store: ControlPlaneStore) {
  let calls=0; const unavailable=async()=>{calls++;throw new Error("provider-secret-must-not-leak");};
  const fx=await fixture(store,{signingSecret:secret,timeoutMs:10,executors:{production:unavailable,timeout:unavailable,terminal:unavailable}});
  try{
    const approve=(target="production")=>fx.core.approveProductionDeployment(fx.projectId,fx.human,{...fx.input,target_key:target});
    const request=(a:Awaited<ReturnType<typeof approve>>)=>({approval_id:a.approval.approval_id,approval_token:a.approval_token});
    const revoked=await approve(); await fx.core.revokeProductionDeploymentApproval(fx.projectId,fx.human,revoked.approval.approval_id); await assert.rejects(fx.core.executeProductionDeployment(fx.projectId,fx.developer,request(revoked)));
    const expired=await fx.core.approveProductionDeployment(fx.projectId,fx.human,{...fx.input,ttl_ms:250}); await new Promise((r)=>setTimeout(r,300)); await assert.rejects(fx.core.executeProductionDeployment(fx.projectId,fx.developer,request(expired))); assert.equal(calls,0);
    const failure=await approve(); const unknown=await fx.core.executeProductionDeployment(fx.projectId,fx.developer,request(failure)); assert.equal(unknown.status,"UNKNOWN"); assert.equal(JSON.stringify(unknown).includes("provider-secret"),false);
    await fx.core.executeProductionDeployment(fx.projectId,fx.developer,request(failure)); assert.equal(calls,1);
    const timeoutCore=new CoreApiService(store,{authenticator:fx.core.authenticator,productionDeployment:{signingSecret:secret,testOnlyEmulator:store instanceof SoftwareFactoryControlPlaneStore,timeoutMs:10,executors:{timeout:async(_action,signal)=>new Promise((_resolve,reject)=>{calls++;signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});})}}});
    const blocked=await approve(); await assert.rejects(fx.core.executeProductionDeployment(fx.projectId,fx.developer,request(blocked))); assert.equal(calls,1);
    const timeout=await approve("timeout"); assert.equal((await timeoutCore.executeProductionDeployment(fx.projectId,fx.developer,request(timeout))).status,"UNKNOWN"); assert.equal(calls,2);
    // Effect succeeded but terminal persistence was unavailable: restart must not redeploy.
    const successCore=new CoreApiService(store,{authenticator:fx.core.authenticator,productionDeployment:{signingSecret:secret,testOnlyEmulator:store instanceof SoftwareFactoryControlPlaneStore,executors:{terminal:async()=>{calls++;return{receipt_sha256:receipt};}}}});
    const lost=await approve("terminal"); const complete=store.completeProductionDeployment;
    store.completeProductionDeployment=async()=>{throw new Error("terminal transaction unavailable");};
    try{await assert.rejects(successCore.executeProductionDeployment(fx.projectId,fx.developer,request(lost)),/unavailable/);}finally{store.completeProductionDeployment=complete;}
    const restarted=new CoreApiService(store,{authenticator:fx.core.authenticator,productionDeployment:{signingSecret:secret,testOnlyEmulator:store instanceof SoftwareFactoryControlPlaneStore,executors:{terminal:async()=>{throw new Error("must not redeploy");}}}});
    assert.equal((await restarted.executeProductionDeployment(fx.projectId,fx.developer,request(lost))).status,"RUNNING"); assert.equal(calls,3);
    assert.equal((await fx.core.getProductionDeployment(fx.projectId,fx.auditor,lost.approval.approval_id))?.status,"RUNNING");
    const stale=await approve(); fx.git(["commit","--allow-empty","-m","new main"]);
    await assert.rejects(fx.core.executeProductionDeployment(fx.projectId,fx.developer,request(stale)),/stale against live main/); assert.equal(calls,3);
  }finally{fx.cleanup();}
}

describe("M6C-3 signed production deployment gate",()=>{
  it("memory: approval RBAC, binding, no bypass, committed claim, concurrent replay and target exclusion",async()=>{await normalGate(new SoftwareFactoryControlPlaneStore());});
  it("memory: revoke, expiry, timeout, unknown outcome, restart and stale release",()=>faultGate(new SoftwareFactoryControlPlaneStore()));
  it("HTTP: server-selected backend and signed approver action; request cannot inject deploy parameters",async()=>{
    assert.throws(()=>new CoreApiService(new SoftwareFactoryControlPlaneStore(),{productionDeployment:{signingSecret:"short"}}),/at least 32 bytes/);
    assert.throws(()=>new CoreApiService(new SoftwareFactoryControlPlaneStore(),{productionDeployment:{executors:{production:async()=>({receipt_sha256:receipt})}}}),/explicit approval signing secret/);
    assert.throws(()=>new CoreApiService(new SoftwareFactoryControlPlaneStore(),{productionDeployment:{signingSecret:secret,executors:{production:async()=>({receipt_sha256:receipt})}}}),/requires PostgreSQL/);
    const productionConfig={signingSecret:secret,executors:{production:async()=>({receipt_sha256:receipt})}};
    await assert.rejects(createCoreApiRuntime({env:{},requirePostgres:false,productionDeployment:productionConfig}),/PostgreSQL runtime is required/);
    await assert.rejects(createCoreApiRuntime({env:{},store:new SoftwareFactoryControlPlaneStore(),productionDeployment:productionConfig}),/requires PostgreSQL/);
    let calls=0; const fx=await fixture(new SoftwareFactoryControlPlaneStore(),{signingSecret:secret,executors:{production:async()=>{calls++;return{receipt_sha256:receipt};}}});
    const server=new CoreApiHttpServer({coreApi:fx.core}); const endpoint=await server.start();
    const post=async(path:string,body:unknown,auth=fx.human)=>fetch(`${endpoint.baseUrl}/api/v1/projects/${fx.projectId}/${path}`,{method:"POST",headers:{"content-type":"application/json",[CORE_API_AUTH_HEADER]:encodeCoreApiAuthHeader(auth)},body:JSON.stringify(body)});
    try{
      assert.equal((await post("deployment-approvals",fx.input,fx.developer)).status,403);
      const approvedResponse=await post("deployment-approvals",fx.input); assert.equal(approvedResponse.status,201);
      const approved=await approvedResponse.json() as {approval:{approval_id:string};approval_token:string}; const run={approval_id:approved.approval.approval_id,approval_token:approved.approval_token};
      assert.equal((await post("production-deployments",{...run,approval_id:"invalid"})).ok,false);
      assert.equal((await post("production-deployments",{...run,command:"arbitrary shell"})).ok,false); assert.equal(calls,0);
      const deployed=await post("production-deployments",run,fx.developer); assert.equal(deployed.status,200); assert.equal((await deployed.json() as {status:string}).status,"SUCCEEDED"); assert.equal(calls,1);
      const got=await fetch(`${endpoint.baseUrl}/api/v1/projects/${fx.projectId}/production-deployments/${run.approval_id}`,{headers:{[CORE_API_AUTH_HEADER]:encodeCoreApiAuthHeader(fx.auditor)}}); assert.equal(got.status,200);
    }finally{await server.stop();fx.cleanup();}
  });
  it("PostgreSQL: durable gate, replay/fault parity, tenant isolation and immutable SQL evidence",async(t)=>{
    const config=buildPostgresPoolConfigFromEnv();if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config);const repo=new PostgresControlPlaneRepository(pool);
    try{
      const checked=await normalGate(repo);await faultGate(repo);
      let replayCalls=0;
      const crash=await fixture(repo,{signingSecret:secret,executors:{production:async()=>{replayCalls++;return{receipt_sha256:receipt};}}});
      try {
        const approved=await crash.core.approveProductionDeployment(crash.projectId,crash.human,crash.input);
        const request={approval_id:approved.approval.approval_id,approval_token:approved.approval_token};
        const coreModule=pathToFileURL(resolve("apps/core-api/src/index.ts")).href; const dbModule=pathToFileURL(resolve("packages/database/src/index.ts")).href;
        const script=`import {CoreApiService} from ${JSON.stringify(coreModule)}; import {PostgresRuntimePool,PostgresControlPlaneRepository} from ${JSON.stringify(dbModule)};
const cfg=JSON.parse(process.env.SF_TEST_DEPLOY_CASE); const store=new PostgresControlPlaneRepository(new PostgresRuntimePool(cfg.database));
const core=new CoreApiService(store,{productionDeployment:{signingSecret:cfg.secret,executors:{production:async()=>process.exit(73)}}});
const auth=core.issueAuthContext({projectId:cfg.projectId,principalId:'developer',roles:['DEVELOPER']});await core.executeProductionDeployment(cfg.projectId,auth,cfg.request);`;
        assert.throws(()=>execFileSync(process.execPath,["--input-type=module","-e",script],{env:{...process.env,SF_TEST_DEPLOY_CASE:JSON.stringify({database:config,secret,projectId:crash.projectId,request})},timeout:20000,stdio:"pipe"}),(error:unknown)=>(error as {status?:number}).status===73);
        assert.equal((await crash.core.getProductionDeployment(crash.projectId,crash.auditor,request.approval_id))?.status,"RUNNING");
        assert.equal((await crash.core.executeProductionDeployment(crash.projectId,crash.developer,request)).status,"RUNNING");assert.equal(replayCalls,0);
      } finally {crash.cleanup();}

      assert.equal((await pool.queryInActiveTx("SELECT * FROM production_deployment_approvals;")).rowCount,0);
      assert.equal((await pool.queryInActiveTx("SELECT * FROM production_deployments;")).rowCount,0);
      await assert.rejects(repo.withRlsTransaction({...checked.scope,currentPrincipalId:"developer"},()=>pool.queryInActiveTx(
        "INSERT INTO production_deployment_approvals SELECT (jsonb_populate_record(NULL::production_deployment_approvals,to_jsonb(a)||jsonb_build_object('approval_id',gen_random_uuid(),'status','ACTIVE','issued_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '15 minutes'))).* FROM production_deployment_approvals a WHERE approval_id=$1;",
        [checked.approval.approval_id])),/Production approval must bind/);

      for(const sql of ["DELETE FROM production_deployment_approvals;","UPDATE production_deployment_approvals SET artifact_sha256=repeat('0',64);","DELETE FROM production_deployments;","UPDATE production_deployments SET target_key='attacker';"]){await assert.rejects(repo.withRlsTransaction(checked.scope,()=>pool.queryInActiveTx(sql)));}
      await assert.rejects(repo.withRlsTransaction(checked.scope,()=>pool.queryInActiveTx("UPDATE production_deployment_approvals SET status='ACTIVE' WHERE approval_id=$1;",[checked.approval.approval_id])),/immutable/);
      await assert.rejects(repo.withRlsTransaction(checked.scope,()=>pool.queryInActiveTx("UPDATE production_deployments SET status='RUNNING' WHERE deployment_id=$1;",[checked.deployment.deployment_id])),/terminal/);
      const foreign={currentProjectId:randomUUID(),currentRole:"core_api_service" as const};assert.equal(await repo.withRlsTransaction(foreign,()=>repo.getProductionDeploymentApproval(checked.approval.approval_id)),null);
      assert.equal(await repo.withRlsTransaction(foreign,()=>repo.getProductionDeploymentByApproval(checked.approval.approval_id)),null);
    }finally{await pool.close();}
  });
});
