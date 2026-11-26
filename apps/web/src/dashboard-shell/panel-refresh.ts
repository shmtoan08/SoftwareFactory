// The fragment endpoint is same-origin and owns auth and resource lookup.
// Keep the control and focus in place while replacing only this panel's body.
export const panelRefreshScript = `
document.addEventListener("click", async (event) => {
  const button = event.target?.closest?.("[data-panel-refresh], [data-panel-request], [data-panel-filter]");
  if (!button || button.disabled) return;
  const panel = button.closest("[data-panel-url]");
  if (panel.dataset.panelBusy) return;
  const body = panel.querySelector("[data-panel-body]");
  if (button.dataset?.panelFilter !== undefined) {
    const query = new URLSearchParams();
    for (const field of panel.querySelectorAll("[data-panel-filter-field]")) {
      if (field.value) query.set(field.name, field.value);
    }
    const path = panel.dataset.panelUrl.split("?")[0];
    panel.dataset.panelUrl = query.size ? path + "?" + query.toString() : path;
  }
  const currentResource = panel.dataset.panelUrl;
  const endpoint = button.dataset?.panelRequest ?? currentResource;
  panel.dataset.panelBusy = "true";
  button.disabled = true;
  body.setAttribute("aria-busy", "true");
  body.innerHTML = '<p data-state="loading">Đang tải…</p>';
  try {
    const response = await fetch(endpoint, {
      method: "GET", mode: "same-origin", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || response.headers.get("X-Dashboard-Panel") !== "1") {
      throw new Error("Panel response unavailable");
    }
    const html = await response.text();
    if (panel.isConnected && panel.dataset.panelUrl === currentResource) body.innerHTML = html;
  } catch {
    if (panel.isConnected && panel.dataset.panelUrl === currentResource) {
      body.innerHTML = '<p data-state="error">Không tải được dữ liệu.</p>';
    }
  } finally {
    delete panel.dataset.panelBusy;
    if (panel.isConnected) {
      body.setAttribute("aria-busy", "false");
      button.disabled = false;
    }
  }
});
`;

export function refreshablePanel(id: string, heading: string, endpoint: string, body: string, controls = "", refreshLabel = "Làm mới"): string {
  return `<section id="${id}" data-panel-url="${endpoint}" aria-labelledby="${id}-heading">
<div class="panel-heading"><h2 id="${id}-heading">${heading}</h2><button type="button" data-panel-refresh>${refreshLabel}</button></div>
${controls}<div data-panel-body role="status">${body}</div>
</section>`;
}
