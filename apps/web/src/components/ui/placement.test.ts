import { describe, expect, it } from "vitest";
import { placePopup } from "./placement";

const VIEW = { width: 1280, height: 800 };

describe("placePopup", () => {
  it("под якорем, по левому краю, с отступом 4 px", () => {
    const p = placePopup({ left: 100, top: 50, width: 80, height: 32 }, { width: 280, height: 200 }, VIEW);
    expect(p).toEqual({ left: 100, top: 86, side: "bottom", maxHeight: 800 - 82 - 4 - 8 });
  });
  it("align end — правый край окна по правому краю якоря; center — по центру", () => {
    expect(placePopup({ left: 600, top: 50, width: 80, height: 32 }, { width: 280, height: 100 }, VIEW, { align: "end" }).left).toBe(400);
    expect(placePopup({ left: 600, top: 50, width: 80, height: 32 }, { width: 280, height: 100 }, VIEW, { align: "center" }).left).toBe(500);
  });
  it("прижимается к окну по горизонтали с отступом 8 px", () => {
    expect(placePopup({ left: 1200, top: 50, width: 60, height: 32 }, { width: 280, height: 100 }, VIEW).left).toBe(1280 - 8 - 280);
    expect(placePopup({ left: 2, top: 50, width: 60, height: 32 }, { width: 280, height: 100 }, VIEW, { align: "end" }).left).toBe(8);
    // шире окна — от левого отступа
    expect(placePopup({ left: 100, top: 50, width: 60, height: 32 }, { width: 2000, height: 100 }, VIEW).left).toBe(8);
  });
  it("снизу не помещается, сверху места больше — над якорем; высота ограничена местом", () => {
    const p = placePopup({ left: 100, top: 700, width: 80, height: 32 }, { width: 280, height: 300 }, VIEW);
    expect(p.side).toBe("top");
    expect(p.top).toBe(700 - 4 - 300);
    expect(p.maxHeight).toBe(700 - 4 - 8);
  });
  it("не помещается нигде — туда, где места больше, со своей прокруткой", () => {
    const p = placePopup({ left: 100, top: 300, width: 80, height: 32 }, { width: 280, height: 900 }, VIEW);
    expect(p.side).toBe("bottom");
    expect(p.top).toBe(336);
    expect(p.maxHeight).toBe(800 - 332 - 4 - 8);
  });
});
