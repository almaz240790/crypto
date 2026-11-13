import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MultiChartUpsell } from "./MultiChartUpsell";

/**
 * Экран вместо сетки мультичарта без права (план, раздел 4: Premium; ADR-0009, дополнение 2026-11-13): что это,
 * «Доступно с подпиской Premium», подписка (гость — /pricing и вход, вошедший — /billing) и «Открыть терминал».
 */
const hrefs = (html: string) => [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[2], m[1]]);

describe("MultiChartUpsell", () => {
  it("гость: что такое мультичарт, Premium, подписка → /pricing, вход с возвратом, терминал", () => {
    const html = renderToStaticMarkup(<MultiChartUpsell guest />);
    expect(html).toContain("Доступно с подпиской Premium");
    expect(html).toContain("2 или 4 графика на одном экране");
    expect(hrefs(html)).toEqual([
      ["Подписка", "/pricing"],
      ["Войти", "/login?next=/multichart"],
      ["Открыть терминал", "/chart/BTCUSDT/4h"],
    ]);
  });

  it("вошедший без Premium: подписка → /billing, без «Войти»", () => {
    const html = renderToStaticMarkup(<MultiChartUpsell guest={false} />);
    expect(html).toContain("Доступно с подпиской Premium");
    expect(hrefs(html)).toEqual([
      ["Подписка", "/billing"],
      ["Открыть терминал", "/chart/BTCUSDT/4h"],
    ]);
  });

  it("у каждой строки есть английский перевод", () => {
    const en = JSON.parse(readFileSync(new URL("../../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
    const src = readFileSync(new URL("./MultiChartUpsell.tsx", import.meta.url), "utf8");
    const keys = [...src.matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.filter((k) => !en[k])).toEqual([]);
  });
});
