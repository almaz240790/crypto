import { describe, expect, it } from "vitest";
import { gateFileName, gateTone, type GateReport } from "./liveGate";

describe("liveGate", () => {
  it("цвет статуса критерия", () => {
    expect(gateTone("выполнено")).toBe("up");
    expect(gateTone("не выполнено")).toBe("down");
    expect(gateTone("нужно решение человека")).toBe("warn");
  });

  it("имя файла отчёта", () => {
    const own: GateReport = { title: "1.2.0", version: "trend-ob-retest@1.2.0", symbols_of: null };
    expect(gateFileName(own, "2026-11-16T02:05:00+00:00")).toBe("live-gate-1.2.0-2026-11-16.md");
    const cand: GateReport = {
      ...own,
      symbols_of: "trend-ob-retest@1.2.1",
      summary: { now: "2026-11-16T00:00:00+00:00" } as GateReport["summary"],
    };
    expect(gateFileName(cand, null)).toBe("live-gate-1.2.0-для-1.2.1-2026-11-16.md");
    expect(gateFileName(own, null)).toBe("live-gate-1.2.0-отчёт.md");
  });
});
