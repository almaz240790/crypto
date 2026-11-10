"use client";

import Link from "next/link";
import { useT } from "@/i18n/client";
import { Footer } from "./Footer";
import { Header } from "./Header";

/**
 * «Страница не найдена» — одна и та же для настоящего 404 (app/not-found.tsx) и для разделов, которые
 * посетителю не видны (сигналы, пока они закрыты, ADR-0013): по странице нельзя понять, что раздел есть.
 */
export function NotFound() {
  const t = useT();
  return (
    <>
      <Header />
      <main className="container" style={{ paddingBlock: 48, display: "grid", gap: 12, maxWidth: 640 }} data-testid="not-found">
        <h1>{t("Страница не найдена")}</h1>
        <p className="text-2">{t("Такой страницы нет. Проверьте адрес или начните с графика.")}</p>
        <p>
          <Link href="/chart">{t("Открыть график")}</Link>
        </p>
      </main>
      <Footer />
    </>
  );
}
