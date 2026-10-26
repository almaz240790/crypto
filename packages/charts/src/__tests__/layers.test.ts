import { describe, expect, it, vi } from "vitest";
import { LayerManager, type Layer, type LayerContext } from "../layers";
import { alpha } from "../theme";

function fake(id: string): Layer & { calls: string[] } {
  const calls: string[] = [];
  return { id, calls, attach: () => calls.push("attach"), detach: () => calls.push("detach"), setVisible: (v) => calls.push(`visible:${v}`) };
}

describe("менеджер слоёв", () => {
  it("порядок, видимость, повторное добавление", () => {
    const m = new LayerManager();
    const a = fake("a"), b = fake("b");
    m.add(a);
    m.add(b, false);
    expect(m.ids()).toEqual(["a", "b"]);
    m.bringToFront("a");
    expect(m.ids()).toEqual(["b", "a"]);
    expect(m.isVisible("b")).toBe(false);
    const ctx = { chart: {}, main: {} } as unknown as LayerContext;
    m.attach(ctx);
    expect(a.calls).toEqual(["attach", "visible:true"]);
    expect(b.calls).toEqual(["attach", "visible:false"]);
    m.setVisible("b", true);
    expect(b.calls.at(-1)).toBe("visible:true");
    const a2 = fake("a");
    m.add(a2);
    expect(a.calls.at(-1)).toBe("detach");
    m.detachAll();
    expect(a2.calls.at(-1)).toBe("detach");
    vi.restoreAllMocks();
  });

  it("alpha переводит hex в rgba", () => {
    expect(alpha("#1f8a5b", 0.5)).toBe("rgba(31, 138, 91, 0.5)");
    expect(alpha("rgb(1,2,3)", 0.5)).toBe("rgb(1,2,3)");
  });
});
