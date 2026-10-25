import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const sans = IBM_Plex_Sans({
  variable: "--font-sans",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Platform", template: "%s — Platform" },
  description: "Торговые сигналы на H4 по крипторынку: правила, статистика, журнал.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// Тема выставляется до первой отрисовки, чтобы не мигала (светлая по умолчанию по системе).
const themeScript = `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
