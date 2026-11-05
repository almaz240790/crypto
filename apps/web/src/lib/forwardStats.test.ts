import { describe, expect, it } from "vitest";
import type { StrategyVersionInfo } from "./api";
import { forwardVersionOptions } from "./forwardStats";

const v = (id: number, version: string, status: string): StrategyVersionInfo => ({
  id,
  strategy: "trend-ob-retest",
  name: "Trend OB retest",
  version,
  status,
  activated_at: null,
});

describe("forwardVersionOptions", () => {
  const all = [v(1, "1.0.0", "forward"), v(2, "1.1.0", "archived"), v(3, "1.2.0", "forward"), v(4, "1.3.0", "live")];

  it("только версии в статусе forward, без пункта «все»", () => {
    expect(forwardVersionOptions(all, null).map((x) => x.version)).toEqual(["1.0.0", "1.2.0"]);
  });

  it("явно запрошенная версия вне форварда остаётся в списке, порядок по id", () => {
    const cur = { id: 2, strategy: "trend-ob-retest", name: "Trend OB retest", version: "1.1.0", status: "archived" };
    expect(forwardVersionOptions(all, cur).map((x) => x.version)).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
  });

  it("версия из ответа, которой нет в /v1/strategies (кэш), тоже показывается", () => {
    const cur = { id: 9, strategy: "trend-ob-retest", name: "Trend OB retest", version: "1.9.0", status: "forward" };
    expect(forwardVersionOptions([], cur)).toEqual([{ ...cur, activated_at: null }]);
  });
});
