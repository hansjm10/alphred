import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@alphred/agents', '@alphred/core', '@alphred/db', '@alphred/git', '@alphred/shared'],
  serverExternalPackages: ['@openai/codex-sdk'],
  typescript: {
    tsconfigPath: 'tsconfig.next.json',
  },
  env: {
    // This value is baked into the build output and cannot be flipped at runtime by `next start`.
    ALPHRED_DASHBOARD_TEST_ROUTES_BUILD:
      process.env.ALPHRED_DASHBOARD_TEST_ROUTES_BUILD === '1' ? '1' : '0',
  },
};

export default nextConfig;
