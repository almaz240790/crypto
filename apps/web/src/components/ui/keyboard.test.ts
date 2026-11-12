import { describe, expect, it } from "vitest";
import { navKey, rovingIndex, shortcutLetter, typeaheadIndex } from "./keyboard";

describe("navKey", () => {
  it("стрелки по ориентации группы, Home/End — в обеих", () => {
    expect(navKey("ArrowRight", "horizontal")).toBe("next");
    expect(navKey("ArrowLeft", "horizontal")).toBe("prev");
    expect(navKey("ArrowDown", "horizontal")).toBeNull();
    expect(navKey("ArrowDown", "vertical")).toBe("next");
    expect(navKey("ArrowUp", "vertical")).toBe("prev");
    expect(navKey("ArrowRight", "vertical")).toBeNull();
    expect(navKey("Home", "vertical")).toBe("first");
    expect(navKey("End", "horizontal")).toBe("last");
    expect(navKey("a", "horizontal")).toBeNull();
  });
});

describe("rovingIndex", () => {
  const off = (set: number[]) => (i: number) => set.includes(i);
  it("по кругу вперёд и назад", () => {
    expect(rovingIndex(0, "next", 3)).toBe(1);
    expect(rovingIndex(2, "next", 3)).toBe(0);
    expect(rovingIndex(0, "prev", 3)).toBe(2);
  });
  it("без текущего: next — первый, prev — последний", () => {
    expect(rovingIndex(-1, "next", 4)).toBe(0);
    expect(rovingIndex(-1, "prev", 4)).toBe(3);
  });
  it("недоступные пропускаются, в том числе на краях и для Home/End", () => {
    expect(rovingIndex(0, "next", 4, off([1, 2]))).toBe(3);
    expect(rovingIndex(3, "next", 4, off([0]))).toBe(1);
    expect(rovingIndex(-1, "first", 4, off([0, 1]))).toBe(2);
    expect(rovingIndex(-1, "last", 4, off([3]))).toBe(2);
  });
  it("все недоступны или пусто — -1", () => {
    expect(rovingIndex(0, "next", 3, () => true)).toBe(-1);
    expect(rovingIndex(-1, "first", 0)).toBe(-1);
  });
  it("единственный доступный остаётся на месте", () => {
    expect(rovingIndex(1, "next", 3, off([0, 2]))).toBe(1);
  });
});

describe("typeaheadIndex", () => {
  const labels = ["Чистый", "Структура", "Уровни и зоны", "Карта ликвидаций", "Подробный", "", "Свой"];
  it("следующий пункт с этой буквы после текущего, по кругу, без учёта регистра", () => {
    expect(typeaheadIndex(labels, "с", 0)).toBe(1);
    expect(typeaheadIndex(labels, "С", 1)).toBe(6);
    expect(typeaheadIndex(labels, "с", 6)).toBe(1);
  });
  it("несколько букв, недоступные пропускаются, нет совпадения — -1", () => {
    expect(typeaheadIndex(labels, "св", -1)).toBe(6);
    expect(typeaheadIndex(labels, "с", 0, (i) => i === 1)).toBe(6);
    expect(typeaheadIndex(labels, "я", 0)).toBe(-1);
    expect(typeaheadIndex(labels, " ", 0)).toBe(-1);
  });
});

describe("shortcutLetter", () => {
  it("латинская буква — как есть, в нижнем регистре (Shift, Caps Lock)", () => {
    expect(shortcutLetter({ key: "z", code: "KeyZ" })).toBe("z");
    expect(shortcutLetter({ key: "Z", code: "KeyZ" })).toBe("z");
  });
  it("русская раскладка: Ctrl+Я, Ctrl+Н, Alt+Р, Alt+Е — клавиши Z, Y, H, T", () => {
    expect(shortcutLetter({ key: "я", code: "KeyZ" })).toBe("z");
    expect(shortcutLetter({ key: "Н", code: "KeyY" })).toBe("y");
    expect(shortcutLetter({ key: "р", code: "KeyH" })).toBe("h");
    expect(shortcutLetter({ key: "е", code: "KeyT" })).toBe("t");
  });
  it("Option на Mac даёт символ («˙» на H) — тоже по клавише", () => {
    expect(shortcutLetter({ key: "˙", code: "KeyH" })).toBe("h");
  });
  it("другая латинская раскладка (AZERTY, Dvorak) — по букве, а не по месту клавиши", () => {
    expect(shortcutLetter({ key: "z", code: "KeyW" })).toBe("z");
  });
  it("не буква — null", () => {
    expect(shortcutLetter({ key: "1", code: "Digit1" })).toBeNull();
    expect(shortcutLetter({ key: "Escape", code: "Escape" })).toBeNull();
    expect(shortcutLetter({ key: "+", code: "Equal" })).toBeNull();
  });
});
