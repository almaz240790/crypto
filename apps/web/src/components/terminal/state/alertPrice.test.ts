import { describe, expect, it } from "vitest";
import { alertPriceText } from "./alertPrice";

describe("цена в форме алерта — по шагу инструмента (план 2B.9 §9)", () => {
  it("знаков столько, сколько даёт шаг; без разрядов и шума float", () => {
    expect(alertPriceText(77441.70000000001, "0.1")).toBe("77441.7");
    expect(alertPriceText(0.1 + 0.2, "0.01")).toBe("0.30");
    expect(alertPriceText(64000, "1")).toBe("64000");
  });

  it("мелкая цена — без экспоненты, шаг в экспоненциальной записи", () => {
    expect(String(4.5e-7)).toBe("4.5e-7");
    expect(alertPriceText(4.5e-7, "1.000E-8")).toBe("0.00000045");
    expect(alertPriceText(0.00494, "0.0000001")).toBe("0.0049400");
  });

  it("шаг неизвестен — до 8 значащих цифр без нулей в конце, тоже без экспоненты", () => {
    expect(alertPriceText(4.5e-7, null)).toBe("0.00000045");
    expect(alertPriceText(77441.70000000001, null)).toBe("77441.70");
    expect(alertPriceText(0.123456789, null)).toBe("0.12345679");
    expect(alertPriceText(0, null)).toBe("0.00");
  });
});
