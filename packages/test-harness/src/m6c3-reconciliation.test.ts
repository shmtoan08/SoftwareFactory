import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createCoreApiRuntime } from "../../../apps/core-api/src/runtime.ts";
import { CoreApiService, CoreApiHttpServer, CORE_API_AUTH_HEADER, encodeCoreApiAuthHeader, type ProductionDeploymentAction } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore, PostgresControlPlaneRepository, PostgresRuntimePool, buildPostgresPoolConfigFromEnv, type ControlPlaneStore } from "@software-factory/database";
import { sha256Hex, type ProductionResolutionEvidence } from "@software-factory/shared-types";
import { deploymentFixture, DEPLOYMENT_TEST_ARTIFACT as artifact, DEPLOYMENT_TEST_RECEIPT as receipt } from "./m6c3-deployment-fixture.ts";

const secret=randomBytes(32).toString("hex");
async function unresolved(store:ControlPlaneStore,status:"RUNNING"|"UNKNOWN",outcome:"SUCCEEDED"|"NOT_DEPLOYED"){
  let calls=0;let verifierCalls=0;let succeed=false;let evidence:ProductionResolutionEvidence|undefined;let unavailable=false;
  const fx=await deploymentFixture(store,{signingSecret:secret,executors:{production:async()=>{calls++;if(succeed)return{receipt_sha256:receipt};throw new Error("uncertain provider result");}},
    resolutionVerifiers:{production:async(action:Readonly<ProductionDeploymentAction>)=>{
      verifierCalls++;assert.equal(Object.isFrozen(action),true);assert.equal(action.artifact_sha256,artifact);
      if(unavailable)throw new Error("private-provider-credential");
      return evidence ?? {outcome,terminal_fence:true,provider_operation_id:`fence/${action.deployment_id}`,artifact_sha256:outcome==="SUCCEEDED"?artifact:null,evidence_sha256:sha256Hex(`proof:${action.deployment_id}`)};
    }}});
  const approved=await fx.core.approveProductionDeployment(fx.projectId,fx.human,fx.input);const request={approval_id:approved.approval.approval_id,approval_token:approved.approval_token};
  const complete=store.completeProductionDeployment;
  try{
    if(status==="RUNNING")store.completeProductionDeployment=async()=>{throw new Error("terminal write lost");};
    if(status==="RUNNING")await assert.rejects(fx.core.executeProductionDeployment(fx.projectId,fx.developer,request));
    else assert.equal((await fx.core.executeProductionDeployment(fx.projectId,fx.developer,request)).status,"UNKNOWN");
  }finally{store.completeProductionDeployment=complete;}
  const deployment=await fx.core.getProductionDeployment(fx.projectId,fx.auditor,request.approval_id);assert.ok(deployment);
  return{...fx,approved,request,deployment,calls:()=>calls,verifierCalls:()=>verifierCalls,setProof:(proof:ProductionResolutionEvidence)=>{evidence=proof;},setUnavailable:(value:boolean)=>{unavailable=value;},allowSuccess:()=>{succeed=true;}};
}
async function resolveCase(store:ControlPlaneStore,status:"RUNNING"|"UNKNOWN",outcome:"SUCCEEDED"|"NOT_DEPLOYED",lostCommit=false){
  const fx=await unresolved(store,status,outcome);
  try{
    const preview=await fx.core.previewProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id);
    await assert.rejects(fx.core.previewProductionReconciliation(fx.projectId,fx.developer,fx.request.approval_id),/Authorization/);
    const approval=await fx.core.approveProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id,{expected_outcome:preview.outcome,expected_evidence_sha256:preview.evidence_sha256});
    const execute={reconciliation_approval_id:approval.approval.reconciliation_approval_id,approval_token:approval.approval_token};
    await assert.rejects(fx.core.executeProductionReconciliation(fx.projectId,fx.developer,execute),/Authorization/);
    await assert.rejects(fx.core.executeProductionReconciliation(fx.projectId,fx.human,{...execute,approval_token:fx.approved.approval_token}),/binding/);
    await assert.rejects(fx.core.executeProductionReconciliation(fx.projectId,fx.human,{...execute,approval_token:`${execute.approval_token.slice(0,-1)}${execute.approval_token.endsWith("0")?"1":"0"}`}),/signature/);
    await assert.rejects(store.withRlsTransaction(fx.scope,()=>fx.core.executeProductionReconciliation(fx.projectId,fx.human,execute)),/own committed transaction/);
    // Reconciliation remains possible after main advances; it binds immutable old release evidence.
    if(status==="RUNNING")fx.git(["commit","--allow-empty","-m","main advanced during recovery"]);
    const originalTx=store.withRlsTransaction.bind(store),originalCommit=store.commitProductionReconciliation.bind(store);let committed=false;
    if(lostCommit){
      store.commitProductionReconciliation=async(input)=>{const result=await originalCommit(input);committed=true;return result;};
      store.withRlsTransaction=async(ctx,fn)=>{const result=await originalTx(ctx,fn);if(committed){committed=false;throw new Error("lost reconciliation COMMIT response");}return result;};
    }
    let results;
    try{results=await Promise.all(Array.from({length:lostCommit?1:5},()=>fx.core.executeProductionReconciliation(fx.projectId,fx.human,execute)));}
    finally{store.withRlsTransaction=originalTx;store.commitProductionReconciliation=originalCommit;}
    assert.equal(new Set(results.map((r)=>r.reconciliation_id)).size,1);assert.equal(results[0]!.outcome,outcome);assert.equal(fx.calls(),1);
    const original=await fx.core.getProductionDeployment(fx.projectId,fx.auditor,fx.request.approval_id);assert.equal(original?.status,status);assert.ok(original?.reconciled_at);
    assert.equal((await store.withRlsTransaction(fx.scope,()=>store.getProductionDeploymentApproval(fx.request.approval_id)))?.status,"CONSUMED");
    assert.equal((await fx.core.getProductionReconciliation(fx.projectId,fx.auditor,fx.request.approval_id))?.reconciliation_id,results[0]!.reconciliation_id);
    const before=fx.verifierCalls();await fx.core.executeProductionReconciliation(fx.projectId,fx.human,execute);assert.equal(fx.verifierCalls(),before,"completed replay does not query a provider");
    await assert.rejects(store.withRlsTransaction(fx.scope,()=>store.completeProductionDeployment({project_id:fx.projectId,deployment_id:fx.deployment.deployment_id,status:"SUCCEEDED",receipt_sha256:receipt})),/running deployment/);
    const audit=await store.withRlsTransaction(fx.scope,()=>store.listOutboxEventsForProject());assert.equal(audit.filter((e)=>e.event_type==="deployment.reconciled").length,1);assert.equal(JSON.stringify(audit).includes(execute.approval_token),false);
    if(status==="UNKNOWN"){
      fx.allowSuccess();const fresh=await fx.core.approveProductionDeployment(fx.projectId,fx.human,fx.input);
      assert.equal((await fx.core.executeProductionDeployment(fx.projectId,fx.developer,{approval_id:fresh.approval.approval_id,approval_token:fresh.approval_token})).status,"SUCCEEDED");assert.equal(fx.calls(),2);
    }
    return{projectId:fx.projectId,scope:fx.scope,originalApprovalId:fx.request.approval_id,approval:approval.approval,record:results[0]!};
  }finally{fx.cleanup();}
}
async function denials(store:ControlPlaneStore){
  const fx=await unresolved(store,"UNKNOWN","NOT_DEPLOYED");
  try{
    const preview=await fx.core.previewProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id);
    const timed=new CoreApiService(store,{authenticator:fx.core.authenticator,productionDeployment:{signingSecret:secret,testOnlyEmulator:store instanceof SoftwareFactoryControlPlaneStore,timeoutMs:10,resolutionVerifiers:{production:async(_action,signal)=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("provider timed out")),{once:true}))}}});
    await assert.rejects(timed.previewProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id),/terminal fence/);
    const disabled=new CoreApiService(store,{authenticator:fx.core.authenticator});await assert.rejects(disabled.previewProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id),/configured/);
    fx.setProof({...preview,terminal_fence:false} as never);await assert.rejects(fx.core.previewProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id),/terminal fence/);
    fx.setProof({...preview,outcome:"SUCCEEDED",artifact_sha256:"0".repeat(64)});await assert.rejects(fx.core.previewProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id));
    fx.setProof(preview);await assert.rejects(fx.core.approveProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id,{expected_outcome:"NOT_DEPLOYED",expected_evidence_sha256:"0".repeat(64)}),/differs/);
    const issue=(ttl_ms?:number)=>fx.core.approveProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id,{expected_outcome:preview.outcome,expected_evidence_sha256:preview.evidence_sha256,...(ttl_ms?{ttl_ms}:{})});
    const revoked=await issue();await fx.core.revokeProductionReconciliationApproval(fx.projectId,fx.human,revoked.approval.reconciliation_approval_id);
    await assert.rejects(fx.core.executeProductionReconciliation(fx.projectId,fx.human,{reconciliation_approval_id:revoked.approval.reconciliation_approval_id,approval_token:revoked.approval_token}),/expired or consumed/);
    await store.withRlsTransaction({currentRole:"system_admin_role"},()=>store.addProjectMembership({project_id:fx.projectId,principal_id:"second-approver",member_role:"PROJECT_APPROVER"}));
    const second=fx.core.issueAuthContext({projectId:fx.projectId,principalId:"second-approver",roles:["PROJECT_APPROVER"]});
    const nondelegable=await issue();
    await assert.rejects(fx.core.executeProductionReconciliation(fx.projectId,second,{reconciliation_approval_id:nondelegable.approval.reconciliation_approval_id,approval_token:nondelegable.approval_token}),/binding/);
    await assert.rejects(fx.core.revokeProductionReconciliationApproval(fx.projectId,second,nondelegable.approval.reconciliation_approval_id),/original approver/);
    const expired=await issue(250);await new Promise((r)=>setTimeout(r,300));await assert.rejects(fx.core.executeProductionReconciliation(fx.projectId,fx.human,{reconciliation_approval_id:expired.approval.reconciliation_approval_id,approval_token:expired.approval_token}),/expired/);
    const changed=await issue();const run={reconciliation_approval_id:changed.approval.reconciliation_approval_id,approval_token:changed.approval_token};fx.setProof({...preview,provider_operation_id:"fence/changed"});await assert.rejects(fx.core.executeProductionReconciliation(fx.projectId,fx.human,run),/evidence changed/);
    fx.setUnavailable(true);await assert.rejects(fx.core.executeProductionReconciliation(fx.projectId,fx.human,run),(error:unknown)=>!String(error).includes("private-provider-credential"));fx.setUnavailable(false);
    assert.equal(await fx.core.getProductionReconciliation(fx.projectId,fx.auditor,fx.request.approval_id),null);assert.equal((await fx.core.getProductionDeployment(fx.projectId,fx.auditor,fx.request.approval_id))?.reconciled_at,null);
    const blocked=await fx.core.approveProductionDeployment(fx.projectId,fx.human,fx.input);await assert.rejects(fx.core.executeProductionDeployment(fx.projectId,fx.developer,{approval_id:blocked.approval.approval_id,approval_token:blocked.approval_token}));assert.equal(fx.calls(),1);
    fx.setProof(preview);const rollback=await issue();const commit=store.commitProductionReconciliation.bind(store);
    store.commitProductionReconciliation=async(input)=>{await commit(input);throw new Error("failure before reconciliation commit");};
    try{await assert.rejects(fx.core.executeProductionReconciliation(fx.projectId,fx.human,{reconciliation_approval_id:rollback.approval.reconciliation_approval_id,approval_token:rollback.approval_token}),/before reconciliation commit/);}
    finally{store.commitProductionReconciliation=commit;}
    assert.equal(await fx.core.getProductionReconciliation(fx.projectId,fx.auditor,fx.request.approval_id),null);
    assert.equal((await fx.core.getProductionDeployment(fx.projectId,fx.auditor,fx.request.approval_id))?.reconciled_at,null);
    assert.equal((await store.withRlsTransaction(fx.scope,()=>store.getProductionReconciliationApproval(rollback.approval.reconciliation_approval_id)))?.status,"ACTIVE");
  }finally{fx.cleanup();}
}

async function stateRace(store:ControlPlaneStore){
  const fx=await unresolved(store,"RUNNING","SUCCEEDED");
  try{
    const proof=await fx.core.previewProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id);
    const approval=await fx.core.approveProductionReconciliation(fx.projectId,fx.human,fx.request.approval_id,{expected_outcome:proof.outcome,expected_evidence_sha256:proof.evidence_sha256});
    await store.withRlsTransaction(fx.scope,()=>store.completeProductionDeployment({project_id:fx.projectId,deployment_id:fx.deployment.deployment_id,status:"UNKNOWN",receipt_sha256:null}));
    await assert.rejects(fx.core.executeProductionReconciliation(fx.projectId,fx.human,{reconciliation_approval_id:approval.approval.reconciliation_approval_id,approval_token:approval.approval_token}),/changed after reconciliation approval/);
    assert.equal((await fx.core.getProductionDeployment(fx.projectId,fx.auditor,fx.request.approval_id))?.reconciled_at,null);assert.equal(fx.calls(),1);
  }finally{fx.cleanup();}
}

describe("M6C-3 evidence-bound deployment reconciliation",()=>{
  it("memory: signed decision, provider terminal fencing, atomic unlock, replay and late-completion guard",async()=>{const store=new SoftwareFactoryControlPlaneStore();await resolveCase(store,"UNKNOWN","NOT_DEPLOYED");await resolveCase(store,"RUNNING","SUCCEEDED",true);await denials(store);await stateRace(store);});
  it("HTTP: approver preview/approval/execute and auditor history; no developer force unlock",async()=>{
    const config={signingSecret:secret,resolutionVerifiers:{production:async()=>({outcome:"NOT_DEPLOYED" as const,terminal_fence:true as const,provider_operation_id:"fence/none",artifact_sha256:null,evidence_sha256:receipt})}};
    assert.throws(()=>new CoreApiService(new SoftwareFactoryControlPlaneStore(),{productionDeployment:config}),/requires PostgreSQL/);
    await assert.rejects(createCoreApiRuntime({env:{},requirePostgres:false,productionDeployment:config}),/PostgreSQL runtime is required/);
    const fx=await unresolved(new SoftwareFactoryControlPlaneStore(),"UNKNOWN","SUCCEEDED");const server=new CoreApiHttpServer({coreApi:fx.core});const endpoint=await server.start();
    const request=async(path:string,method:string,body?:unknown,auth=fx.human)=>fetch(`${endpoint.baseUrl}/api/v1/projects/${fx.projectId}/${path}`,{method,headers:{[CORE_API_AUTH_HEADER]:encodeCoreApiAuthHeader(auth),...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const prefix=`production-deployments/${fx.request.approval_id}`;
    try{
      assert.equal((await request(`${prefix}/reconciliation-evidence`,"GET",undefined,fx.developer)).status,403);
      const response=await request(`${prefix}/reconciliation-evidence`,"GET");assert.equal(response.status,200);const preview=await response.json() as ProductionResolutionEvidence;
      const approved=await request(`${prefix}/reconciliation-approvals`,"POST",{expected_outcome:preview.outcome,expected_evidence_sha256:preview.evidence_sha256});assert.equal(approved.status,201);
      const approval=await approved.json() as {approval:{reconciliation_approval_id:string};approval_token:string};
      const execute={reconciliation_approval_id:approval.approval.reconciliation_approval_id,approval_token:approval.approval_token};
      assert.equal((await request("deployment-reconciliations","POST",{...execute,force_unlock:true})).ok,false);
      assert.equal((await request("deployment-reconciliations","POST",execute,fx.developer)).status,403);
      assert.equal((await request("deployment-reconciliations","POST",execute)).status,200);
      assert.equal((await request(`${prefix}/reconciliation`,"GET",undefined,fx.auditor)).status,200);assert.equal(fx.calls(),1);
    }finally{await server.stop();fx.cleanup();}
  });
  it("PostgreSQL: durable evidence, idempotent lost-COMMIT recovery, FORCE RLS and trigger-only unlock",async(t)=>{
    const config=buildPostgresPoolConfigFromEnv();if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config);const store=new PostgresControlPlaneRepository(pool);
    try{
      const resolved=await resolveCase(store,"RUNNING","NOT_DEPLOYED",true);await resolveCase(store,"UNKNOWN","SUCCEEDED");await denials(store);await stateRace(store);
      for(const sql of ["UPDATE production_deployments SET reconciled_at=clock_timestamp();","DELETE FROM production_deployment_reconciliations;","UPDATE production_reconciliation_approvals SET evidence='{}';","UPDATE production_deployment_reconciliations SET outcome='SUCCEEDED';"]){await assert.rejects(store.withRlsTransaction(resolved.scope,()=>pool.queryInActiveTx(sql)));}
      await assert.rejects(store.withRlsTransaction(resolved.scope,()=>pool.queryInActiveTx("UPDATE production_reconciliation_approvals SET status='ACTIVE' WHERE reconciliation_approval_id=$1;",[resolved.approval.reconciliation_approval_id])),/immutable/);
      assert.equal((await pool.queryInActiveTx("SELECT * FROM production_deployment_reconciliations;")).rowCount,0);
      const foreign={currentProjectId:randomUUID(),currentPrincipalId:"human",currentRole:"core_api_service" as const};assert.equal(await store.withRlsTransaction(foreign,()=>store.getProductionReconciliation(resolved.originalApprovalId)),null);
      const durable=await store.withRlsTransaction(resolved.scope,()=>store.getProductionReconciliation(resolved.originalApprovalId));assert.equal(durable?.reconciliation_id,resolved.record.reconciliation_id);
      await assert.rejects(store.withRlsTransaction(resolved.scope,()=>pool.queryInActiveTx("SELECT public.fn_apply_deployment_reconciliation();")),/permission denied/);
      const raw=await unresolved(store,"UNKNOWN","SUCCEEDED");
      try{
        const evidence=await raw.core.previewProductionReconciliation(raw.projectId,raw.human,raw.request.approval_id);
        const approved=await raw.core.approveProductionReconciliation(raw.projectId,raw.human,raw.request.approval_id,{expected_outcome:evidence.outcome,expected_evidence_sha256:evidence.evidence_sha256});
        for(const patch of [{evidence:{...evidence,terminal_fence:false}},{evidence:{...evidence,extra:"forged"}},{evidence:{...evidence,artifact_sha256:"0".repeat(64)}},{expected_status:"RUNNING"},{deployment_binding_sha256:"0".repeat(64)},{approver_principal_id:"developer"}]){
          await assert.rejects(store.withRlsTransaction(raw.scope,()=>pool.queryInActiveTx(
            "INSERT INTO production_reconciliation_approvals SELECT (jsonb_populate_record(NULL::production_reconciliation_approvals,to_jsonb(a)||$2::jsonb||jsonb_build_object('reconciliation_approval_id',gen_random_uuid()))).* FROM production_reconciliation_approvals a WHERE reconciliation_approval_id=$1;",
            [approved.approval.reconciliation_approval_id,patch])),/Reconciliation requires/);
        }
        await assert.rejects(store.withRlsTransaction(raw.scope,()=>pool.queryInActiveTx(
          "INSERT INTO production_deployment_reconciliations(reconciliation_id,project_id,deployment_id,original_approval_id,outcome,evidence_sha256,approver_principal_id) VALUES($1,$2,$3,$4,'NOT_DEPLOYED',$5,'human');",
          [approved.approval.reconciliation_approval_id,raw.projectId,raw.deployment.deployment_id,raw.request.approval_id,evidence.evidence_sha256])),/Reconciliation requires a live approval/);
        assert.equal((await raw.core.getProductionDeployment(raw.projectId,raw.auditor,raw.request.approval_id))?.reconciled_at,null);
        assert.equal((await store.withRlsTransaction(raw.scope,()=>store.getProductionReconciliationApproval(approved.approval.reconciliation_approval_id)))?.status,"ACTIVE");
      }finally{raw.cleanup();}
      const fn=(await pool.queryInActiveTx("SELECT p.prosecdef,p.proowner::regrole::text AS owner,p.proconfig FROM pg_proc p WHERE p.oid='public.fn_apply_deployment_reconciliation()'::regprocedure;")).rows[0]!;
      assert.equal(fn.prosecdef,true);assert.equal(fn.owner,"db_migrator");assert.match(JSON.stringify(fn.proconfig),/pg_catalog, public/);
      const tables=await pool.queryInActiveTx("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('production_reconciliation_approvals'::regclass,'production_deployment_reconciliations'::regclass);");
      assert.equal(tables.rowCount,2);for(const row of tables.rows){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}

    }finally{await pool.close();}
  });
});
