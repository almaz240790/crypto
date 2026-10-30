import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { LocaleProvider } from "@/i18n/client";
import { getLocale } from "@/i18n/server";
import { RegisterSW } from "@/components/pwa/Register";
import "./globals.css";

const sans = Inter({
  variable: "--font-sans",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "PlatformSol", template: "%s — PlatformSol" },
  description: "Крипто-график с уровнями, зонами и картой ликвидаций; сигналы на H4 по правилам с открытой статистикой.",
  applicationName: "PlatformSol",
  metadataBase: new URL("https://platformsol.com"),
  appleWebApp: { capable: true, title: "PlatformSol", statusBarStyle: "black-translucent" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0b0f14" }, // color-ok: токен --bg тёмной темы (она по умолчанию)
    { media: "(prefers-color-scheme: dark)", color: "#0b0f14" }, // color-ok: токен --bg
  ],
};

// Тема выставляется до первой отрисовки, чтобы не мигала. По умолчанию тёмная; светлая — если выбрана.
const themeScript = `(function(){var t="dark";try{if(localStorage.getItem("theme")==="light"){t="light"}}catch(e){}document.documentElement.dataset.theme=t})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AuthProvider>
          <LocaleProvider initial={locale}>{children}</LocaleProvider>
        </AuthProvider>
        <RegisterSW />
      </body>
    </html>
  );
}
