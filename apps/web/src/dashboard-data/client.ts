import {
  DashboardDataError,
  mapAgentProfiles,
  type AgentProfileRole,
  mapBudgetSnapshot,
  mapProjectDetail,
  mapProjectList,
  mapSessionTasks,
  mapTaskAssignment,
  mapTaskDispatches,
  mapSessions,
  requireId,
} from "./mapping.ts";

type Source = { endpoint: string; projectId: string; sessionId?: string };
type HttpError = { kind: "bad-request" | "access-denied" | "not-found" | "server-error" | "http"; status: number };
type RequestError = HttpError | { kind: "timeout" | "network" } | { kind: "data"; message: string };

export type DashboardResult<T> =
  | { kind: "ok" | "empty"; source: Source; receivedAt: string; data: T }
  | { kind: "error"; source: Source; receivedAt: string | null; error: RequestError };

type PageOptions = { limit?: number; cursor?: string };
type TaskPageOptions = PageOptions & { sourceStatuses?: readonly string[] };

type ClientOptions = {
  baseUrl: string;
  projectId: string;
  /** Existing signed Core API token, encoded for the HTTP auth header. */
  authToken: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

function pageQuery(options: PageOptions): URLSearchParams {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  return query;
}

function httpError(status: number): HttpError {
  switch (status) {
    case 400: return { kind: "bad-request", status };
    case 403: return { kind: "access-denied", status };
    case 404: return { kind: "not-found", status };
    case 500: return { kind: "server-error", status };
    default: return { kind: "http", status };
  }
}

export class DashboardClient {
  private readonly options: ClientOptions;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly projectEndpoint: string;

  constructor(options: ClientOptions) {
    this.options = { ...options };
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.projectEndpoint = `/api/v1/projects/${requireId(options.projectId, "projectId")}`;
  }

  listProjects(options: PageOptions = {}) {
    const { projectId } = this.options;
    return this.get(
      { endpoint: "/api/v1/projects", projectId },
      (dto) => mapProjectList(dto, projectId),
      pageQuery(options),
      (data) => data.items.length === 0,
    );
  }

  getProject() {
    const { projectId } = this.options;
    return this.get({ endpoint: this.projectEndpoint, projectId }, (dto) => mapProjectDetail(dto, projectId));
  }

  getBudgetSnapshot() {
    const { projectId } = this.options;
    const endpoint = `${this.projectEndpoint}/budget-snapshot`;
    return this.get({ endpoint, projectId }, (dto) => mapBudgetSnapshot(dto, projectId));
  }

  async listSessionTasks(sessionId: string, options: TaskPageOptions = {}): Promise<DashboardResult<ReturnType<typeof mapSessionTasks>>> {
    const { projectId } = this.options;
    const endpoint = `${this.projectEndpoint}/sessions/${encodeURIComponent(sessionId)}/tasks`;
    const source = { endpoint, projectId, sessionId };
    try {
      requireId(sessionId, "sessionId");
    } catch {
      return { kind: "error", source, receivedAt: null, error: { kind: "data", message: "Invalid sessionId" } };
    }
    const query = pageQuery(options);
    for (const status of options.sourceStatuses ?? []) query.append("status", status);
    return this.get(
      source,
      (dto) => mapSessionTasks(dto, projectId, sessionId),
      query,
      (data) => data.items.length === 0,
    );
  }

  async listSessions(projectId: string, options: PageOptions = {}): Promise<DashboardResult<ReturnType<typeof mapSessions>>> {
    let id: string;
    try {
      id = requireId(projectId, "projectId");
    } catch {
      return {
        kind: "error", source: { endpoint: "/api/v1/projects/:projectId/sessions", projectId },
        receivedAt: null, error: { kind: "data", message: "Invalid projectId" },
      };
    }
    return this.get(
      { endpoint: `/api/v1/projects/${encodeURIComponent(id)}/sessions`, projectId },
      (dto) => mapSessions(dto, projectId),
      pageQuery(options),
      (data) => data.items.length === 0,
    );
  }

  listAgentProfiles(options: { role?: AgentProfileRole; activeOnly?: boolean } = {}) {
    const query = new URLSearchParams();
    if (options.role !== undefined) query.set("role", options.role);
    if (options.activeOnly !== undefined) query.set("active_only", String(options.activeOnly));
    const { projectId } = this.options;
    return this.get(
      { endpoint: `${this.projectEndpoint}/agent-profiles`, projectId },
      (dto) => mapAgentProfiles(dto, projectId),
      query,
      (data) => data.profiles.length === 0,
    );
  }

  getTaskAssignment(taskId: string) {
    const { projectId } = this.options;
    const endpoint = `${this.projectEndpoint}/tasks/${encodeURIComponent(requireId(taskId, "taskId"))}/execution-target`;
    return this.get({ endpoint, projectId }, (dto) => mapTaskAssignment(dto, projectId, taskId));
  }

  listTaskDispatches(taskId: string) {
    const { projectId } = this.options;
    const endpoint = `${this.projectEndpoint}/tasks/${encodeURIComponent(requireId(taskId, "taskId"))}/target-dispatches`;
    return this.get({ endpoint, projectId }, (dto) => mapTaskDispatches(dto, projectId, taskId),
      undefined, (data) => data.dispatches.length === 0);
  }

  private async get<T>(
    source: Source,
    map: (value: unknown) => T,
    query?: URLSearchParams,
    isEmpty?: (data: T) => boolean,
  ): Promise<DashboardResult<T>> {
    const url = new URL(source.endpoint, this.options.baseUrl);
    if (query) url.search = query.toString();
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    let receivedAt: string | null = null;
    try {
      const response = await this.fetch(url, {
        method: "GET",
        redirect: "error",
        headers: { "x-sf-auth-token": this.options.authToken },
        signal,
      });
      receivedAt = this.now().toISOString();
      if (!response.ok) {
        return { kind: "error", source, receivedAt, error: httpError(response.status) };
      }
      const body = await response.text();
      const data = map(JSON.parse(body) as unknown);
      return { kind: isEmpty?.(data) ? "empty" : "ok", source, receivedAt, data };
    } catch (error) {
      if (error instanceof DashboardDataError || error instanceof SyntaxError) {
        const message = error instanceof DashboardDataError ? error.message : "Invalid dashboard response JSON";
        return { kind: "error", source, receivedAt, error: { kind: "data", message } };
      }
      return { kind: "error", source, receivedAt, error: { kind: signal.aborted ? "timeout" : "network" } };
    }
  }
}
