import { FIB_LEVELS, FIB_PRESET_LEVELS } from "@platform/charts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FibLevels } from "./SelectedDrawingCard";

/**
 * Уровни Фибоначчи в карточке рисунка (ADR-0009, «Рисование», дополнение 2026-11-11): разметка и состояние
 * переключателей; нажатия, отмена и телефон — в e2e/chart.fib.spec.ts.
 */
type Chip = { text: string; pressed: boolean; disabled: boolean };
/** Группы панели по порядку: подпись и её переключатели. */
function groups(html: string): { label: string; chips: Chip[] }[] {
  const out: { label: string; chips: Chip[] }[] = [];
  // первая группа — сама панель; дальше — три группы уровней
  for (const part of html.split('role="group"').slice(2)) {
    const label = /aria-label="([^"]+)"/.exec(part)![1]!;
    const chips = [...part.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)]
      .filter((m) => m[1]!.includes("aria-pressed"))
      .map((m) => ({ text: m[2]!, pressed: m[1]!.includes('aria-pressed="true"'), disabled: /\sdisabled(=""|\s|$)/.test(m[1]!) }));
    out.push({ label, chips });
  }
  return out;
}
const render = (levels: number[] | undefined, locked = false) => renderToStaticMarkup(<FibLevels levels={levels} locked={locked} onChange={() => undefined} />);

describe("FibLevels", () => {
  it("три группы простыми словами; переключатель на каждый уровень, нажаты — показанные (без набора — по умолчанию)", () => {
    const html = render(undefined);
    expect(html).toContain('role="group" aria-label="уровни Фибоначчи"');
    const g = groups(html);
    expect(g.map((x) => x.label)).toEqual(["цели по движению", "коррекция", "за началом"]);
    expect(g[0]!.chips.map((c) => c.text)).toEqual(["−1", "−0.618", "−0.272"]);
    expect(g[1]!.chips.map((c) => c.text)).toEqual(["0", "0.236", "0.382", "0.5", "0.618", "0.705", "0.786", "1"]);
    expect(g[2]!.chips.map((c) => c.text)).toEqual(["1.272", "1.618", "2.618"]);
    const all = g.flatMap((x) => x.chips);
    expect(all).toHaveLength(FIB_PRESET_LEVELS.length);
    expect(all.filter((c) => c.pressed).map((c) => c.text)).toEqual(FIB_LEVELS.map(String));
    expect(all.some((c) => c.disabled)).toBe(false);
    // подписи групп видны глазом и названы для чтения с экрана один раз (видимая подпись скрыта от него)
    expect(html.match(/aria-hidden="true">цели по движению</g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*>стандартные<\/button>/);
  });

  it("свой набор: нажаты только его уровни; уровень вне предложенных — в своей группе", () => {
    const g = groups(render([-0.618, 0, 0.33, 1, 3.618]));
    expect(g[0]!.chips.filter((c) => c.pressed).map((c) => c.text)).toEqual(["−0.618"]);
    expect(g[1]!.chips.map((c) => c.text)).toEqual(["0", "0.236", "0.33", "0.382", "0.5", "0.618", "0.705", "0.786", "1"]);
    expect(g[1]!.chips.filter((c) => c.pressed).map((c) => c.text)).toEqual(["0", "0.33", "1"]);
    expect(g[2]!.chips.map((c) => c.text)).toEqual(["1.272", "1.618", "2.618", "3.618"]);
    expect(g[2]!.chips.filter((c) => c.pressed).map((c) => c.text)).toEqual(["3.618"]);
  });

  it("последний включённый уровень не выключается: его переключатель недоступен, остальные — доступны", () => {
    const html = render([0.5]);
    const all = groups(html).flatMap((x) => x.chips);
    expect(all.filter((c) => c.disabled)).toEqual([{ text: "0.5", pressed: true, disabled: true }]);
    expect(html).toContain('title="последний уровень не выключается"');
  });

  it("заблокированный рисунок: переключатели и «стандартные» недоступны; пустой набор и мусор — как по умолчанию", () => {
    const html = render([-1, 0, 1], true);
    expect(groups(html).flatMap((x) => x.chips).every((c) => c.disabled)).toBe(true);
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>стандартные<\/button>/);
    const garbage = groups(render([Number.NaN] as number[])).flatMap((x) => x.chips);
    expect(garbage.filter((c) => c.pressed).map((c) => c.text)).toEqual(FIB_LEVELS.map(String));
    expect(groups(render([])).flatMap((x) => x.chips).filter((c) => c.pressed)).toHaveLength(FIB_LEVELS.length);
  });
});
