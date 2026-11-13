import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreApiService, type ProductionDeploymentConfiguration } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore, type ControlPlaneStore } from "@software-factory/database";
import { sha256Hex, type PipelineStageName, type StageArtifactKind } from "@software-factory/shared-types";
export const DEPLOYMENT_TEST_ARTIFACT=sha256Hex("approved artifact bytes");
export const DEPLOYMENT_TEST_RECEIPT=sha256Hex("provider receipt");
const artifact=DEPLOYMENT_TEST_ARTIFACT;
export async function deploymentFixture(store: ControlPlaneStore, config: ProductionDeploymentConfiguration) {
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
