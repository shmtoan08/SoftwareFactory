interface DashboardPage {
  status: 200 | 400 | 404 | 500;
  body: string;
}

const styles = `
  :root { color-scheme: light; font-family: system-ui, sans-serif; color: #1a2435; background: #f6f8fc; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; grid-template-columns: 16rem minmax(0, 1fr); }
  header { padding: 2rem 1.25rem; background: #142238; color: #fff; }
  header p { margin: 0 0 2rem .75rem; font-size: 1.125rem; font-weight: 650; }
  nav a { display: block; padding: .75rem; border-radius: .5rem; color: inherit; text-decoration: none; }
  nav a:hover, nav a[aria-current="page"] { background: #283b56; }
  a:focus-visible { outline: 2px solid #4279de; outline-offset: 3px; }
  main { padding: clamp(1.5rem, 6vw, 5rem); }
  h1 { margin: 0 0 1rem; font-size: clamp(1.75rem, 4vw, 2.5rem); letter-spacing: -.035em; }
  main p { color: #48566b; max-width: 44ch; line-height: 1.6; }
  .project-panels { display: flex; flex-direction: column; gap: 1rem; max-width: 50rem; }
  .project-panels section { padding: 1.25rem; border: 1px solid #d8e0ee; border-radius: .75rem; background: #fff; }
  .project-panels h2 { margin: 0 0 .75rem; font-size: 1.125rem; }
  .project-panels p { margin: .75rem 0 0; max-width: none; }
  .project-panels dl { margin: 0; display: grid; grid-template-columns: fit-content(12rem) minmax(0, 1fr); gap: .5rem 1rem; }
  .project-panels dd { margin: 0; overflow-wrap: anywhere; }
  .project-panels form { margin-top: .75rem; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .project-panels select { min-width: 0; max-width: 100%; }
  .project-panels button, .project-panels select { font: inherit; padding: .4rem; }
  .project-panels :is(#project-loading, #project-result) { order: 1; }
  .project-panels :is(#sessions-loading, #sessions-result) { order: 2; }
  .project-panels #pipeline-progress { order: 3; }
  .project-panels :is(#budget-loading, #budget-panel) { order: 4; }
  .project-panels :is(#tasks-loading, #tasks-empty, #tasks-panel) { order: 5; }
  .project-panels:has(#tasks-empty, #tasks-panel) #tasks-loading,
  .project-panels[data-session-changing] :is(#tasks-empty, #tasks-panel, #work-items-empty, #work-items-panel),
  .project-panels:has(#work-items-empty, #work-items-panel) #work-items-loading { display: none; }
  .project-panels :is(#work-items-loading, #work-items-empty, #work-items-panel) { order: 6; }
  .work-items-filter { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: .75rem 0; }
  .work-items-scroll { overflow-x: auto; margin-top: 1rem; }
  .work-items-scroll table { border-collapse: collapse; width: 100%; text-align: left; }
  .work-items-scroll caption { text-align: left; padding-bottom: .5rem; }
  .work-items-scroll :is(th, td) { padding: .6rem; border-bottom: 1px solid #d8e0ee; vertical-align: top; }
  .work-item-status { white-space: pre-wrap; overflow-wrap: anywhere; }
  .dashboard-task-list { display: grid; gap: 1rem; padding-left: 1.25rem; }
  .dashboard-task-list h3 { margin: 0 0 .5rem; overflow-wrap: anywhere; }
  .project-panels :is(#agent-profiles-loading, #agent-profiles-panel) { order: 7; }
  .project-panels:has(#agent-profiles-panel) #agent-profiles-loading { display: none; }
  .project-panels :is(#cost-session-loading, #cost-session-result) { order: 8; }
  .project-panels:has(#cost-session-result) #cost-session-loading,
  .project-panels[data-session-changing] #cost-session-result { display: none; }
  .profile-filters { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: .75rem 0; }
  .profile-table { max-height: 24rem; overflow: auto; margin-top: 1rem; }
  .profile-table table { border-collapse: collapse; width: 100%; text-align: left; }
  .profile-table caption { text-align: left; padding-bottom: .5rem; }
  .profile-table :is(th, td) { padding: .6rem; border-bottom: 1px solid #d8e0ee; vertical-align: top; }
  .project-panels :is(#approval-decisions-loading, #approval-decisions-result) { order: 9; }
  .project-panels :is(#change-requests-loading, #change-requests-result) { order: 10; }
  .project-panels :is(#evidence-loading, #evidence-result) { order: 11; }
  .project-panels :is(#timeline-loading, #timeline-result) { order: 12; }
  .project-panels:has(#timeline-result) #timeline-loading,
  .project-panels:has(#evidence-result) #evidence-loading,
  .project-panels:has(#approval-decisions-result) #approval-decisions-loading,
  .project-panels:has(#change-requests-result) #change-requests-loading,
  .project-panels[data-session-changing] :is(#approval-decisions-result, #change-requests-result, #evidence-result, #timeline-result) { display: none; }
  .evidence-preview { max-height: 16rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .approval-records { display: grid; gap: 1rem; padding-left: 1.25rem; }
  .approval-records h3 { margin: 0 0 .5rem; font-size: 1rem; overflow-wrap: anywhere; }
  .panel-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  .budget-dimensions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: 1rem; margin: 1rem 0; }
  .budget-dimensions h3 { margin: 0 0 .5rem; font-size: 1rem; }
  .project-panels:has(#project-result) #project-loading,
  .project-panels:has(#sessions-result) #sessions-loading,
  .project-panels:has(#budget-panel) #budget-loading { display: none; }
  @media (max-width: 38rem) {
    body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    header { padding: 1rem 1.25rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    header p { margin: 0; }
  }
`;

function page(status: DashboardPage["status"], heading: string, message = "", isProjectList = false): DashboardPage {
  return { status, body: documentStart(heading, isProjectList) + (message ? `<p>${message}</p>` : "") + documentEnd };
}

export function documentStart(heading: string, isProjectList = false, language: "en" | "vi" = "en"): string {
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${heading} · Dashboard</title>
  <style>${styles}</style>
</head>
<body>
  <header>
    <p>Dashboard</p>
    <nav aria-label="Dashboard">
      <a href="/projects"${isProjectList ? ' aria-current="page"' : ""}>Projects</a>
    </nav>
  </header>
  <main>
    <h1>${heading}</h1>
`;
}

export const documentEnd = "</main>\n</body>\n</html>";

export function withDashboardRouteBoundary<T>(render: () => T): T | DashboardPage {
  try {
    return render();
  } catch (error) {
    if (error instanceof URIError) return page(400, "Invalid project address", "Open Projects to return to the dashboard.");
    return page(500, "Unable to open this page", "Open Projects to return to the dashboard.");
  }
}

export function dashboardRoute(pathname: string): DashboardPage | { projectId: string } | undefined {
  if (pathname === "/projects" || pathname === "/projects/") {
    return withDashboardRouteBoundary(() => page(200, "Projects", "Project listings are unavailable here for now.", true));
  }

  const project = /^\/projects\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (project !== undefined) {
    return withDashboardRouteBoundary(() => {
      const projectId = decodeURIComponent(project);
      if (/[\/\\\u0000-\u001f\u007f]/.test(projectId)) throw new URIError("Invalid project segment");
      return { projectId };
    });
  }
  return undefined;
}

export function dashboardNotFound(): DashboardPage {
  return withDashboardRouteBoundary(() => page(404, "Page not found", "Open Projects to return to the dashboard."));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function facts(entries: [string, string][]): string {
  return `<dl>${entries.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}
