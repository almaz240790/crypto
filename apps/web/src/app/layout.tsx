import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Manrope, Source_Serif_4 } from "next/font/google";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { LocaleProvider } from "@/i18n/client";
import { getLocale, getT } from "@/i18n/server";
import { RegisterSW } from "@/components/pwa/Register";
import "./globals.css";

const sans = Manrope({
  variable: "--font-sans",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

// Заголовки маркетинговых страниц (ADR-0006); в интерфейсе графика не используется.
const serif = Source_Serif_4({
  variable: "--font-serif",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: { default: "PlatformSol", template: "%s — PlatformSol" },
    description: t("Крипто-график для технического анализа: индикаторы, инструменты рисования, автоматическая разметка уровней, зон и ликвидаций."),
    applicationName: "PlatformSol",
    metadataBase: new URL("https://platformsol.com"),
    appleWebApp: { capable: true, title: "PlatformSol", statusBarStyle: "black-translucent" },
    icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#050607" }, // color-ok: токен --bg тёмной темы (она по умолчанию)
    { media: "(prefers-color-scheme: dark)", color: "#050607" }, // color-ok: токен --bg
  ],
};

// Тема выставляется до первой отрисовки, чтобы не мигала. По умолчанию тёмная; светлая — если выбрана.
const themeScript = `(function(){var t="dark";try{if(localStorage.getItem("theme")==="light"){t="light"}}catch(e){}document.documentElement.dataset.theme=t})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${sans.variable} ${serif.variable} ${mono.variable}`} suppressHydrationWarning>
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
