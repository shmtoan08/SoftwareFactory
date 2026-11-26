// A session selection replaces the server-rendered project panels while keeping
// the project-level Pending approvals panel and any in-flight refresh in place.
export const sessionPanelsContentType = "text/vnd.sf.session-panels+html";

export const sessionNavigationScript = `(() => {
  let request;
  const ready = document.readyState === "loading"
    ? new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }))
    : Promise.resolve();

  async function navigate(url, panels, push) {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    panels.dataset.sessionChanging = "";
    try {
      const response = await fetch(url, {
        headers: { Accept: "${sessionPanelsContentType}" },
        signal: controller.signal, redirect: "error", cache: "no-store",
      });
      if (!response.ok || !response.headers.get("Content-Type")?.startsWith("${sessionPanelsContentType};")) throw new Error();
      const html = await response.text();
      await ready;
      if (controller.signal.aborted) return;
      const next = new DOMParser().parseFromString(html, "text/html").querySelector(".project-panels");
      if (!next) throw new Error();
      const pending = panels.querySelector("#pending-approvals-panel");
      for (const child of Array.from(panels.children)) {
        if (child !== pending) child.remove();
      }
      for (const child of Array.from(next.children)) {
        if (child.tagName !== "SCRIPT") panels.append(child);
      }
      delete panels.dataset.sessionChanging;
      if (push) history.pushState(null, "", url);
    } catch {
      if (!controller.signal.aborted) location.assign(url);
    }
  }

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form.matches("[data-session-context]")) return;
    const panels = form.closest(".project-panels");
    if (!panels?.querySelector("#pending-approvals-panel, #pending-approvals-loading")) return;
    event.preventDefault();
    const url = new URL(form.action);
    url.search = new URLSearchParams(new FormData(form)).toString();
    void navigate(url, panels, true);
  });

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target?.closest?.("a[data-session-page]");
    const panels = link?.closest(".project-panels");
    if (!panels?.querySelector("#pending-approvals-panel, #pending-approvals-loading")) return;
    event.preventDefault();
    void navigate(new URL(link.href), panels, true);
  });

  window.addEventListener("popstate", () => {
    const panels = document.querySelector(".project-panels");
    if (panels) void navigate(new URL(location.href), panels, false);
  });
})();`;
