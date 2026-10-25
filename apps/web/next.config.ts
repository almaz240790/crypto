import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // Браузер ходит в API через тот же домен: refresh-cookie (path=/v1/auth) остаётся
  // first-party, CORS не нужен. Серверные вызовы идут напрямую по API_URL (см. lib/api.ts).
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${API_URL}/v1/:path*` }];
  },
};

export default nextConfig;
