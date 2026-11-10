import type {
  LeaseSyncStatusResponse,
  ServerEventAckContract,
  WorkerEventEnvelope,
} from "@software-factory/shared-types";
import type { SoftwareFactoryControlPlaneStore } from "@software-factory/database";
import type { AgentGatewayTransportClient } from "@software-factory/wna";

/**
 * AgentGatewayService (MVP-SPEC-01 Section 2 & MVP-SPEC-03 Section 2-3)
 * Mediates all Worker (WNA) traffic using scoped `gateway_service` RLS transactions.
 * Workers never receive direct PostgreSQL credentials.
 */
export class AgentGatewayService implements AgentGatewayTransportClient {
  private readonly store: SoftwareFactoryControlPlaneStore;
  private readonly projectId: string;
  private readonly workerPrincipalId: string;

  constructor(options: {
    store: SoftwareFactoryControlPlaneStore;
    projectId: string;
    workerPrincipalId?: string;
  }) {
    this.store = options.store;
    this.projectId = options.projectId;
    this.workerPrincipalId = options.workerPrincipalId ?? "wna-worker-node-01";
  }

  public async submitEvent(
    envelope: WorkerEventEnvelope,
    inTransactionDelayMs = 0
  ): Promise<ServerEventAckContract> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: this.projectId,
        currentPrincipalId: this.workerPrincipalId,
        currentRole: "gateway_service",
      },
      () => this.store.submitWorkerEvent(envelope, inTransactionDelayMs)
    );
  }

  public async getLeaseSyncStatus(leaseId: string): Promise<LeaseSyncStatusResponse> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: this.projectId,
        currentPrincipalId: this.workerPrincipalId,
        currentRole: "gateway_service",
      },
      () => {
        const sync = this.store.getLeaseSyncStatus(leaseId);
        if (!sync) {
          throw new Error(`Lease ${leaseId} not found in project ${this.projectId}`);
        }
        return sync;
      }
    );
  }

  public async authorizeAndPushStagingRef(input: {
    task_id: string;
    lease_id: string;
    lease_epoch: number;
    staging_ref: string;
    agent_commit_hash: string;
    verified_tree_hash: string;
    parent_commit_hashes: readonly string[];
  }): Promise<{ allowed: boolean; reason?: string }> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: this.projectId,
        currentPrincipalId: this.workerPrincipalId,
        currentRole: "gateway_service",
      },
      () =>
        this.store.pushStagingGitRefWithGatekeeper({
          project_id: this.projectId,
          ...input,
        })
    );
  }
}
