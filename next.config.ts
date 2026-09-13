import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The feed is a personal reading surface behind basic auth; no image CDN, no telemetry needs.
  reactStrictMode: true,
};

export default nextConfig;
