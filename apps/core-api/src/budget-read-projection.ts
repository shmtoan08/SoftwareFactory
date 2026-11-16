import { budgetReadResponse, PostgresRlsError, type ControlPlaneStore } from "@software-factory/database";
import { ReadProjectionError } from "./project-read-projection.ts";
import type { CoreApiAuthContext } from "./index.ts";

export class BudgetReadProjectionService {
  private readonly store: ControlPlaneStore;
  private readonly verify: (auth: unknown, projectId: string) => CoreApiAuthContext;
  constructor(store: ControlPlaneStore, verify: (auth: unknown, projectId: string) => CoreApiAuthContext) { this.store = store; this.verify = verify; }
  async read(auth: CoreApiAuthContext, projectId: string, query: URLSearchParams) {
    const deadlineAt = Date.now() + 5000;
    let verified: CoreApiAuthContext;
    try { verified = this.verify(auth, projectId); }
    catch { throw new ReadProjectionError(403, "ERR_FORBIDDEN_RLS"); }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(verified.projectId) || query.size) throw new ReadProjectionError(400, "ERR_READ_QUERY_INVALID");
    try {
      const rows = await this.store.readBudgetProjection({ projectId: verified.projectId, principalId: verified.principalId, signedRoles: verified.roles, deadlineAt });
      const result = budgetReadResponse(rows, verified.projectId);
      if (Date.now() >= deadlineAt || Buffer.byteLength(JSON.stringify(result)) > 1048576) throw new Error("Read response bound exceeded");
      return result;
    } catch (error) {
      if (error instanceof PostgresRlsError && error.sqlState === "42501") throw new ReadProjectionError(403, "ERR_FORBIDDEN_RLS");
      if (error instanceof PostgresRlsError && error.sqlState === "23503") throw new ReadProjectionError(404, "ERR_READ_RESOURCE_NOT_FOUND");
      throw new ReadProjectionError(500, "ERR_READ_PROJECTION_FAILED");
    }
  }
}
