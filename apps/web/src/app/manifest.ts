import type { MetadataRoute } from "next";

/** PWA-манифест (план 2.15). Цвета — из токенов раздела 5.3. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Platform — сигналы на H4",
    short_name: "Platform",
    description: "Торговые сигналы на 4-часовом таймфрейме с публичной статистикой каждой сделки.",
    start_url: "/signals",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f4f3ef", // color-ok: токен --bg
    theme_color: "#f4f3ef", // color-ok: токен --bg
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
