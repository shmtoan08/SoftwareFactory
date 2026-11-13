import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Docker3TierVerifier, KernelIsolationUnavailableError, buildDockerRunSecurityArgs, parseVerifierIsolationPolicy } from "@software-factory/verifier";
import { createCoreApiRuntime } from "../../../apps/core-api/src/runtime.ts";
import { SoftwareFactoryControlPlaneStore, PostgresControlPlaneRepository, PostgresRuntimePool, buildPostgresPoolConfigFromEnv, type ControlPlaneStore } from "@software-factory/database";
import { CoreApiService } from "@software-factory/core-api";
import { createGvisorVerifierFixture } from "./m6c3-verifier-fixture.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
async function recordFixture(store: ControlPlaneStore, fx: ReturnType<typeof createGvisorVerifierFixture>) {
  const projectId = fx.input.projectId;
  await store.withRlsTransaction({ currentRole: "system_admin_role" }, async () => {
    await store.createProject({ project_id: projectId, slug: `gvisor-${projectId}`, name: "gVisor", repo_bare_path: fx.repo, initial_main_commit_hash: fx.input.baseMainCommitHash });
    await store.addProjectMembership({ project_id: projectId, principal_id: "operator", member_role: "ORG_ADMIN" });
  });
  const core = new CoreApiService(store); const auth = core.issueAuthContext({ projectId, principalId: "operator", roles: ["ORG_ADMIN"] });
  const task = await core.createTask(projectId, auth, { title: "verify", task_contract: { allowed_files: ["src/**"] } });
  const lease = await core.dispatchTaskLease(projectId, auth, { task_id: task.task_id, worker_id: "worker" });
  const built = await core.buildMergeCandidateFromGit(projectId, auth, { task_id: task.task_id, lease_id: lease.lease_id, lease_epoch: lease.lease_epoch,
    staging_ref: `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`, agent_commit_hash: fx.input.mergeCandidateHash, repo_path: fx.repo, snapshot_store: fx.snapshotStore });
  assert.equal(built.ok, true); if (!built.ok) throw new Error("candidate failed");
  return { core, auth, task, built, scope: { currentProjectId: projectId, currentRole: "core_api_service" as const } };
}

async function withFakeDocker(run: (fx: ReturnType<typeof createGvisorVerifierFixture>, calls: () => string[][], state: (value: Record<string, unknown>) => void) => Promise<void>) {
  const fx = createGvisorVerifierFixture(); const bin = join(fx.root,"bin"); mkdirSync(bin);
  const log = join(fx.root,"calls.jsonl"); const stateFile = join(fx.root,"state.json");
  const state = (value: Record<string,unknown>) => writeFileSync(stateFile, JSON.stringify(value)); state({}); writeFileSync(log, "");
  // Process-level CLI double exercises real snapshot/Git + command construction, not kernel isolation.
  writeFileSync(join(bin,"docker"), `#!${process.execPath}
const fs=require('node:fs'); const a=process.argv.slice(2); const s=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
if(a[0]==='--version'){process.exit(s.noDocker?1:0);}
if(a[0]==='info'){if(s.noDaemon)process.exit(1); console.log(a[2].includes('Runtimes')?(s.malformed?'INVALID':JSON.stringify(s.noRuntime?{}:{runsc:{path:'runsc'}})):'test');}
else if(a[0]==='image'){if(s.noImage)process.exit(1);console.log(s.badDigest?'node:mutable':${JSON.stringify(DIGEST)});}
else if(a[0]==='run'){process.exit(s.launchFailure?125:0);}
`, { mode:0o700 });
  const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath}`;
  try { await run(fx, () => readFileSync(log,"utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s) as string[]), state); }
  finally { if(previousPath === undefined) delete process.env.PATH; else process.env.PATH=previousPath; fx.cleanup(); }
}

describe("M6C-3 gVisor verifier foundation", () => {
  it("server isolation policy rejects unknown configuration and downgrade attempts", async () => {
    assert.equal(parseVerifierIsolationPolicy(undefined),"standard"); assert.equal(parseVerifierIsolationPolicy("gvisor"),"gvisor");
    for(const value of ["", "runsc", "off", "GVISOR"]) assert.throws(()=>parseVerifierIsolationPolicy(value),KernelIsolationUnavailableError);
    await assert.rejects(createCoreApiRuntime({env:{SF_VERIFIER_ISOLATION:"off"},store:new SoftwareFactoryControlPlaneStore()}),KernelIsolationUnavailableError);
    await withFakeDocker(async(fx,calls) => {
      const runtime = await createCoreApiRuntime({env:{SF_VERIFIER_ISOLATION:"gvisor"},store:new SoftwareFactoryControlPlaneStore()});
      try {
        for(const input of [{executionMode:"subprocess" as const,requireKernelIsolation:false},{executionMode:"sandbox" as const},{networkDisabled:false}]) {
          await assert.rejects(runtime.verifier.runSingleAttempt({...fx.input,...input}),KernelIsolationUnavailableError);
        }
        assert.equal(calls().length,0,"forbidden modes cannot probe/execute Docker or host commands");
      } finally { await runtime.close(); }
      const options = {dockerImage:DIGEST,baselineDir:fx.repo,trustedAcceptanceDir:fx.input.trustedAcceptanceDir,command:["true"],isolationRuntime:"runsc" as const};
      assert.throws(()=>buildDockerRunSecurityArgs({...options,networkDisabled:false}),KernelIsolationUnavailableError);
      assert.throws(()=>buildDockerRunSecurityArgs({...options,isolationRuntime:"runc" as never}),KernelIsolationUnavailableError);
    });
  });
  it("missing/broken runsc fails closed; all tiers pin runtime and digest; evidence is report-bound and persisted in memory", async () => {
    await withFakeDocker(async(fx,calls,state) => {
      const verifier = new Docker3TierVerifier({snapshotStore:fx.snapshotStore,isolationPolicy:"gvisor"});
      for(const config of [{noDocker:true},{noDaemon:true},{noImage:true},{noRuntime:true},{malformed:true},{badDigest:true}]) {
        state(config); await assert.rejects(verifier.runSingleAttempt({...fx.input,requireKernelIsolation:false}),KernelIsolationUnavailableError);
      }
      assert.equal(calls().some((args)=>args[0]==="run"),false);
      state({launchFailure:true}); const failed=await verifier.verifyCandidateWithRetries(fx.input);
      assert.equal(failed.finalResult.overallStatus,"INFRA_ERROR"); assert.equal(failed.attempts.length,2);
      assert.equal(failed.finalResult.tierOutcomes[0]!.passed,false);
      state({}); const success=await verifier.runSingleAttempt(fx.input); assert.equal(success.verdict,"PASS");
      assert.equal(success.isolationRuntime,"runsc"); assert.equal(success.tierOutcomes.length,3);
      const runs = calls().filter((args)=>args[0]==="run"); assert.equal(runs.length,5);
      for(const args of runs){ assert.ok(args.includes("--runtime=runsc")); assert.ok(args.includes(DIGEST)); assert.ok(args.includes("--network=none")); assert.equal(args.includes("node:22-alpine"),false); }
      const standard=await new Docker3TierVerifier({snapshotStore:fx.snapshotStore}).runSingleAttempt(fx.input);
      assert.equal(standard.isolationRuntime,null); assert.notEqual(standard.reportSha256,success.reportSha256);
      const strengthened=await new Docker3TierVerifier({snapshotStore:fx.snapshotStore}).runSingleAttempt({...fx.input,requireKernelIsolation:true});
      assert.equal(strengthened.isolationRuntime,"runsc");
      const store=new SoftwareFactoryControlPlaneStore(); const fixture=await recordFixture(store,fx);
      const verified=await fixture.core.verifyMergeCandidate(fx.input.projectId,fixture.auth,{task_id:fixture.task.task_id,merge_candidate_id:fixture.built.mergeCandidate.merge_candidate_id,
        verifier,trusted_acceptance_dir:fx.input.trustedAcceptanceDir,tier1_command:fx.input.tier1Command,tier2_command:fx.input.tier2Command,tier3_command:fx.input.tier3Command});
      assert.equal(verified.finalRun.isolation_runtime,"runsc"); assert.equal(verified.finalRun.verifier_image_digest,DIGEST);
      const base={...verified.finalRun};
      for(const invalid of [{execution_backend:"host-subprocess" as const},{is_docker_isolated:false},{hermetic_network_disabled:false},{verifier_image_digest:"mutable"}]) {
        await assert.rejects(store.withRlsTransaction(fixture.scope,()=>store.recordVerificationRun({...base,...invalid})), /runsc evidence/);
      }
    });
  });
  it("PostgreSQL stores runtime evidence and rejects contradictory raw SQL under tenant RLS", async (t) => {
    const config=buildPostgresPoolConfigFromEnv(); if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config); const repo=new PostgresControlPlaneRepository(pool);
    try { await withFakeDocker(async(fx) => {
      const fixture=await recordFixture(repo,fx); const verifier=new Docker3TierVerifier({snapshotStore:fx.snapshotStore,isolationPolicy:"gvisor"});
      const verified=await fixture.core.verifyMergeCandidate(fx.input.projectId,fixture.auth,{task_id:fixture.task.task_id,merge_candidate_id:fixture.built.mergeCandidate.merge_candidate_id,
        verifier,trusted_acceptance_dir:fx.input.trustedAcceptanceDir,tier1_command:fx.input.tier1Command,tier2_command:fx.input.tier2Command,tier3_command:fx.input.tier3Command});
      assert.equal(verified.finalRun.isolation_runtime,"runsc");
      const stored=await repo.withRlsTransaction(fixture.scope,()=>repo.listVerificationRunsForTask(fixture.task.task_id));
      assert.equal(stored[0]!.isolation_runtime,"runsc");
      for(const invalid of [{execution_backend:"host-subprocess"},{is_docker_isolated:false},{hermetic_network_disabled:false},{isolation_runtime:"runc"},{verifier_image_digest:"mutable"}]) {
        // verification_runs is append-only; probe the CHECK on INSERT, without weakening grants.
        await assert.rejects(repo.withRlsTransaction(fixture.scope,()=>pool.queryInActiveTx(
          "INSERT INTO verification_runs SELECT (jsonb_populate_record(NULL::verification_runs, to_jsonb(v) || $2::jsonb || jsonb_build_object('verification_run_id',gen_random_uuid()))).* FROM verification_runs v WHERE verification_run_id=$1;",
          [verified.finalRun.verification_run_id,invalid])), /chk_vr_runsc_binding/);
      }
      assert.equal((await pool.queryInActiveTx("SELECT isolation_runtime FROM verification_runs WHERE verification_run_id=$1;",[verified.finalRun.verification_run_id])).rowCount,0);
    }); } finally {await pool.close();}
  });
});
