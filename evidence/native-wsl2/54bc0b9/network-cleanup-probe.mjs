import assert from 'node:assert/strict';
import {it} from 'node:test';
import {execFileSync,spawn} from 'node:child_process';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
const source='/opt/software-factory', expected='54bc0b9ff3b87435b2f22c5abcedb06cac5850a0';
const cgroupRoot='/sys/fs/cgroup/unified/sf-native-acceptance';
assert.equal(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),expected);
assert.equal(execFileSync('git',['-C',source,'status','--porcelain'],{encoding:'utf8'}).trim(),'');
console.log('Source '+expected+'; boot '+readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim());
async function until(fn,ms=8000){const end=Date.now()+ms;while(!fn()){if(Date.now()>=end)throw new Error('Kernel cleanup deadline');await new Promise(r=>setTimeout(r,25));}}
for(const mode of ['coordinator-death','native-timeout'])it('New network namespace: detached descendant cleanup after '+mode,async()=>{
 const root=mkdtempSync('/var/lib/sf-native-net-cleanup-');chmodSync(root,0o755);const workspace=join(root,'workspace');mkdirSync(workspace,0o777);chmodSync(workspace,0o777);
 const taskId=randomUUID(),scope=join(cgroupRoot,'software-factory.slice',`sf-task-${taskId}-epoch-1.scope`);
 const payload="require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>{},60000);";
 const script=`import assert from 'node:assert/strict';import {LinuxCgroupV2SandboxBackend} from '${source}/packages/wna/src/index.ts';
 const backend=new LinuxCgroupV2SandboxBackend({cgroupRoot:${JSON.stringify(cgroupRoot)}});
 const result=backend.spawnRealProcessInSandbox({taskId:${JSON.stringify(taskId)},leaseEpoch:1,command:process.execPath,args:['-e',${JSON.stringify(payload)}],sanitizedEnv:{PATH:'/usr/bin:/bin'},cwd:${JSON.stringify(workspace)},worktreePath:${JSON.stringify(workspace)},requireKernelCgroup:true,requireSubreaper:true,requireNamespaceIsolation:true,requireNetworkIsolation:true,dropPrivileges:true,externalWorkerGuard:{maxRuntimeMs:${mode==='native-timeout'?1000:10000}}});
 assert.ok(result.securityMetadata.namespaces.includes('net'));assert.equal(result.securityMetadata.isSimulated,false);console.log('READY_NET');
 const exit=await result.exitPromise;const proof=await backend.killAndVerifyClean(${JSON.stringify(taskId)},1);
 assert.equal(exit.code,124);assert.equal(proof.isSimulated,false);assert.equal(proof.realKernelOperationsExecuted,true);assert.equal(proof.populatedZeroVerified,true);assert.equal(proof.cgroupDirRemoved,true);assert.equal(proof.remainingProcsCount,0);console.log('VERIFIED_NET_CLEANUP');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:source,env:{PATH:'/opt/sf-native-node/bin:/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='',passed=false;
 child.stdout.on('data',s=>{stdout+=s;});child.stderr.on('data',s=>{stderr+=s;});
 const closed=new Promise(resolve=>child.once('close',resolve));
 try{
  await until(()=>stdout.includes('READY_NET') || child.exitCode!==null);assert.ok(stdout.includes('READY_NET'),stderr);
  if(mode==='coordinator-death'){child.kill('SIGKILL');await closed;await until(()=>!existsSync(scope));}
  else {assert.equal(await closed,0,stderr);assert.ok(stdout.includes('VERIFIED_NET_CLEANUP'));}
  assert.equal(existsSync(scope),false);passed=true;
 }finally{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');if(passed)rmSync(root,{recursive:true,force:true});}
});
