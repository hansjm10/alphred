import { env } from 'node:process';

const buildHasTestRoutes = process.env.ALPHRED_DASHBOARD_TEST_ROUTES_BUILD === '1';

export function canServeTestRoutes(): boolean {
  return buildHasTestRoutes && env.ALPHRED_DASHBOARD_TEST_ROUTES === '1';
}
