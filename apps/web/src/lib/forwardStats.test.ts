import { describe, expect, it } from "vitest";
import type { StrategyVersionInfo, StrategyVersionRef } from "./api";
import { forwardEmptyKind, forwardVersionOptions } from "./forwardStats";

const ref = (id: number, version: string, status: string): StrategyVersionRef => ({
  id,
  strategy: "trend-ob-retest",
  name: "Trend OB retest",
  version,
  status,
});
const v = (id: number, version: string, status: string): StrategyVersionInfo => ({ ...ref(id, version, status), activated_at: null });

describe("forwardVersionOptions", () => {
  const all = [v(1, "1.0.0", "forward"), v(2, "1.1.0", "archived"), v(3, "1.2.0", "forward"), v(4, "1.3.0", "live")];

  it("список из ответа API — как есть, по id: версии в форварде и архивные с форвард-историей", () => {
    const listed = [ref(3, "1.2.0", "forward"), ref(1, "1.0.0", "archived"), ref(2, "1.1.0", "forward")];
    expect(forwardVersionOptions(listed, all, listed[0]).map((x) => `${x.version} ${x.status}`)).toEqual([
      "1.0.0 archived",
      "1.1.0 forward",
      "1.2.0 forward",
    ]);
  });

  it("пустой список из API остаётся пустым: /v1/strategies его не подменяет", () => {
    expect(forwardVersionOptions([], all, null)).toEqual([]);
  });

  it("без поля versions (старый API) — версии в статусе forward из /v1/strategies, без пункта «все»", () => {
    expect(forwardVersionOptions(undefined, all, null).map((x) => x.version)).toEqual(["1.0.0", "1.2.0"]);
    // лишних полей (activated_at) в результате нет
    expect(forwardVersionOptions(undefined, all, null)[0]).toEqual(ref(1, "1.0.0", "forward"));
  });

  it("явно запрошенная версия, которой нет в списке, остаётся в селекторе, порядок по id", () => {
    const cur = ref(2, "1.1.0", "archived");
    expect(forwardVersionOptions(undefined, all, cur).map((x) => x.version)).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
    expect(forwardVersionOptions([ref(3, "1.2.0", "forward")], all, cur).map((x) => x.version)).toEqual(["1.1.0", "1.2.0"]);
  });

  it("версия из ответа при пустом /v1/strategies (кэш) тоже показывается", () => {
    const cur = ref(9, "1.9.0", "forward");
    expect(forwardVersionOptions(undefined, [], cur)).toEqual([cur]);
  });
});

describe("forwardEmptyKind", () => {
  it("версии нет — «ни одна версия не в форварде», даже при фильтрах", () => {
    expect(forwardEmptyKind(null, false)).toBe("none");
    expect(forwardEmptyKind(undefined, true)).toBe("none");
  });

  it("версия в форварде без сделок — «пока нет сделок»; с фильтрами — «по этим фильтрам»", () => {
    expect(forwardEmptyKind(ref(3, "1.2.0", "forward"), false)).toBe("no-trades");
    expect(forwardEmptyKind(ref(3, "1.2.0", "forward"), true)).toBe("filtered");
  });

  it("версия не в форварде (архив, backtest, live) — не «пока нет сделок»", () => {
    for (const status of ["archived", "backtest", "live"]) {
      expect(forwardEmptyKind(ref(1, "1.0.0", status), false)).toBe("not-forward");
    }
    expect(forwardEmptyKind(ref(1, "1.0.0", "archived"), true)).toBe("filtered");
  });
});
