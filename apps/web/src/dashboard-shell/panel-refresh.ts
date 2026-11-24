// The fragment endpoint is same-origin and owns auth and resource lookup.
// Keep the control and focus in place while replacing only this panel's body.
export const panelRefreshScript = `
document.addEventListener("click", async (event) => {
  const button = event.target?.closest?.("[data-panel-refresh]");
  if (!button || button.disabled) return;
  const panel = button.closest("[data-panel-url]");
  const body = panel.querySelector("[data-panel-body]");
  const endpoint = panel.dataset.panelUrl;
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
    if (panel.isConnected && panel.dataset.panelUrl === endpoint) body.innerHTML = html;
  } catch {
    if (panel.isConnected && panel.dataset.panelUrl === endpoint) {
      body.innerHTML = '<p data-state="error">Không tải được dữ liệu.</p>';
    }
  } finally {
    if (panel.isConnected) {
      body.setAttribute("aria-busy", "false");
      button.disabled = false;
    }
  }
});
`;

export function refreshablePanel(id: string, heading: string, endpoint: string, body: string): string {
  return `<section id="${id}" data-panel-url="${endpoint}" aria-labelledby="${id}-heading">
<div class="panel-heading"><h2 id="${id}-heading">${heading}</h2><button type="button" data-panel-refresh>Làm mới</button></div>
<div data-panel-body role="status">${body}</div>
</section>`;
}
