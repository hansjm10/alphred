import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { DASHBOARD_NOT_FOUND_CONTENT } from './app/not-found-content';

const buildHasTestRoutes = process.env.ALPHRED_DASHBOARD_TEST_ROUTES_BUILD === '1';

function canServeTestRoutes(): boolean {
  return buildHasTestRoutes && process.env.ALPHRED_DASHBOARD_TEST_ROUTES === '1';
}

function renderHardNotFoundHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${DASHBOARD_NOT_FOUND_CONTENT.title}</title>
  </head>
  <body>
    <div class="app">
      <main>
        <section class="status-panel">
          <h2>${DASHBOARD_NOT_FOUND_CONTENT.title}</h2>
          <p>${DASHBOARD_NOT_FOUND_CONTENT.message}</p>
          <a class="state-link" href="/">${DASHBOARD_NOT_FOUND_CONTENT.homeLabel}</a>
        </section>
      </main>
    </div>
  </body>
</html>`;
}

export function proxy(_request: NextRequest) {
  if (!canServeTestRoutes()) {
    return new NextResponse(renderHardNotFoundHtml(), {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-robots-tag': 'noindex',
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/test', '/test/:path*'],
};
