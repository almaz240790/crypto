import { describe, expect, it } from "vitest";
import { CARD_GAP_PX, cardBottomMargin, drawingExtent } from "./cardInset";

/** Карточка выбранного рисунка не закрывает его (ADR-0009, «Рисование», дополнение 2026-11-12; аудит LP2-4). */
describe("нижнее поле шкалы цены под карточку выбранного рисунка", () => {
  const main = { w: 330, h: 540 };
  const M = { top: 0.08, bottom: 0.2 };
  /** Рисунок над свечами (нижняя точка — на низе свечей, y = 0.8 панели) во всю ширину. */
  const wide = { left: 0, right: 330, low: 432 };
  /** Раскрытые «уровни» Фибоначчи на телефоне 390×844 — 234 px. */
  const opened = { x: 8, y: 356, w: 374, h: 234 };

  /** y точки с полем шкалы bottom — по её месту среди свечей при полях M. */
  const yAt = (low: number, bottom: number) => M.top * 540 + ((low - M.top * 540) / ((1 - M.top - M.bottom) * 540)) * (1 - M.top - bottom) * 540;

  it("нижняя точка на низе свечей под раскрытой карточкой — поле до верха карточки с запасом на ручку", () => {
    expect(cardBottomMargin([opened], main, wide, M)).toBeCloseTo((540 - 356 + CARD_GAP_PX) / 540, 9);
  });

  it("точка ниже свечей (в нижнем поле) — поле больше; с ним точка — у верха карточки; ответ не зависит от выросшего поля", () => {
    const low = { ...wide, low: 470 };
    const share = cardBottomMargin([opened], main, low, M);
    expect(share).toBeGreaterThan((540 - 356 + CARD_GAP_PX) / 540);
    expect(yAt(470, share)).toBeCloseTo(356 - CARD_GAP_PX, 6);
    expect(cardBottomMargin([opened], main, { ...low, low: yAt(470, share) }, { top: M.top, bottom: share })).toBeCloseTo(share, 9);
  });

  it("рисунок и так над карточкой — поле не больше поля по умолчанию (график не меняется)", () => {
    expect(cardBottomMargin([opened], main, { ...wide, low: 300 }, M)).toBeLessThanOrEqual(M.bottom);
    // свёрнутая карточка (одна строка, 62 px) — в нижнем поле: рисунок на низе свечей над ней
    expect(cardBottomMargin([{ x: 8, y: 470, w: 374, h: 62 }], main, wide, M)).toBeLessThanOrEqual(M.bottom);
  });

  it("стопка карточек — по самой верхней; карточка ниже панели, правее области свечей или не над рисунком — не в счёт", () => {
    expect(cardBottomMargin([{ x: 8, y: 480, w: 300, h: 60 }, { x: 8, y: 400, w: 300, h: 72 }], main, wide, M)).toBeCloseTo((140 + CARD_GAP_PX) / 540, 9);
    expect(cardBottomMargin([{ x: 8, y: 560, w: 300, h: 40 }], main, wide, M)).toBe(0);
    expect(cardBottomMargin([{ x: 340, y: 300, w: 40, h: 40 }], main, wide, M)).toBe(0);
    // десктоп: карточка слева, рисунок справа от неё
    expect(cardBottomMargin([{ x: 8, y: 356, w: 200, h: 120 }], main, { left: 240, right: 320, low: 420 }, M)).toBe(0);
  });

  it("без выбранного рисунка, без карточек или до размеров панели — 0 (поле по умолчанию)", () => {
    expect(cardBottomMargin([opened], main, null, M)).toBe(0);
    expect(cardBottomMargin([], main, wide, M)).toBe(0);
    expect(cardBottomMargin([opened], { w: 0, h: 0 }, wide, M)).toBe(0);
  });

  it("рисунок на экране: точки, у Фибоначчи — и показанные уровни; горизонтальная линия — во всю ширину", () => {
    const proj = { x: (t: number) => t, y: (p: number) => 600 - p, width: 330 };
    expect(drawingExtent({ type: "trend", points: [{ time: 40, price: 300 }, { time: 200, price: 250 }] }, proj)).toEqual({ left: 40, right: 200, low: 350 });
    // уровень −0.618 — за второй точкой (ниже минимума 100 на 61.8 % хода 100)
    expect(drawingExtent({ type: "fib", points: [{ time: 40, price: 200 }, { time: 200, price: 100 }], levels: [-0.618, 0, 1] }, proj)!.low).toBeCloseTo(600 - 38.2, 9);
    expect(drawingExtent({ type: "hline", points: [{ time: 100, price: 300 }] }, proj)).toEqual({ left: 0, right: 330, low: 300 });
    expect(drawingExtent({ type: "hray", points: [{ time: 100, price: 300 }] }, proj)).toEqual({ left: 100, right: 330, low: 300 });
    expect(drawingExtent({ type: "trend", points: [{ time: 40, price: 300 }] }, { ...proj, y: () => null })).toBeNull();
  });
});
