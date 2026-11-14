import assert from "node:assert/strict";
import { it } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { randomBytes,randomUUID } from "node:crypto";
import { join } from "node:path";
import { createServer } from "node:net";
import { createNativeWorkerService,nativeVmProfileSha256,WorkerExecutionJournal } from "@software-factory/wna";
import { UserManagedWorkerHttpConnector,type AgentRuntimeAdapter,type ExternalTargetAction } from "@software-factory/adapter-sdk";

const sourceRoot=process.env.SF_NATIVE_SOURCE_ROOT,cgroupRoot=process.env.SF_WORKER_TEST_CGROUP_ROOT;
if(process.platform!=="linux" || process.getuid?.()!==0 || !sourceRoot || !cgroupRoot)throw new Error("Native guest bootstrap acceptance requires Linux root, root-owned source and cgroup delegation; no skips");
it("strict measured guest service: signed source/boot identity, host-control masks, real cleanup and durable replay",async()=>{
  const root=mkdtempSync("/var/lib/sf-native-guest-test-");chmodSync(root,0o755);
  const stateDir=join(root,"state"),workspaces=join(root,"workspaces"),repo=join(root,"public-repo");
  for(const dir of [stateDir,workspaces,repo,join(repo,"src")])mkdirSync(dir,{mode:dir===stateDir?0o700:0o755});
  writeFileSync(join(stateDir,"service-secret"),"NATIVE_GUEST_SECRET_CANARY",{mode:0o600});
  writeFileSync(join(repo,"src/value.txt"),"baseline\n");
  const git=(args:string[],cwd=repo)=>execFileSync("git",["-c","core.hooksPath=/dev/null",...args],{cwd,encoding:"utf8",env:{PATH:"/usr/bin:/bin",GIT_AUTHOR_NAME:"Native acceptance",GIT_AUTHOR_EMAIL:"native@example.test",GIT_COMMITTER_NAME:"Native acceptance",GIT_COMMITTER_EMAIL:"native@example.test"},stdio:"pipe"}).trim();
  git(["init","--initial-branch=main"]);git(["add","."]);git(["commit","-m","public native acceptance baseline"]);
  const sourceSha=git(["rev-parse","HEAD"],sourceRoot!),commit=git(["rev-parse","HEAD"]);
  const profile={instanceId:"sf-native-guest-ci",sourceSha,imageSha256:"b".repeat(64),limaConfigSha256:"c".repeat(64)};
  const socketPath=`/run/sf-native-test-${randomUUID()}.sock`;
  let socketAccepted=false,invocations=0;
  const socket=createServer(s=>{socketAccepted=true;s.destroy();});
  await new Promise<void>(r=>socket.listen(socketPath,r));
  chmodSync(socketPath,0o777); // Prove the native mask, not an incidental socket ACL, blocks tasks.
  const script=`const fs=require('node:fs'),assert=require('node:assert/strict'),net=require('node:net');
    assert.notEqual(process.getuid(),0);
    assert.throws(()=>fs.readFileSync(${JSON.stringify(join(stateDir,"service-secret"))}));
    assert.throws(()=>fs.readFileSync(${JSON.stringify(join(sourceRoot!,"package.json"))}));
    assert.equal(Object.values(process.env).some(v=>v.includes('NATIVE_GUEST_SECRET_CANARY')),false);
    const s=net.connect(${JSON.stringify(socketPath)});s.once('connect',()=>process.exit(3));s.once('error',()=>{fs.writeFileSync('src/value.txt','native acceptance\\n');});
    setTimeout(()=>process.exit(4),1500).unref();`;
  const adapter:AgentRuntimeAdapter={runtimeId:"fake-agent-harness",writerProvider:"native-acceptance",writerModel:"provider-free",prepareInvocation:async()=>{invocations++;return{binaryPath:process.execPath,args:["-e",script],sanitizedEnv:{PATH:"/usr/bin:/bin"},timeoutMs:3000};},parseExecutionResult:async()=>{throw new Error("No untrusted Git parser");}};
  const config={tenantNamespace:"native-guest-acceptance",sourceRoot:sourceRoot!,stateDir,worktreeBaseDir:workspaces,baselineCommitRegistry:{[commit]:repo},cgroupRoot:cgroupRoot!,profile,principalId:"native-guest",workerId:"native-guest",signingSecret:randomBytes(32).toString("hex"),port:24000+process.pid%20000};
  let service:ReturnType<typeof createNativeWorkerService>|undefined;let passed=false;
  try{
    assert.throws(()=>createNativeWorkerService({...config,profile:{...profile,sourceSha:"0".repeat(40)}},adapter),/GUEST_SOURCE/);
    service=createNativeWorkerService(config,adapter);
    const address=await service.server.listen();
    // Local Linux protocol check only. The native host bridge requires HTTPS and has no plaintext flag.
    const connector=new UserManagedWorkerHttpConnector({endpoint:address.endpoint,principalId:config.principalId,workerId:config.workerId,provider:adapter.writerProvider,model:adapter.writerModel,signingSecret:config.signingSecret,testOnlyLoopback:true});
    const measured=(await connector.health(AbortSignal.timeout(10000))).runtime_attestation!;
    assert.equal(measured.source_sha,sourceSha);assert.equal(measured.profile_sha256,nativeVmProfileSha256(profile));
    assert.equal(measured.guest_boot_id,readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim());
    const action:ExternalTargetAction={execution_id:randomUUID(),task_id:randomUUID(),lease_epoch:1,base_main_commit_hash:commit,deadline:new Date(Date.now()+30000).toISOString(),allowed_files:["src/**"],public_context:"Public native acceptance fixture"};
    const result=await connector.execute(action,AbortSignal.timeout(15000));
    assert.equal(result.kind,"artifact");if(result.kind==="artifact")assert.equal(Buffer.from((result.files[0] as {content_base64:string}).content_base64,"base64").toString(),"native acceptance\n");
    assert.deepEqual(await connector.execute(action,AbortSignal.timeout(10000)),result);assert.equal(invocations,1);
    const record=new WorkerExecutionJournal(stateDir,config.tenantNamespace).read(action)!;
    assert.equal(record.status,"COMPLETED");assert.equal(record.cleanupEvidence?.isSimulated,false);assert.equal(record.cleanupEvidence?.realKernelOperationsExecuted,true);assert.equal(record.cleanupEvidence?.populatedZeroVerified,true);assert.equal(record.cleanupEvidence?.remainingProcsCount,0);assert.equal(record.cleanupEvidence?.cgroupDirRemoved,true);
    await assert.rejects(connector.execute({...action,lease_epoch:2},AbortSignal.timeout(10000)));
    assert.equal(socketAccepted,false);assert.equal(readFileSync(join(repo,"src/value.txt"),"utf8"),"baseline\n");passed=true;
  }finally{await service?.server.close();await new Promise<void>(r=>socket.close(()=>r()));if(passed)rmSync(root,{recursive:true,force:true});else process.stderr.write("Failed/uncertain native fixture state retained for inspection\n");}
});
