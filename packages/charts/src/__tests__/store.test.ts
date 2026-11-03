import { describe, expect, it } from "vitest";
import { createChartStore } from "../store/chartStore";

describe("ChartStore", () => {
  it("patch с равными срезами не уведомляет, с новым — уведомляет один раз", () => {
    const store = createChartStore();
    let n = 0;
    store.subscribe(() => n++);
    const s0 = store.getState();
    store.patch({ selection: null, hover: null, legend: s0.legend, status: s0.status });
    expect(n).toBe(0);
    expect(store.getState()).toBe(s0);
    store.patch({ status: { ...s0.status, themeVersion: 2 } });
    expect(n).toBe(1);
    expect(store.getState().status.themeVersion).toBe(2);
    expect(store.getState().legend).toBe(s0.legend);
  });

  it("select уведомляет; повтор того же — нет; отписка работает", () => {
    const store = createChartStore({ selection: "a" });
    let n = 0;
    const off = store.subscribe(() => n++);
    store.select("a");
    expect(n).toBe(0);
    store.select("sr:S:1");
    expect(n).toBe(1);
    expect(store.getState().selection).toBe("sr:S:1");
    off();
    store.select(null);
    expect(n).toBe(1);
  });
});
