import { createHmac, timingSafeEqual } from "node:crypto";

export interface ProtectedTemplateBinding {
  readonly environment: string;
  readonly projectId: string;
  readonly keyVersion: string;
  readonly promptId: string;
  readonly promptVersion: string;
  /** Service-internal template fingerprint. Never include it in telemetry events or errors. */
  readonly promptSha256: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

function bounded(value: string): boolean {
  return typeof value === "string" && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= 128;
}

function assertProtectedInput(input: ProtectedTemplateBinding, hmacKey: Uint8Array): void {
  if (!input || !UUID.test(input.projectId)
    || ![input.environment, input.keyVersion, input.promptId, input.promptVersion].every(bounded)
    || !SHA256.test(input.promptSha256)
    || !(hmacKey instanceof Uint8Array) || hmacKey.byteLength < 32 || hmacKey.byteLength > 128) {
    throw new Error("Invalid protected template binding");
  }
}

/** Derives the opaque reference in service memory; the plain fingerprint is not returned or logged. */
export function deriveProtectedTemplateHmac(
  input: ProtectedTemplateBinding,
  hmacKey: Uint8Array
): string {
  assertProtectedInput(input, hmacKey);
  return createHmac("sha256", hmacKey).update(JSON.stringify([
    "sf-telemetry-template-v1",
    input.environment,
    input.projectId,
    input.keyVersion,
    input.promptId,
    input.promptVersion,
    input.promptSha256,
  ])).digest("hex");
}

/** Constant-time fail-closed comparison for a trusted service that already owns the internal fingerprint. */
export function verifyProtectedTemplateHmac(
  input: ProtectedTemplateBinding,
  promptHmac: string,
  hmacKey: Uint8Array
): boolean {
  try {
    if (!SHA256.test(promptHmac)) return false;
    const expected = Buffer.from(deriveProtectedTemplateHmac(input, hmacKey), "hex");
    return timingSafeEqual(expected, Buffer.from(promptHmac, "hex"));
  } catch {
    return false;
  }
}
