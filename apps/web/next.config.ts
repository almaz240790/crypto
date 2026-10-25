import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // Браузер ходит в API через тот же домен: см. src/app/v1/[...path]/route.ts.
};

export default nextConfig;
