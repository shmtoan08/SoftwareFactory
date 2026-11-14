/** Signed service measurements, not a claim of VM/kernel acceptance or hardware attestation. */
export interface NativeWorkerAttestation {
  readonly schema_version: "sf-native-worker-v1";
  readonly instance_id: string;
  readonly source_sha: string;
  readonly profile_sha256: string;
  readonly guest_kernel: string;
  readonly guest_os: string;
  readonly guest_arch: "x64" | "arm64";
  readonly guest_boot_id: string;
}
export function validateNativeWorkerAttestation(value: unknown): NativeWorkerAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native worker measurements");
  const a=value as NativeWorkerAttestation;
  if (Object.keys(a).sort().join() !== "guest_arch,guest_boot_id,guest_kernel,guest_os,instance_id,profile_sha256,schema_version,source_sha"
    || a.schema_version !== "sf-native-worker-v1" || typeof a.instance_id!=="string" || !/^[A-Za-z0-9._-]{1,64}$/.test(a.instance_id)
    || !/^[a-f0-9]{40}$/.test(a.source_sha) || !/^[a-f0-9]{64}$/.test(a.profile_sha256)
    || ![a.guest_kernel,a.guest_os].every(s=>typeof s==="string" && /^[A-Za-z0-9._:+ -]{1,128}$/.test(s))
    || !["x64","arm64"].includes(a.guest_arch) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(a.guest_boot_id)) throw new Error("Invalid native worker measurements");
  return Object.freeze({...a});
}
