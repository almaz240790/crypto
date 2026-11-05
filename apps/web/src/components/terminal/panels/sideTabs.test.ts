import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIDE_TABS, visibleTabs } from "./sideTabs";

const en = JSON.parse(readFileSync(new URL("../../../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;

describe("вкладки правой панели (план 2B.9 §8)", () => {
  it("порядок: Найдено, Разбор, Рисунки, Слои, Раскладки", () => {
    expect(SIDE_TABS.map((x) => x.id)).toEqual(["found", "topdown", "drawings", "layers", "layouts"]);
  });

  it("«Разбор» скрыт, пока ресурс topdown не ответил 200, и виден только владельцу и админам", () => {
    expect(visibleTabs({ topdown: false, role: "owner" }).map((x) => x.id)).toEqual(["found", "drawings", "layers", "layouts"]);
    expect(visibleTabs({ topdown: true, role: "owner" }).map((x) => x.id)).toContain("topdown");
    expect(visibleTabs({ topdown: true, role: "admin" }).map((x) => x.id)).toContain("topdown");
    expect(visibleTabs({ topdown: true, role: "user" }).map((x) => x.id)).not.toContain("topdown");
    expect(visibleTabs({ topdown: true, role: null }).map((x) => x.id)).not.toContain("topdown");
  });

  it("у всех заголовков есть перевод; со счётчиком — только «Найдено» и «Рисунки»", () => {
    for (const x of SIDE_TABS) expect(en[x.title], x.title).toBeTruthy();
    expect(SIDE_TABS.filter((x) => x.counted).map((x) => x.id)).toEqual(["found", "drawings"]);
  });
});
