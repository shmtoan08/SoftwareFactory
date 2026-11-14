import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { canonicalizeJson, sha256Hex } from "@software-factory/shared-types";
import { UserManagedWorkerHttpConnector, type ExecutionTargetConnector, type ExternalTargetAction, type HttpExecutionTargetOptions, type NativeWorkerAttestation } from "@software-factory/adapter-sdk";
import { LimaVmBackend } from "./vm-lima-backend.ts";

export interface NativeVmProfile {
  readonly instanceId: string;
  readonly sourceSha: string;
  /** Operator-recorded image provenance; not a measurement of the running root filesystem. */
  readonly imageSha256: string;
  readonly limaConfigSha256: string;
}
export function nativeVmProfileSha256(profile: NativeVmProfile): string {
  if (Object.keys(profile).sort().join()!=="imageSha256,instanceId,limaConfigSha256,sourceSha" || !/^sf-native-[a-z0-9-]{1,40}$/.test(profile.instanceId) || !/^[a-f0-9]{40}$/.test(profile.sourceSha) || ![profile.imageSha256,profile.limaConfigSha256].every(s=>typeof s==="string" && /^[a-f0-9]{64}$/.test(s))) throw new Error("ERR_NATIVE_VM_PROFILE");
  return sha256Hex(canonicalizeJson(profile));
}
export interface NativeLimaWorkerConfig {
  readonly binaryPath: string;
  readonly binarySha256: string;
  readonly limaHome: string;
  readonly controlHome: string;
  readonly dedicatedInstance: true;
  readonly profile: NativeVmProfile;
  readonly guestHttpsPort: number;
  readonly worker: Omit<HttpExecutionTargetOptions,"testOnlyLoopback">;
  /** Process fixtures only; never evidence of a native guest. */
  readonly testOnlyEmulator?: boolean;
}
function trustedAncestors(path:string):void {
  let current=dirname(path);
  while(true){const s=lstatSync(current);if(!s.isDirectory() || ![0,process.getuid?.()].includes(s.uid) || (s.mode & 0o022)!==0 && !(s.uid===0 && (s.mode & 0o1000)!==0))throw new Error("ERR_NATIVE_VM_PRIVATE_ROOT");const parent=dirname(current);if(parent===current)break;current=parent;}
}
function privateDirectory(path:string):void {
  if (!isAbsolute(path) || realpathSync(path)!==path) throw new Error("ERR_NATIVE_VM_PRIVATE_ROOT");
  trustedAncestors(path);
  const stat=lstatSync(path);
  if (!stat.isDirectory() || stat.uid!==process.getuid?.() || (stat.mode & 0o077)!==0) throw new Error("ERR_NATIVE_VM_PRIVATE_ROOT");
}
function empty(value:unknown):boolean {return value===undefined || value===null || Array.isArray(value) && value.length===0;}
/** Already-running, operator-provisioned guest only. No lifecycle, SSH shell or implicit provisioning. */
export class NativeLimaWorkerConnector implements ExecutionTargetConnector {
  readonly targetType="user_managed_worker" as const;
  readonly principalId:string; readonly workerId:string; readonly provider:string; readonly model:string;
  private readonly config:NativeLimaWorkerConfig;
  private readonly backend:LimaVmBackend;
  private readonly worker:UserManagedWorkerHttpConnector;
  private readonly profileHash:string;
  private bootId:string|undefined;
  constructor(config:NativeLimaWorkerConfig) {
    if (config.dedicatedInstance!==true || config.testOnlyEmulator!==undefined && typeof config.testOnlyEmulator!=="boolean" || process.platform!=="darwin" && config.testOnlyEmulator!==true) throw new Error("ERR_NATIVE_VM_HOST");
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined && process.env.NODE_TLS_REJECT_UNAUTHORIZED!=="1")throw new Error("ERR_NATIVE_VM_TLS");
    this.profileHash=nativeVmProfileSha256(config.profile);
    privateDirectory(config.controlHome);privateDirectory(config.limaHome);
    if (config.controlHome===homedir() || config.limaHome===join(homedir(),".lima") || !isAbsolute(config.binaryPath) || !/^[a-f0-9]{64}$/.test(config.binarySha256)) throw new Error("ERR_NATIVE_VM_PRIVATE_ROOT");
    const endpoint=new URL(config.worker.endpoint);
    if (endpoint.protocol!=="https:" || endpoint.hostname!=="127.0.0.1" || endpoint.pathname!=="/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !Number.isInteger(config.guestHttpsPort) || config.guestHttpsPort<1024 || config.guestHttpsPort>65535 || endpoint.port==="") throw new Error("ERR_NATIVE_VM_ENDPOINT");
    if ("testOnlyLoopback" in config.worker) throw new Error("ERR_NATIVE_VM_ENDPOINT");
    this.config=Object.freeze({...config,profile:Object.freeze({...config.profile}),worker:Object.freeze({...config.worker})});
    this.worker=new UserManagedWorkerHttpConnector(config.worker);
    this.principalId=this.worker.principalId;this.workerId=this.worker.workerId;this.provider=this.worker.provider;this.model=this.worker.model;
    this.backend=new LimaVmBackend({binaryPath:config.binaryPath,instanceName:config.profile.instanceId,limaHome:config.limaHome,controlHome:config.controlHome,dedicatedInstance:true,testOnlyEmulator:config.testOnlyEmulator===true,commandTimeoutMs:5000,maxOutputBytes:1048576});
  }
  private async inspect(signal:AbortSignal):Promise<void> {
    signal.throwIfAborted();privateDirectory(this.config.limaHome);privateDirectory(this.config.controlHome);privateDirectory(join(this.config.limaHome,this.config.profile.instanceId));
    trustedAncestors(this.config.binaryPath);
    const binary=lstatSync(this.config.binaryPath);
    if (!binary.isFile() || binary.isSymbolicLink() || binary.size>128*1024*1024 || (binary.mode & 0o022)!==0 || ![0,process.getuid?.()].includes(binary.uid) || createHash("sha256").update(readFileSync(this.config.binaryPath)).digest("hex")!==this.config.binarySha256) throw new Error("ERR_NATIVE_VM_BINARY");
    const {probe,entry}=await this.backend.inspectNativeWorker(signal);
    const c=entry.config as Record<string,unknown>|undefined;
    const ssh=c?.ssh as Record<string,unknown>|undefined;
    const containerd=c?.containerd as Record<string,unknown>|undefined;
    const forwards=c?.portForwards;
    const endpoint=new URL(this.config.worker.endpoint);
    if (probe.status!=="Running" || probe.dir!==join(this.config.limaHome,this.config.profile.instanceId) || probe.vmType!=="vz" || probe.arch!==(process.arch==="x64"?"x86_64":"aarch64") || (typeof entry.limaVersion!=="string" || entry.limaVersion.replace(/^v/,"")!=="2.3.0")
      || !empty(entry.errors) || !c || c.plain!==true || c.vmType!=="vz" || c.arch!==probe.arch || !empty(c.additionalDisks) || !empty(c.networks) || !empty(c.mounts) || !empty(c.copyToHost) || ssh?.forwardAgent!==false || ssh?.forwardX11!==false || ssh?.forwardX11Trusted!==false || ssh?.loadDotSSHPubKeys!==false || containerd?.system!==false || containerd?.user!==false
      || !Array.isArray(forwards) || forwards.length!==1 || sha256Hex(canonicalizeJson(c))!==this.config.profile.limaConfigSha256) throw new Error("ERR_NATIVE_VM_REGISTRATION");
    const images=c.images;
    if (!Array.isArray(images) || images.length!==1 || images[0]?.arch!==probe.arch || images[0]?.digest!==`sha256:${this.config.profile.imageSha256}` || typeof images[0]?.location!=="string" || !isAbsolute(images[0].location)) throw new Error("ERR_NATIVE_VM_IMAGE");
    const f=forwards[0] as Record<string,unknown>;
    if (!f || f.hostIP!=="127.0.0.1" || f.guestIP!=="127.0.0.1" || f.hostPort!==Number(endpoint.port) || f.guestPort!==this.config.guestHttpsPort || f.static!==true || f.proto!=="tcp" || f.reverse===true || f.ignore===true || f.hostSocket || f.guestSocket || !empty(f.hostPortRange) && JSON.stringify(f.hostPortRange)!==JSON.stringify([Number(endpoint.port),Number(endpoint.port)]) || !empty(f.guestPortRange) && JSON.stringify(f.guestPortRange)!==JSON.stringify([this.config.guestHttpsPort,this.config.guestHttpsPort])) throw new Error("ERR_NATIVE_VM_FORWARD");
  }
  private checkMeasurements(a:NativeWorkerAttestation|undefined):NativeWorkerAttestation {
    if (!a || a.instance_id!==this.config.profile.instanceId || a.source_sha!==this.config.profile.sourceSha || a.profile_sha256!==this.profileHash || a.guest_arch!==process.arch || this.bootId!==undefined && a.guest_boot_id!==this.bootId) throw new Error("ERR_NATIVE_VM_MEASUREMENTS");
    this.bootId=a.guest_boot_id;return a;
  }
  async health(signal:AbortSignal) {
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
    await this.inspect(bounded);
    const result=await this.worker.health(bounded);
    const measurements=this.checkMeasurements(result.runtime_attestation);
    return {...result,runtime_attestation:measurements};
  }
  async execute(action:Readonly<ExternalTargetAction>,signal:AbortSignal) {
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(125000)]);
    await this.health(bounded);
    const submission=await this.worker.execute(action,bounded);
    // A registration change or reboot makes the result uncertain; do not auto-retry or export it.
    await this.health(bounded);
    return submission;
  }
}
