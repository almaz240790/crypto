import path from "node:path";
import type { NextConfig } from "next";
import pkg from "./package.json" with { type: "json" };

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },
  transpilePackages: ["@platform/charts"],
  // Монорепозиторий: пакет графика лежит в ../../packages/charts — корень сборки на два уровня выше.
  turbopack: { root: path.join(__dirname, "../..") },
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Браузер ходит в API через тот же домен: см. src/app/v1/[...path]/route.ts.
};

export default nextConfig;
