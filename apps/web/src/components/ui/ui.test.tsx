import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IconButton } from "./IconButton";
import { Menu } from "./Menu";
import { Popover } from "./Popover";
import { SegmentedControl } from "./SegmentedControl";

/** Разметка и ARIA компонентов ui (план 2B.9); клавиатура и фокус — в e2e/ui.chrome.spec.ts. */
describe("IconButton", () => {
  it("имя обязательно: aria-label и title; нажатая — aria-pressed", () => {
    const html = renderToStaticMarkup(
      <IconButton label="магнит к OHLC" pressed>
        <svg />
      </IconButton>,
    );
    expect(html).toContain('aria-label="магнит к OHLC"');
    expect(html).toContain('title="магнит к OHLC"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('type="button"');
  });
  it("title длиннее имени; недоступная — атрибут disabled", () => {
    const html = renderToStaticMarkup(
      <IconButton label="Снимок" title="Снимок PNG с водяным знаком" disabled>
        <svg />
      </IconButton>,
    );
    expect(html).toContain('aria-label="Снимок"');
    expect(html).toContain('title="Снимок PNG с водяным знаком"');
    expect(html).toContain("disabled");
    expect(html).not.toContain("aria-pressed");
  });
  it("ссылка — <a> с именем, без aria-pressed", () => {
    const html = renderToStaticMarkup(
      <IconButton label="Мультичарт" href="/multichart">
        <svg />
      </IconButton>,
    );
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/multichart"');
    expect(html).toContain('aria-label="Мультичарт"');
  });
});

describe("SegmentedControl", () => {
  const items = [
    { value: "levels", label: "Уровни (6)" },
    { value: "figures", label: "Фигуры (1)", disabled: true },
    { value: "patterns", label: "Паттерны (2)" },
  ] as const;
  it("tabs: tablist с именем, aria-selected, в порядке Tab только активная вкладка, aria-controls", () => {
    const html = renderToStaticMarkup(<SegmentedControl mode="tabs" label="разделы найденного" items={items} value="patterns" idBase="f" panelId={(v) => `p-${v}`} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="разделы найденного"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('id="f-tab-patterns" aria-selected="true" aria-controls="p-patterns" tabindex="0"');
    expect(html).toContain('id="f-tab-levels" aria-selected="false" aria-controls="p-levels" tabindex="-1"');
  });
  it("tabs без активной — в порядке Tab первая доступная", () => {
    const html = renderToStaticMarkup(<SegmentedControl mode="tabs" label="x" items={items} value={null} idBase="f" />);
    expect(html).toContain('id="f-tab-levels" aria-selected="false" tabindex="0"');
  });
  it("toggle: группа с именем, кнопки с aria-pressed", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl
        mode="toggle"
        label="число графиков"
        value="4"
        items={[
          { value: "2", label: "2" },
          { value: "4", label: "4" },
        ]}
      />,
    );
    expect(html).toContain('role="group" aria-label="число графиков"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-pressed="true"');
  });
  it("links: nav, активная ссылка aria-current=page; сегмент без адреса — кнопка с атрибутами", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl
        mode="links"
        label="таймфрейм"
        value="4h"
        items={[
          { value: "4h", label: "4ч", href: "/chart/BTCUSDT/4h" },
          { value: "1d", label: "1Д", href: "/chart/BTCUSDT/1d" },
          { value: "1m", label: "1м", attrs: { "data-locked": "true", "aria-haspopup": "dialog" } },
        ]}
      />,
    );
    expect(html).toMatch(/^<nav aria-label="таймфрейм"/);
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/chart\/BTCUSDT\/4h">4ч<\/a>/);
    expect(html).toMatch(/<a class="[^"]*" href="\/chart\/BTCUSDT\/1d">1Д<\/a>/);
    expect(html).toMatch(/<button type="button"[^>]*data-locked="true"[^>]*aria-haspopup="dialog"[^>]*>1м<\/button>/);
  });
});

describe("Menu и Popover", () => {
  it("закрытое меню — только кнопка с aria-haspopup=menu и aria-expanded=false", () => {
    const html = renderToStaticMarkup(<Menu items={[{ id: "a", label: "A" }]} trigger={(p) => <button {...p}>Разметка</button>} />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });
  it("закрытый Popover ничего не рисует; открытый — dialog с именем", () => {
    expect(renderToStaticMarkup(<Popover open={false} onClose={() => {}} anchor={null} label="Вид">x</Popover>)).toBe("");
    const html = renderToStaticMarkup(
      <Popover open onClose={() => {}} anchor={null} label="Вид" id="v">
        <select aria-label="тип графика" />
      </Popover>,
    );
    expect(html).toContain('role="dialog" aria-label="Вид"');
    expect(html).not.toContain("aria-modal");
  });
});
