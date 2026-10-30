import type { MetadataRoute } from "next";

/** PWA-манифест (план 2.15). Цвета — из токенов раздела 5.3. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PlatformSol — график и сигналы",
    short_name: "PlatformSol",
    description: "Торговые сигналы на 4-часовом таймфрейме с публичной статистикой каждой сделки.",
    start_url: "/signals",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0f14", // color-ok: токен --bg тёмной темы
    theme_color: "#0b0f14", // color-ok: токен --bg тёмной темы
    lang: "ru",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Сигналы", url: "/signals" },
      { name: "Скринер", url: "/screener" },
      { name: "Калькулятор", url: "/calculator" },
    ],
  };
}
