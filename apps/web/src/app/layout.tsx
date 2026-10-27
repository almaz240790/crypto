import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { LocaleProvider } from "@/i18n/client";
import { getLocale } from "@/i18n/server";
import { RegisterSW } from "@/components/pwa/Register";
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
  applicationName: "Platform",
  appleWebApp: { capable: true, title: "Platform", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f3ef" }, // color-ok: токен --bg
    { media: "(prefers-color-scheme: dark)", color: "#121417" }, // color-ok: токен --bg
  ],
};

// Тема выставляется до первой отрисовки, чтобы не мигала (светлая по умолчанию по системе).
const themeScript = `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}})();`;

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
