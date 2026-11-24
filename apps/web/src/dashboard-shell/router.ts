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
  @media (max-width: 38rem) {
    body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    header { padding: 1rem 1.25rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    header p { margin: 0; }
  }
`;

function page(status: DashboardPage["status"], heading: string, message = "", isProjectList = false): DashboardPage {
  return {
    status,
    body: `<!DOCTYPE html>
<html lang="en">
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
    ${message ? `<p>${message}</p>` : ""}
  </main>
</body>
</html>`,
  };
}

export function withDashboardRouteBoundary(render: () => DashboardPage): DashboardPage {
  try {
    return render();
  } catch (error) {
    if (error instanceof URIError) return page(400, "Invalid project address", "Open Projects to return to the dashboard.");
    return page(500, "Unable to open this page", "Open Projects to return to the dashboard.");
  }
}

export function dashboardRoute(pathname: string): DashboardPage | undefined {
  if (pathname === "/projects" || pathname === "/projects/") {
    return withDashboardRouteBoundary(() => page(200, "Projects", "Project listings are unavailable here for now.", true));
  }

  const project = /^\/projects\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (project !== undefined) {
    return withDashboardRouteBoundary(() => {
      const projectId = decodeURIComponent(project);
      if (/[\/\\\u0000-\u001f\u007f]/.test(projectId)) throw new URIError("Invalid project segment");
      return page(200, "Project");
    });
  }
  return undefined;
}

export function dashboardNotFound(): DashboardPage {
  return withDashboardRouteBoundary(() => page(404, "Page not found", "Open Projects to return to the dashboard."));
}
