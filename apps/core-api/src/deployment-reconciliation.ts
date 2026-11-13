import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalizeJson, sha256Hex, type ProductionReconciliationApprovalRecord, type ProductionResolutionEvidence } from "@software-factory/shared-types";
import { deploymentBindingSha256, validateResolutionEvidence, PostgresRlsError, type ControlPlaneStore } from "@software-factory/database";
import { validateDeploymentConfiguration, validateDeploymentStore, validateProductionId, type ProductionDeploymentConfiguration, type ProductionResolutionVerifier } from "./production-deployment.ts";

export interface ApproveReconciliationInput {
  readonly expected_outcome: "SUCCEEDED" | "NOT_DEPLOYED";
  readonly expected_evidence_sha256: string;
  readonly ttl_ms?: number;
}
export interface ExecuteReconciliationInput {
  readonly reconciliation_approval_id: string;
  readonly approval_token: string;
}
function strictKeys(value: object, keys: readonly string[]): void {
  if (!value || Array.isArray(value) || Object.keys(value).some((key)=>!keys.includes(key))) throw new PostgresRlsError("23514","Unknown reconciliation request fields");
}
function payload(record: ProductionReconciliationApprovalRecord): string {
  const { status: _status, token_sha256: _hash, ...binding } = record;
  return Buffer.from(canonicalizeJson({purpose:"sf-production-reconciliation-v1",...binding})).toString("base64url");
}
export class ProductionDeploymentReconciler {
  private readonly store: ControlPlaneStore;
  private readonly secret?: string;
  private readonly verifiers: Map<string,ProductionResolutionVerifier>;
  private readonly timeoutMs: number;
  constructor(store: ControlPlaneStore, config: ProductionDeploymentConfiguration = {}) {
    validateDeploymentConfiguration(config);validateDeploymentStore(store,config);
    this.store=store;this.secret=config.signingSecret;this.verifiers=new Map(Object.entries(config.resolutionVerifiers ?? {}));this.timeoutMs=config.timeoutMs ?? 30_000;
  }
  private sign(value: string): string {
    if (!this.secret) throw new PostgresRlsError("42501","Deployment reconciliation is disabled");
    return createHmac("sha256",this.secret).update(value).digest("hex");
  }
  private scope(projectId:string,actor:string){return{currentProjectId:projectId,currentPrincipalId:actor,currentRole:"core_api_service" as const};}
  private async snapshot(projectId:string,actor:string,originalApprovalId:string){
    validateProductionId(originalApprovalId);
    return this.store.withRlsTransaction(this.scope(projectId,actor),async()=>{
      const original=await this.store.getProductionDeploymentApproval(originalApprovalId);
      const deployment=await this.store.getProductionDeploymentByApproval(originalApprovalId);
      if(!original || !deployment || deployment.reconciled_at || !["RUNNING","UNKNOWN"].includes(deployment.status))throw new PostgresRlsError("23514","Deployment is not unresolved");
      return{original,deployment};
    });
  }
  private async observe(snapshot:Awaited<ReturnType<ProductionDeploymentReconciler["snapshot"]>>):Promise<ProductionResolutionEvidence>{
    const {original,deployment}=snapshot;const verifier=this.verifiers.get(original.target_key);
    if(!this.secret || !verifier)throw new PostgresRlsError("42501","No operator resolution verifier is configured for this target");
    const action=Object.freeze({deployment_id:deployment.deployment_id,project_id:original.project_id,release_id:original.release_id,release_package_sha256:original.release_package_sha256,commit_hash:original.commit_hash,artifact_sha256:original.artifact_sha256,target_key:original.target_key});
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const evidence=await Promise.race([verifier(action,controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error("Resolution lookup timed out"));},this.timeoutMs);})]);
      validateResolutionEvidence(evidence,original.artifact_sha256);
      return Object.freeze(structuredClone(evidence));
    }catch{controller.abort();throw new PostgresRlsError("23514","Provider terminal fence could not be verified; deployment remains HOLD");}
    finally{if(timer)clearTimeout(timer);}
  }
  public async preview(projectId:string,actor:string,originalApprovalId:string){
    this.store.assertOutsideTransaction();return this.observe(await this.snapshot(projectId,actor,originalApprovalId));
  }
  public async approve(projectId:string,actor:string,originalApprovalId:string,input:ApproveReconciliationInput){
    this.store.assertOutsideTransaction();strictKeys(input,["expected_outcome","expected_evidence_sha256","ttl_ms"]);
    const ttl=input.ttl_ms ?? 300_000;
    if(!Number.isSafeInteger(ttl)||ttl<1||ttl>900_000||!["SUCCEEDED","NOT_DEPLOYED"].includes(input.expected_outcome)||typeof input.expected_evidence_sha256!=="string"||!/^[a-f0-9]{64}$/.test(input.expected_evidence_sha256))throw new PostgresRlsError("23514","Invalid reconciliation decision or lifetime");
    const snapshot=await this.snapshot(projectId,actor,originalApprovalId);const evidence=await this.observe(snapshot);
    if(evidence.outcome!==input.expected_outcome||evidence.evidence_sha256!==input.expected_evidence_sha256)throw new PostgresRlsError("23514","Provider evidence differs from the approver decision");
    return this.store.withRlsTransaction(this.scope(projectId,actor),async()=>{
      const now=new Date(await this.store.clockTimestampIso());
      const record:ProductionReconciliationApprovalRecord={reconciliation_approval_id:randomUUID(),project_id:projectId,deployment_id:snapshot.deployment.deployment_id,original_approval_id:originalApprovalId,
        deployment_binding_sha256:deploymentBindingSha256(snapshot.original,snapshot.deployment),expected_status:snapshot.deployment.status as "RUNNING"|"UNKNOWN",evidence,approver_principal_id:actor,
        issued_at:now.toISOString(),expires_at:new Date(now.getTime()+ttl).toISOString(),token_sha256:"",status:"ACTIVE"};
      const encoded=payload(record);const token=`${encoded}.${this.sign(encoded)}`;
      return{approval:await this.store.createProductionReconciliationApproval({...record,token_sha256:sha256Hex(token)}),approval_token:token};
    });
  }
  public async execute(projectId:string,actor:string,input:ExecuteReconciliationInput){
    this.store.assertOutsideTransaction();strictKeys(input,["reconciliation_approval_id","approval_token"]);validateProductionId(input.reconciliation_approval_id);
    if(typeof input.approval_token!=="string"||input.approval_token.length>8192||!/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(input.approval_token))throw new PostgresRlsError("42501","Invalid reconciliation signature");
    const [encoded,mac]=input.approval_token.split(".") as [string,string];
    if(!timingSafeEqual(Buffer.from(this.sign(encoded),"hex"),Buffer.from(mac,"hex")))throw new PostgresRlsError("42501","Invalid reconciliation signature");
    const validated=await this.store.withRlsTransaction(this.scope(projectId,actor),async()=>{
      const approval=await this.store.getProductionReconciliationApproval(input.reconciliation_approval_id);
      if(!approval||approval.approver_principal_id!==actor||payload(approval)!==encoded||approval.token_sha256!==sha256Hex(input.approval_token))throw new PostgresRlsError("42501","Reconciliation signature binding mismatch");
      const existing=await this.store.getProductionReconciliation(approval.original_approval_id);
      if(existing){if(existing.reconciliation_id!==approval.reconciliation_approval_id)throw new PostgresRlsError("23505","Deployment already reconciled differently");return{approval,existing};}
      if(approval.status!=="ACTIVE"||Date.parse(approval.expires_at)<=Date.parse(await this.store.clockTimestampIso()))throw new PostgresRlsError("42501","Reconciliation approval expired or consumed");
      return{approval,existing:null};
    });
    if(validated.existing)return validated.existing;
    try {
      const snapshot=await this.snapshot(projectId,actor,validated.approval.original_approval_id);
      if(deploymentBindingSha256(snapshot.original,snapshot.deployment)!==validated.approval.deployment_binding_sha256 || snapshot.deployment.status!==validated.approval.expected_status)throw new PostgresRlsError("23514","Deployment changed after reconciliation approval");
      const fresh=await this.observe(snapshot);
      if(canonicalizeJson(fresh)!==canonicalizeJson(validated.approval.evidence))throw new PostgresRlsError("23514","Provider evidence changed after reconciliation approval");
      return await this.store.withRlsTransaction(this.scope(projectId,actor),()=>this.store.commitProductionReconciliation({project_id:projectId,reconciliation_approval_id:validated.approval.reconciliation_approval_id,token_sha256:sha256Hex(input.approval_token)}));
    } catch (error) {
      // A concurrent identical request or lost COMMIT response may have completed it.
      const existing=await this.store.withRlsTransaction(this.scope(projectId,actor),()=>this.store.getProductionReconciliation(validated.approval.original_approval_id));
      if(existing?.reconciliation_id===validated.approval.reconciliation_approval_id)return existing;
      throw error;
    }
  }
}
