import { describe, expect, it } from "vitest";
import { mergeZones, zoneName } from "./zones";

const z = (kind: string, dir: string, bottom: number, top: number, status = "active") => ({ kind, dir, top: String(top), bottom: String(bottom), from_t: bottom, status });

describe("зоны", () => {
  it("понятные названия", () => {
    expect(zoneName("ob", "up")).toBe("ордер-блок покупок");
    expect(zoneName("sd", "down")).toBe("зона предложения");
    expect(zoneName("xx", "up")).toBe("XX");
  });
  it("пересекающиеся склеиваются, отработанные отброшены, ближайшая к цене первая", () => {
    const g = mergeZones([z("ob", "up", 100, 110), z("sd", "up", 105, 115), z("fvg", "down", 130, 135), z("ob", "down", 90, 95, "touched")], 112);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ bottom: 100, top: 115, dir: "up", names: ["ордер-блок покупок", "зона спроса"] });
    expect(g[1]!.names).toEqual(["разрыв цены вниз"]);
  });
  it("разные направления в одной группе — mixed", () => {
    expect(mergeZones([z("ob", "up", 100, 110), z("sd", "down", 108, 112)], 50)[0]!.dir).toBe("mixed");
  });
});
