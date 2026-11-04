import { describe, expect, it } from "vitest";
import en from "../../../i18n/en.json";
import { DRAW_HINTS, drawHint } from "./drawHint";

describe("подсказка шага в чипе режима рисования", () => {
  it("двухточечные: первая, вторая точка; канал — и третья", () => {
    expect(drawHint("fib", 0)).toBe("Нажмите первую точку");
    expect(drawHint("fib", 1)).toBe("Нажмите вторую точку");
    expect(drawHint("channel", 2)).toBe("Нажмите третью точку");
  });

  it("одноточечные — «Нажмите на график»; позиции — вход, стоп, цель", () => {
    expect(drawHint("hline", 0)).toBe("Нажмите на график");
    expect(drawHint("note", 0)).toBe("Нажмите на график");
    expect([0, 1, 2].map((k) => drawHint("position-long", k))).toEqual(["Нажмите цену входа", "Нажмите стоп", "Нажмите цель"]);
    // за пределами шагов — последняя подсказка, а не undefined
    expect(drawHint("trend", 5)).toBe("Нажмите третью точку");
    expect(drawHint("trend", -1)).toBe("Нажмите первую точку");
  });

  it("все подсказки и тексты чипа переведены", () => {
    const dict = en as Record<string, string>;
    const keys = [...DRAW_HINTS, "режим рисования", "Отменить", "Отменить рисунок", "Готово — закончить рисование", "рисовать серию", "инструмент не снимается после рисунка"];
    expect(keys.filter((k) => !dict[k])).toEqual([]);
  });
});
