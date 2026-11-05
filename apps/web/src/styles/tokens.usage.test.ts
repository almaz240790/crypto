import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Каждый var(--x) в стилях определён (план 2B.9, M22): в tokens.css или как переменная раскладки из allowlist.
 * Неопределённый токен даёт прозрачный фон без ошибки (так было с --bg-2: тулбар, панель и ТФ без заливки).
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
/**
 * Переменные раскладки (задаются в style из TSX), отступ под статус-бар iPhone (--safe-top, globals.css) и шрифты
 * next/font (класс на <html>).
 */
const ALLOW = new Set(["--objects-w", "--panel-col", "--price-axis-w", "--time-scale-h", "--dialog-room", "--safe-top", "--font-sans", "--font-mono", "--font-serif"]);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith(".css")) out.push(p);
  }
  return out;
}

const defined = (css: string) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]!));

describe("токены дизайн-системы", () => {
  const tokens = defined(readFileSync(join(SRC, "styles/tokens.css"), "utf8"));

  it("каждый var(--x) в CSS определён в tokens.css или разрешён", () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const css = readFileSync(f, "utf8");
      const local = defined(css);
      for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        const v = m[1]!;
        if (!tokens.has(v) && !local.has(v) && !ALLOW.has(v)) bad.push(`${relative(SRC, f)}: ${v}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("нет --bg-2 (его нет в токенах; поверхности — --surface, выбор — --row-hover)", () => {
    const hits = files(SRC).filter((f) => readFileSync(f, "utf8").includes("--bg-2"));
    expect(hits.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("слои интерфейса терминала и подложки — токены, а не числа в модулях", () => {
    for (const z of ["--z-chart-ui", "--z-sheet", "--z-drawer", "--z-popover", "--z-nav", "--z-toast", "--scrim", "--legend-bg", "--touch-min"]) expect(tokens.has(z), z).toBe(true);
  });
});
