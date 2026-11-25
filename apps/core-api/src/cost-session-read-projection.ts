import { COST_SESSION_READ_UUID, PostgresRlsError, readTimestamp, type ControlPlaneStore } from "@software-factory/database";
import type { CoreApiAuthContext } from "./index.ts";
import { ReadProjectionError } from "./project-read-projection.ts";

export class CostSessionReadProjectionService {
  private readonly store: ControlPlaneStore;
  private readonly verify: (auth: CoreApiAuthContext) => CoreApiAuthContext;

  constructor(store: ControlPlaneStore, verify: (auth: CoreApiAuthContext) => CoreApiAuthContext) {
    this.store = store;
    this.verify = verify;
  }

  async read(auth: CoreApiAuthContext, projectId: string, pipelineSessionId: string, query: URLSearchParams) {
    return (await this.readEncoded(auth, projectId, pipelineSessionId, query)).result;
  }

  async readEncoded(auth: CoreApiAuthContext, projectId: string, pipelineSessionId: string, query: URLSearchParams) {
    const deadlineAt = Date.now() + 5000;
    let verified: CoreApiAuthContext;
    try {
      verified = this.verify(auth);
    } catch {
      throw new ReadProjectionError(403, "ERR_FORBIDDEN_RLS");
    }
    if (COST_SESSION_READ_UUID.test(projectId) && verified.projectId !== projectId) {
      throw new ReadProjectionError(403, "ERR_FORBIDDEN_RLS");
    }
    if (!COST_SESSION_READ_UUID.test(projectId) || !COST_SESSION_READ_UUID.test(pipelineSessionId) || query.size) {
      throw new ReadProjectionError(400, "ERR_READ_QUERY_INVALID");
    }

    try {
      const { fetchedAt, costSession } = await this.store.readCostSessionProjection({
        projectId, pipelineSessionId, principalId: verified.principalId, signedRoles: verified.roles, deadlineAt,
      });
      const result = { schemaVersion: "dashboard-read-v1" as const, fetchedAt: readTimestamp(fetchedAt), projectId, pipelineSessionId, costSession };
      if (Date.now() >= deadlineAt) throw new Error("Read response bound exceeded");
      const payload = Buffer.from(JSON.stringify(result), "utf8");
      if (payload.length > 1048576) throw new Error("Read response bound exceeded");
      return { result, payload };
    } catch (error) {
      if (error instanceof PostgresRlsError && error.sqlState === "42501") throw new ReadProjectionError(403, "ERR_FORBIDDEN_RLS");
      if (error instanceof PostgresRlsError && error.sqlState === "23503") throw new ReadProjectionError(404, "ERR_READ_RESOURCE_NOT_FOUND");
      throw new ReadProjectionError(500, "ERR_READ_PROJECTION_FAILED");
    }
  }
}
