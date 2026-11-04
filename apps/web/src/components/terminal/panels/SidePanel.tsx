"use client";

import type { ChartStore, Drawing, LayerKey, MarkupSettings, PresetId } from "@platform/charts";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { IconButton, SegmentedControl } from "@/components/ui";
import { IconClose, IconGrid, IconLayers } from "@/components/ui/icons";
import { useLocale } from "@/i18n/client";
import { FoundCounter } from "../chart/FoundCounter";
import { fitByPriority, type ShedStep } from "../chrome/fitByPriority";
import { ToolIcon } from "../ToolIcon";
import { DrawingsList } from "./DrawingsList";
import { FoundTab, type FoundData } from "./found/FoundTab";
import { LayersTab } from "./LayersTab";
import { LayoutsTab } from "./LayoutsTab";
import { visibleTabs, type SideTabId } from "./sideTabs";
import { TopdownTab } from "./TopdownTab";
import s from "../terminal.module.css";
import p from "./panels.module.css";

type Props = {
  store: ChartStore;
  tab: SideTabId;
  onTab: (tab: SideTabId) => void;
  /** Закрыть панель (✕; то же — «Объекты» в тулбаре и Esc, когда панель поверх графика). */
  onClose: () => void;
  /** Панель поверх графика (900–1279): ✕ в ряду вкладок; встроенная закрывается кнопкой «Объекты». */
  overlay: boolean;
  /** Перетаскивание левого края панели (ширина хранится в useTerminalUi). */
  resize: { start: (e: ReactPointerEvent<HTMLElement>) => void; step: (delta: number) => void; active: boolean };
  /** Ресурс «Разбора» ответил 200 — вкладка видна. */
  topdown: boolean;
  found: FoundData;
  drawings: {
    items: readonly Drawing[];
    selectedId: string | null;
    sync: string | null;
    onSelect: (id: string | null) => void;
    onLock: (id: string) => void;
    onRemove: (id: string) => void;
    onClearAll: () => void;
  };
  layers: {
    markup: MarkupSettings;
    custom: boolean;
    onMarkup: (id: PresetId) => void;
    layers: Readonly<Record<LayerKey, boolean>>;
    onLayer: (k: LayerKey) => void;
    authed: boolean;
    liqUnavailable: boolean;
  };
  layouts: {
    layouts: readonly { name: string }[];
    onTemplate: (id: string) => void;
    onSave: (name: string) => void;
    onLoad: (name: string) => void;
    onDelete: (name: string) => void;
    authed: boolean;
    limit: number | null;
  };
};

/**
 * Правая панель десктопа (план 2B.9 §8): вкладки из реестра SIDE_TABS — «Найдено (n)», «Разбор» (резерв), «Рисунки (n)»,
 * «Слои», «Раскладки»; ряд 40 px, стрелки ←/→, активная — полоса --accent. Ширина меняется разделителем
 * (контракт pl-objects-w). Вкладки обёрнуты в memo и получают стабильные пропсы владельца.
 */
export const SidePanel = memo(function SidePanel({ store, tab, onTab, onClose, overlay, resize, topdown, found, drawings, layers, layouts }: Props) {
  const { t, locale } = useLocale();
  const idBase = useId();
  const tabs = visibleTabs({ topdown });
  const active = tabs.some((x) => x.id === tab) ? tab : "found";
  const { ref: rowRef, compact } = useTabFit([tabs.map((x) => x.id).join(","), drawings.items.length, locale, overlay].join("|"));
  const items = tabs.map((x) => {
    const small = compact.has(x.id);
    const text = x.id === "drawings" ? t("Рисунки ({n})", { n: drawings.items.length }) : t(x.title);
    const label = (body: ReactNode) => (
      <>
        <span className={p.tabIcon} aria-hidden="true">
          {TAB_ICON[x.id]}
        </span>
        <span className={p.tabText}>{body}</span>
      </>
    );
    const attrs = { "data-tab": x.id, "data-compact": small || undefined };
    if (x.id === "found")
      return {
        value: x.id,
        attrs,
        label: label(
          <FoundCounter store={store} figures={found.figures} patterns={found.patterns}>
            {(n) => t("Найдено ({n})", { n })}
          </FoundCounter>,
        ),
      };
    // свёрнутая в иконку вкладка: имя и подсказка — полное название
    return { value: x.id, attrs, label: label(text), ariaLabel: small ? text : undefined, title: small ? text : undefined };
  });
  return (
    <aside className={s.objects} aria-label={t("панель объектов")}>
      <button
        type="button"
        className={s.splitter}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("ширина панели объектов")}
        title={t("Тяните, чтобы изменить ширину; ← → с клавиатуры")}
        data-active={resize.active || undefined}
        onPointerDown={resize.start}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") resize.step(20);
          else if (e.key === "ArrowRight") resize.step(-20);
          else return;
          e.preventDefault();
        }}
      />
      <div className={p.tabs}>
        <SegmentedControl mode="tabs" variant="underline" items={items} value={active} onSelect={onTab} label={t("вкладки панели объектов")} idBase={idBase} panelId={(v) => `${idBase}-panel-${v}`} className={p.tabRow} rootRef={rowRef} />
        {overlay && (
          <IconButton size="sm" label={t("закрыть панель объектов")} onClick={onClose} className={p.close}>
            <IconClose />
          </IconButton>
        )}
      </div>
      <div className={p.body} role="tabpanel" id={`${idBase}-panel-${active}`} aria-labelledby={`${idBase}-tab-${active}`}>
        {active === "found" && <FoundTab store={store} data={found} />}
        {active === "topdown" && <TopdownTab />}
        {active === "drawings" && <DrawingsList drawings={drawings.items} selectedId={drawings.selectedId} sync={drawings.sync} onSelect={drawings.onSelect} onLock={drawings.onLock} onRemove={drawings.onRemove} onClearAll={drawings.onClearAll} />}
        {active === "layers" && <LayersTab {...layers} />}
        {active === "layouts" && <LayoutsTab {...layouts} />}
      </div>
    </aside>
  );
});

/** Значки вкладок, свёрнутых при нехватке ширины (порядок — TAB_SHED). */
const TAB_ICON: Record<SideTabId, ReactNode> = {
  found: null,
  topdown: null,
  drawings: <ToolIcon name="trend" />,
  layers: <IconLayers />,
  layouts: <IconGrid />,
};
/** Вкладки не прячутся в меню: при нехватке ширины сворачиваются в иконку — Раскладки → Слои → Рисунки (§8). */
const TAB_SHED: readonly ShedStep[] = [
  { id: "layouts", action: "compact" },
  { id: "layers", action: "compact" },
  { id: "drawings", action: "compact" },
];
/** Ширина вкладки-иконки: не меньше min-width сегмента (36 px). */
const ICON_TAB_PX = 36;
const NO_COMPACT: ReadonlySet<string> = new Set();

/**
 * Подгонка ряда вкладок: полные ширины замеряются один раз за ключ (состав, число рисунков, язык) в layout-эффекте,
 * при ресайзе только пересчитывается, какие вкладки свернуть (fitByPriority, как шапка и тулбар).
 */
function useTabFit(measureKey: string) {
  const ref = useRef<HTMLDivElement>(null);
  const widths = useRef<Record<string, { full: number; compact: number }> | null>(null);
  // панель скрыта (display: none) — замер откладывается до её появления (ResizeObserver поднимает rev)
  const [rev, setRev] = useState(0);
  const key = `${measureKey}|${rev}`;
  const [state, setState] = useState<{ key: string; compact: ReadonlySet<string> } | null>(null);
  const keyRef = useRef(key);
  const measuring = state?.key !== key;
  const refit = useCallback((k: string) => {
    const el = ref.current;
    if (!el || !widths.current) return;
    const f = fitByPriority(widths.current, TAB_SHED, el.clientWidth, 0);
    setState((prev) => (prev && prev.key === k && prev.compact.size === f.compact.size && [...f.compact].every((x) => prev.compact.has(x)) ? prev : { key: k, compact: f.compact }));
  }, []);
  useLayoutEffect(() => {
    keyRef.current = key;
    const el = ref.current;
    if (!measuring || !el) return;
    if (el.clientWidth === 0) {
      widths.current = null;
      return;
    }
    const out: Record<string, { full: number; compact: number }> = {};
    for (const c of el.children) {
      const id = (c as HTMLElement).dataset.tab;
      if (id) out[id] = { full: c.getBoundingClientRect().width, compact: ICON_TAB_PX };
    }
    widths.current = out;
    refit(key);
  }, [measuring, key, refit]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!widths.current) {
        if (el.clientWidth > 0) setRev((r) => r + 1);
        return;
      }
      refit(keyRef.current);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [refit]);
  return { ref, compact: measuring || !state ? NO_COMPACT : state.compact };
}
