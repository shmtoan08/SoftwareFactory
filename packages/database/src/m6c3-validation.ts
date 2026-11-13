import type { VerificationRunRecord } from "@software-factory/shared-types";
import { PostgresRlsError } from "./types.ts";

export function validateVerificationIsolation(input: Pick<VerificationRunRecord,
  "isolation_runtime" | "execution_backend" | "is_docker_isolated" | "hermetic_network_disabled" | "verifier_image_digest">): void {
  if (input.isolation_runtime == null) return;
  if (input.isolation_runtime !== "runsc" || (input.execution_backend ?? "docker") !== "docker"
    || input.is_docker_isolated !== true || input.hermetic_network_disabled === false
    || !/^sha256:[a-f0-9]{64}$/.test(input.verifier_image_digest)) {
    throw new PostgresRlsError("23514", "runsc evidence requires isolated, network-disabled Docker and an immutable image digest");
  }
}
