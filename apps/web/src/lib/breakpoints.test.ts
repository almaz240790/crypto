import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BP, CSS_MEDIA_LANDSCAPE, CSS_MEDIA_WIDTHS, MQ, layoutFor } from "./breakpoints";

/** Единый источник брейкпоинтов (план 2B.9): стили терминала, AppShell и ui — только разрешённые запросы. */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const SCOPE = ["components/terminal", "components/app/AppShell.module.css", "components/ui"];
/**
 * Прежние пороги вне терминала, которые C1 (десктоп) не трогает: ui/Table складывает строки по две на ≤ 720 px
 * на сигналах, статистике и инструментах (план 5.5). Перевод на BP — вместе с раскладкой телефона (C2).
 */
const LEGACY: Readonly<Record<string, readonly string[]>> = { "components/ui/Table.module.css": ["(max-width: 720px)"] };

function files(path: string, ext: RegExp, out: string[] = []): string[] {
  const p = join(SRC, path);
  if (statSync(p).isFile()) {
    if (ext.test(p)) out.push(p);
    return out;
  }
  for (const name of readdirSync(p)) files(join(path, name), ext, out);
  return out;
}

/** Все условия @media файла: строка между «@media» и «{». */
function mediaQueries(css: string): string[] {
  return [...css.matchAll(/@media\s+([^{]+)\{/g)].map((m) => m[1]!.trim().replace(/\s+/g, " "));
}

const norm = (q: string) => q.replace(/\s+/g, " ").replace(/\(\s*/g, "(").replace(/\s*\)/g, ")").replace(/\s*:\s*/g, ": ");

describe("breakpoints", () => {
  it("MQ согласован с BP: телефон < 900 ≤ десктоп, без пересечения на 900 px", () => {
    expect(MQ.desktop).toBe(`(min-width: ${BP.desktop}px)`);
    expect(MQ.mobile).toBe(`(max-width: ${BP.desktop - 0.02}px)`);
    expect(MQ.wide).toBe(`(min-width: ${BP.wide}px)`);
    for (const q of CSS_MEDIA_WIDTHS) {
      const m = /\((min|max)-width: ([\d.]+)px\)/.exec(q)!;
      const px = Number(m[2]);
      // min — ровно брейкпоинт, max — на 0.02 меньше брейкпоинта (ширина окна бывает дробной при масштабе)
      expect(Object.values(BP)).toContain(m[1] === "min" ? px : Math.round((px + 0.02) * 100) / 100);
    }
  });

  it("класс раскладки: ландшафт телефона важнее ширины, иначе ≥ 900 — десктоп", () => {
    expect(layoutFor({ desktop: true, landscape: false })).toBe("desktop");
    expect(layoutFor({ desktop: false, landscape: false })).toBe("phone");
    expect(layoutFor({ desktop: true, landscape: true })).toBe("landscape");
    expect(layoutFor({ desktop: false, landscape: true })).toBe("landscape");
  });

  it("в CSS терминала, AppShell и ui — только разрешённые медиа-запросы", () => {
    const bad: string[] = [];
    const css = SCOPE.flatMap((p) => files(p, /\.css$/));
    expect(css.length).toBeGreaterThan(5);
    for (const f of css) {
      for (const q of mediaQueries(readFileSync(f, "utf8"))) {
        const n = norm(q);
        if (/prefers-color-scheme|prefers-reduced-motion/.test(n)) continue;
        if (CSS_MEDIA_LANDSCAPE.map(norm).includes(n)) continue;
        if (LEGACY[relative(SRC, f)]?.includes(n)) continue;
        // остальное — по отдельным условиям: ширины только из списка, высоты нет, pointer: coarse можно
        const parts = n.split(/\s+and\s+/);
        for (const part of parts) {
          if (part === MQ.coarse) continue;
          if (CSS_MEDIA_WIDTHS.includes(part)) continue;
          bad.push(`${relative(SRC, f)}: @media ${q}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("высота страницы — заливкой flex, а не calc от высоты шапки (в src из calc(100dvh - …) — только окно без --safe-top)", () => {
    // вычитать можно только отступ под статус-бар iPhone (окно каркаса), но не высоту шапки или нижней строки
    const bad = files(".", /\.(css|tsx?)$/)
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => [...readFileSync(f, "utf8").matchAll(/calc\(\s*100dvh\s*-([^;]*)/g)].some((m) => m[1]!.trim() !== "var(--safe-top))"))
      .map((f) => relative(SRC, f));
    expect(bad).toEqual([]);
  });

  it("в коде терминала, AppShell и ui — медиа-запросы только из MQ (без литералов ширины)", () => {
    const bad: string[] = [];
    for (const f of SCOPE.flatMap((p) => files(p, /\.tsx?$/))) {
      if (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/\((?:min|max)-(?:width|height):\s*\d/.test(line) || /matchMedia\(\s*["'`]/.test(line)) bad.push(`${relative(SRC, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
