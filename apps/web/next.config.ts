import type { NextConfig } from "next";
import pkg from "./package.json" with { type: "json" };

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },
  // Браузер ходит в API через тот же домен: см. src/app/v1/[...path]/route.ts.
};

export default nextConfig;
