import type { MetadataRoute } from "next";

/** PWA-манифест (план 2.15). Цвета — из токенов раздела 5.3. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PlatformSol — график для технического анализа",
    short_name: "PlatformSol",
    description: "Крипто-график для технического анализа: индикаторы, рисование, уровни, зоны и карта ликвидаций.",
    start_url: "/chart",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#050607", // color-ok: токен --bg тёмной темы
    theme_color: "#050607", // color-ok: токен --bg тёмной темы
    lang: "ru",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "График", url: "/chart" },
      { name: "Скринер", url: "/screener" },
      { name: "Алерты", url: "/alerts" },
    ],
  };
}
