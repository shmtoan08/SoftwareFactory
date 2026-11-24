import { DashboardClient } from "../dashboard-data/client.ts";
import { agentProfileRoles } from "../dashboard-data/mapping.ts";
import { refreshablePanel } from "./panel-refresh.ts";
import { escapeHtml, facts } from "./router.ts";

const renderLimit = 100;

function state(kind: "loading" | "error" | "access-denied", message: string): string {
  return `<p data-state="${kind}">${message}</p>`;
}

export function agentProfilesLoading(): string {
  return `<section id="agent-profiles-loading" aria-labelledby="agent-profiles-loading-heading">
<h2 id="agent-profiles-loading-heading">Cấu hình profile</h2>
<div role="status">${state("loading", "Đang tải…")}</div></section>`;
}

export function agentProfilesPanel(projectId: string, body: string): string {
  const endpoint = `/projects/${encodeURIComponent(projectId)}/dashboard-agent-profiles`;
  const controls = `<div class="profile-filters">
<label for="profile-role">Vai trò</label>
<select id="profile-role" name="role" data-panel-filter-field><option value="">Tất cả</option>
${agentProfileRoles.map((role) => `<option value="${role}">${role}</option>`).join("")}</select>
<label for="profile-enabled">Cấu hình</label>
<select id="profile-enabled" name="active_only" data-panel-filter-field>
<option value="">Bật và tắt</option><option value="true">Chỉ cấu hình bật</option></select>
<button type="button" data-panel-filter>Áp dụng</button></div>`;
  return refreshablePanel("agent-profiles-panel", "Cấu hình profile", endpoint, body, controls);
}

export async function loadAgentProfilesBody(
  projectId: string, authToken: string | undefined, baseUrl: string | undefined, query = new URLSearchParams(),
): Promise<string> {
  if (!authToken) return state("access-denied", "Bạn không có quyền truy cập dữ liệu này.");
  if (!baseUrl) return state("error", "Không tải được dữ liệu.");
  const rawRole = query.get("role");
  const active = query.get("active_only");
  const role = agentProfileRoles.find((candidate) => candidate === rawRole);
  if ([...query.keys()].some((key) => (key !== "role" && key !== "active_only") || query.getAll(key).length > 1)
    || (rawRole !== null && !role) || (active !== null && active !== "true" && active !== "false")) {
    return state("error", "Bộ lọc cấu hình profile không hợp lệ.");
  }

  try {
    const client = new DashboardClient({ baseUrl, projectId, authToken, timeoutMs: 7000 });
    const result = await client.listAgentProfiles({ role, activeOnly: active === null ? undefined : active === "true" });
    if (result.kind === "error") {
      if (result.error.kind === "access-denied" || ("status" in result.error && result.error.status === 401)) {
        return state("access-denied", "Bạn không có quyền truy cập dữ liệu này.");
      }
      return state("error", "Không tải được dữ liệu.");
    }
    const times = facts([["Tải lúc (receivedAt)", result.receivedAt], ["fetchedAt", "API không cung cấp"]]);
    if (result.kind === "empty") return `<div data-state="empty">${times}<p>Không có cấu hình profile.</p></div>`;

    const { profiles } = result.data;
    const rows = profiles.slice(0, renderLimit).map((profile) =>
      `<tr><th scope="row">${escapeHtml(profile.principal)}</th><td>${escapeHtml(profile.provider)}</td><td>${escapeHtml(profile.model)}</td><td>${profile.role}</td><td>${profile.is_active ? "Bật" : "Tắt"}</td></tr>`,
    ).join("");
    const note = profiles.length > renderLimit ? `<p>Chỉ hiển thị ${renderLimit} cấu hình đầu. Dùng bộ lọc để thu hẹp danh sách.</p>` : "";
    return `<div data-state="ready">${times}${note}
<div class="profile-table" tabindex="0"><table><caption>Cấu hình profile của project</caption>
<thead><tr><th scope="col">Principal</th><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Vai trò</th><th scope="col">Cấu hình bật/tắt</th></tr></thead>
<tbody>${rows}</tbody></table></div></div>`;
  } catch {
    return state("error", "Không tải được dữ liệu.");
  }
}
