import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { chmodSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { NativeLimaWorkerConnector, nativeVmProfileSha256, createNativeWorkerService, type NativeLimaWorkerConfig } from "@software-factory/wna";
import { signTargetProtocol,validateNativeWorkerAttestation, type ExternalTargetAction, type NativeWorkerAttestation } from "@software-factory/adapter-sdk";
import { canonicalizeJson,sha256Hex } from "@software-factory/shared-types";
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"sf-m6c3-a-native-lima-")));chmodSync(root,0o700);
  const limaHome=join(root,"lima"),controlHome=join(root,"control");mkdirSync(limaHome,0o700);mkdirSync(controlHome,0o700);
  const instance="sf-native-acceptance";mkdirSync(join(limaHome,instance),0o700);
  const config={plain:true,vmType:"vz",arch:process.arch==="x64"?"x86_64":"aarch64",images:[{arch:process.arch==="x64"?"x86_64":"aarch64",digest:"sha256:"+"b".repeat(64),location:join(controlHome,"guest.img")}],mounts:[],copyToHost:[],ssh:{forwardAgent:false,forwardX11:false,forwardX11Trusted:false,loadDotSSHPubKeys:false},containerd:{system:false,user:false},portForwards:[{hostIP:"127.0.0.1",guestIP:"127.0.0.1",hostPort:56620,guestPort:24443,hostPortRange:[56620,56620],guestPortRange:[24443,24443],proto:"tcp",static:true}]};
  const entry={name:instance,status:"Running",dir:join(limaHome,instance),arch:process.arch==="x64"?"x86_64":"aarch64",vmType:"vz",limaVersion:"v2.3.0",config};
  const file=join(root,"entry.json"),log=join(root,"argv.log"),binary=join(root,"limactl");writeFileSync(file,JSON.stringify(entry));
  writeFileSync(binary,`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,lima:process.env.LIMA_HOME,secret:process.env.SF_HOST_CANARY,ssh:process.env.SSH_AUTH_SOCK})+'\\n');if(process.argv[2]==='--version')console.log('limactl version 2.3.0');else console.log(fs.readFileSync(${JSON.stringify(file)},'utf8'));`);chmodSync(binary,0o700);
  const profile={instanceId:instance,sourceSha:"a".repeat(40),imageSha256:"b".repeat(64),limaConfigSha256:sha256Hex(canonicalizeJson(config))};
  const registration:NativeLimaWorkerConfig={binaryPath:binary,binarySha256:createHash("sha256").update(readFileSync(binary)).digest("hex"),limaHome,controlHome,dedicatedInstance:true,profile,guestHttpsPort:24443,worker:{endpoint:"https://127.0.0.1:56620/",principalId:"native-principal",workerId:"native-worker",provider:"native-acceptance",model:"provider-free",signingSecret:randomBytes(32).toString("hex")},testOnlyEmulator:true};
  const measurements:NativeWorkerAttestation={schema_version:"sf-native-worker-v1",instance_id:instance,source_sha:profile.sourceSha,profile_sha256:nativeVmProfileSha256(profile),guest_os:"ubuntu:24.04",guest_kernel:"6.8.0-test",guest_arch:process.arch as "x64"|"arm64",guest_boot_id:randomUUID()};
  const calls:string[]=[];let attestation:NativeWorkerAttestation|undefined=measurements;
  const priorFetch=globalThis.fetch;
  globalThis.fetch=(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const route=new URL(String(url)).pathname;calls.push(route);
    const request=JSON.parse(String(init?.body)) as {nonce:string;action:ExternalTargetAction};
    const body={schema_version:"sf-target-v1",nonce:request.nonce,target_type:"user_managed_worker",principal_id:registration.worker.principalId,worker_id:registration.worker.workerId,provider:registration.worker.provider,model:registration.worker.model,...(route==="/health"?{capabilities:["code-import-v1","idempotent-execution","lease-fenced-results"],...(attestation?{runtime_attestation:attestation}:{})}:{execution_id:request.action.execution_id,lease_epoch:request.action.lease_epoch,submission:{kind:"artifact",files:[{action:"write",path:"src/value.txt",content_base64:Buffer.from("implemented").toString("base64"),mode:"100644"}]}})};
    return new Response(JSON.stringify(body),{headers:{"content-type":"application/json","x-sf-target-signature":signTargetProtocol(registration.worker.signingSecret,"response",route,request.nonce,body)}});
  }) as typeof fetch;
  return {root,entry,file,log,registration,measurements,calls,setAttestation:(value:NativeWorkerAttestation|undefined)=>{attestation=value;},update:()=>writeFileSync(file,JSON.stringify(entry)),cleanup:()=>{globalThis.fetch=priorFetch;rmSync(root,{recursive:true,force:true});}};
}
const action=():ExternalTargetAction=>({execution_id:randomUUID(),task_id:randomUUID(),lease_epoch:1,base_main_commit_hash:"c".repeat(40),deadline:new Date(Date.now()+20000).toISOString(),allowed_files:["src/**"],public_context:"Public test fixture"});
describe("Native Lima worker bridge — transport fixtures, not VM acceptance",()=>{
  it("uses only pinned read-only CLI inspection and signed HTTPS worker protocol",async()=>{
    const prior=process.env.SF_HOST_CANARY;process.env.SF_HOST_CANARY="host-canary-fixture";
    const fx=fixture();
    try{
      const bridge=new NativeLimaWorkerConnector(fx.registration);
      const health=await bridge.health(AbortSignal.timeout(5000));assert.deepEqual(health.runtime_attestation,fx.measurements);
      assert.equal((await bridge.execute(action(),AbortSignal.timeout(5000))).kind,"artifact");
      assert.deepEqual(fx.calls,["/health","/health","/execute","/health"]);
      const commands=readFileSync(fx.log,"utf8").trim().split("\n").map(line=>JSON.parse(line) as {args:string[];home:string;lima:string;secret?:string;ssh?:string});
      for(const c of commands){assert.ok(c.args[0]==="--version" || JSON.stringify(c.args)===JSON.stringify(["list","--json",fx.registration.profile.instanceId]));assert.equal(c.home,fx.registration.controlHome);assert.equal(c.lima,fx.registration.limaHome);assert.equal(c.secret,undefined);assert.equal(c.ssh,undefined);}
    }finally{fx.cleanup();if(prior===undefined)delete process.env.SF_HOST_CANARY;else process.env.SF_HOST_CANARY=prior;}
  });
  for(const mutation of ["stopped","mount","agent","x11","containerd","copy","forward","wide-port-range","version","config-hash","instance-path","binary"]){
    it(`rejects ${mutation} registration before touching worker`,async()=>{
      const fx=fixture();try{
        const bridge=new NativeLimaWorkerConnector(fx.registration);
        switch(mutation){
          case "stopped":fx.entry.status="Stopped";break;
          case "mount":(fx.entry.config.mounts as unknown[]).push({location:"/Users"});break;
          case "agent":fx.entry.config.ssh.forwardAgent=true;break;
          case "x11":fx.entry.config.ssh.forwardX11Trusted=true;break;
          case "containerd":fx.entry.config.containerd.system=true;break;
          case "copy":(fx.entry.config.copyToHost as unknown[]).push({guestFile:"/root/key",hostFile:"/tmp/key"});break;
          case "forward":fx.entry.config.portForwards[0]!.hostIP="0.0.0.0";break;
          case "wide-port-range":fx.entry.config.portForwards[0]!.hostPortRange=[1,65535];break;
          case "version":fx.entry.limaVersion="2.0.3";break;
          case "config-hash":(fx.entry.config as unknown as Record<string,unknown>).unexpected="changed";break;
          case "instance-path":fx.entry.dir=join(fx.root,"default");break;
          case "binary":writeFileSync(fx.registration.binaryPath,"modified");break;
        }
        fx.update();await assert.rejects(bridge.health(AbortSignal.timeout(3000)),/ERR_NATIVE_VM/);assert.equal(fx.calls.length,0);
      }finally{fx.cleanup();}
    });
  }
  it("rejects missing/wrong source measurements and pins boot identity through execution",async()=>{
    const fx=fixture();try{
      const bridge=new NativeLimaWorkerConnector(fx.registration);
      fx.setAttestation(undefined);await assert.rejects(bridge.health(AbortSignal.timeout(3000)),/MEASUREMENTS/);
      fx.setAttestation({...fx.measurements,source_sha:"d".repeat(40)});await assert.rejects(bridge.health(AbortSignal.timeout(3000)),/MEASUREMENTS/);
      fx.setAttestation(fx.measurements);await bridge.health(AbortSignal.timeout(3000));
      fx.setAttestation({...fx.measurements,guest_boot_id:randomUUID()});await assert.rejects(bridge.execute(action(),AbortSignal.timeout(3000)),/MEASUREMENTS/);
      assert.equal(fx.calls.includes("/execute"),false);
    }finally{fx.cleanup();}
  });
  it("withholds an otherwise valid artifact when the guest reboots after execution",async()=>{
    const fx=fixture();const fetchFixture=globalThis.fetch;let executes=0;
    globalThis.fetch=(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{const response=await fetchFixture(url,init);if(new URL(String(url)).pathname==="/execute"){executes++;fx.setAttestation({...fx.measurements,guest_boot_id:randomUUID()});}return response;}) as typeof fetch;
    try{const bridge=new NativeLimaWorkerConnector(fx.registration);await assert.rejects(bridge.execute(action(),AbortSignal.timeout(5000)),/MEASUREMENTS/);assert.equal(executes,1);}finally{fx.cleanup();}
  });
  it("rejects unsafe TLS environment and CLI failures do not print private config content",()=>{
    const fx=fixture();const prior=process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try{
      process.env.NODE_TLS_REJECT_UNAUTHORIZED="0";assert.throws(()=>new NativeLimaWorkerConnector(fx.registration),/ERR_NATIVE_VM_TLS/);
      if(prior===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=prior;
      const config=join(fx.root,"bad-config.json");writeFileSync(config,'{"signingSecret":"PRIVATE_CONFIG_CANARY",bad',{mode:0o600});
      assert.throws(()=>execFileSync(process.execPath,["packages/test-harness/src/native-vm-host-acceptance.ts",config,join(fx.root,"guest.json"),join(fx.root,"receipt.json")],{cwd:process.cwd(),encoding:"utf8",stdio:"pipe"}),(error:unknown)=>{const e=error as {status:number;stderr:string};assert.equal(e.status,1);assert.match(e.stderr,/ERR_NATIVE_HOST_ACCEPTANCE/);assert.equal(e.stderr.includes("PRIVATE_CONFIG_CANARY"),false);return true;});
      assert.equal(fx.calls.length,0);
    }finally{if(prior===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=prior;fx.cleanup();}
  });
  it("keeps native startup opt-in strict and refuses plaintext/default homes/loose permissions",()=>{
    const fx=fixture();try{
      for(const config of [{...fx.registration,dedicatedInstance:false},{...fx.registration,testOnlyEmulator:"true"},{...fx.registration,worker:{...fx.registration.worker,endpoint:"http://127.0.0.1:56620/"}},{...fx.registration,worker:{...fx.registration.worker,testOnlyLoopback:true}},{...fx.registration,profile:{...fx.registration.profile,instanceId:"default"}}])assert.throws(()=>new NativeLimaWorkerConnector(config as NativeLimaWorkerConfig));
      chmodSync(fx.registration.controlHome,0o755);assert.throws(()=>new NativeLimaWorkerConnector(fx.registration),/PRIVATE_ROOT/);
      assert.throws(()=>validateNativeWorkerAttestation({...fx.measurements,extra:"leak"}));
      if(process.platform!=="linux" || process.getuid?.()!==0)assert.throws(()=>createNativeWorkerService({} as never,{} as never),/GUEST_HOST/);
    }finally{fx.cleanup();}
  });
});
