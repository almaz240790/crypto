"use client";

import type { ChartStore, ChartType, IndicatorInstance, MarkupSettings, PanelKey, PresetId, ScaleMode, Timeframe } from "@platform/charts";
import { useRouter } from "next/navigation";
import { memo, type Ref } from "react";
import { Button, IconButton, Menu, Popover, usePopover, type MenuItemSpec } from "@/components/ui";
import { IconBell, IconCamera, IconExpand, IconGrid, IconIndicators, IconMore, IconPanel } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import type { FigureOnChart, PatternOnChart } from "@/lib/chart";
import type { Instrument } from "@/lib/user";
import { FoundCounter } from "../chart/FoundCounter";
import { presetTitle } from "../MarkupPicker";
import { AlertForm } from "../sheets/AlertForm";
import { IndicatorsPicker } from "../sheets/IndicatorsPicker";
import type { AlertDraft } from "../state/useChartAlerts";
import type { ShedStep } from "./fitByPriority";
import { MarkupMenu } from "./MarkupMenu";
import { TimeframeBar, type TimeframeBarHandle } from "./TimeframeBar";
import { overflowItem, useOverflow } from "./useOverflow";
import { ViewMenu } from "./ViewMenu";
import c from "./chrome.module.css";

/**
 * Порядок сброса при нехватке ширины (план 2B.9, §3.3): 1 «Объекты» — иконка; 2 «Мультичарт» и 3 «Снимок» —
 * в «⋯»; 4 «Вид» — иконка; 5 «Индикаторы» и «Алерт» — без иконки; 6 «Разметка» — иконка.
 * Таймфреймы и «⋯» не сбрасываются никогда.
 */
const TOOLBAR_SHED: readonly ShedStep[] = [
  { id: "objects", action: "compact" },
  { id: "multi", action: "hide" },
  { id: "snap", action: "hide" },
  { id: "view", action: "compact" },
  { id: "ind", action: "compact" },
  { id: "alert", action: "compact" },
  { id: "markup", action: "compact" },
];

/** Окно у кнопки, которым управляет владелец (алерт закрывается после создания). */
export type PopoverState = ReturnType<typeof usePopover>;

type Props = {
  symbol: string;
  tf: Timeframe;
  intradayLocked: boolean;
  guest: boolean;
  tfRef: Ref<TimeframeBarHandle>;
  instruments: readonly Instrument[];
  type: ChartType;
  scale: ScaleMode;
  overlay: string | null;
  onType: (t: ChartType) => void;
  onScale: (s: ScaleMode) => void;
  onOverlay: (symbol: string | null) => void;
  /** Экземпляры индикаторов: «Индикаторы (n)» считает экземпляры и панели производных. */
  instances: readonly IndicatorInstance[];
  panels: readonly PanelKey[];
  onIndicator: (id: string) => void;
  onAddIndicator: (id: string) => void;
  onRemoveInstance: (uid: string) => void;
  onInstanceParams: (uid: string, params: Record<string, number>) => void;
  onPanel: (k: PanelKey) => void;
  markup: MarkupSettings;
  custom: boolean;
  onMarkup: (id: PresetId) => void;
  onLayers: () => void;
  authed: boolean;
  alertsCount: number;
  alert: PopoverState;
  alertDraft: AlertDraft;
  onAlertDraft: (d: AlertDraft) => void;
  /** Окно алерта открывается: черновик с текущей ценой. */
  onAlertOpen: () => void;
  onAlertSubmit: () => void;
  onSnapshot: () => void;
  objectsShown: boolean;
  onObjects: () => void;
  /** Бейдж «Объектов» — лист-счётчик «Найдено» (FoundCounter): тулбар не перерисовывается при сдвиге графика. */
  store: ChartStore;
  figures: readonly FigureOnChart[];
  patterns: readonly PatternOnChart[];
};

/** Полный экран — на странице терминала (data-fullscreen-root): попапы рендерятся внутри неё и остаются видны. */
function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.querySelector<HTMLElement>("[data-fullscreen-root]")?.requestFullscreen?.();
}

/**
 * Тулбар десктопа, 40 px (план 2B.9, §3.3). Слева: таймфреймы, «Вид», «Индикаторы (n)», «Разметка», «Алерт (n)»;
 * справа: «Снимок», «Мультичарт», «⋯ Ещё», «Объекты». Элементы сворачиваются и уходят в «⋯» по приоритету
 * (useOverflow) — ничего не обрезается краем окна.
 */
export const TerminalToolbar = memo(function TerminalToolbar(p: Props) {
  const t = useT();
  const router = useRouter();
  const ind = usePopover();
  const n = p.instances.length + p.panels.length;
  const markupName = p.custom ? t("Свой") : presetTitle(p.markup.preset, t);
  const key = [p.tf, p.intradayLocked, p.guest, n, p.alertsCount, markupName].join("|");
  const { ref: rowRef, fit } = useOverflow<HTMLDivElement>(TOOLBAR_SHED, key);
  const more: MenuItemSpec[] = [
    ...(fit.hidden.has("snap") ? [{ id: "snap", label: t("Снимок"), icon: <IconCamera />, onSelect: p.onSnapshot }] : []),
    ...(fit.hidden.has("multi") ? [{ id: "multi", label: t("Мультичарт"), icon: <IconGrid />, onSelect: () => router.push("/multichart") }] : []),
    ...(fit.hidden.size ? [{ type: "separator" as const, id: "sep" }] : []),
    { id: "fullscreen", label: t("Полный экран"), icon: <IconExpand />, onSelect: toggleFullscreen },
  ];
  return (
    <div ref={rowRef} className={c.toolbar} data-testid="terminal-toolbar">
      <div {...overflowItem("tf", fit)}>
        <TimeframeBar ref={p.tfRef} symbol={p.symbol} tf={p.tf} intradayLocked={p.intradayLocked} guest={p.guest} />
      </div>
      <div {...overflowItem("view", fit)}>
        <ViewMenu symbol={p.symbol} type={p.type} scale={p.scale} overlay={p.overlay} instruments={p.instruments} onType={p.onType} onScale={p.onScale} onOverlay={p.onOverlay} />
      </div>
      <div {...overflowItem("ind", fit)}>
        <Button {...ind.triggerProps} variant="ghost">
          <span data-ov-extra>
            <IconIndicators />
          </span>
          {t("Индикаторы ({n})", { n })}
        </Button>
        <Popover open={ind.open} onClose={ind.close} anchor={ind.anchor} label={t("Индикаторы")} id={ind.id} width="min(560px, calc(100vw - 16px))">
          <IndicatorsPicker instances={p.instances} panels={p.panels} onIndicator={p.onIndicator} onAdd={p.onAddIndicator} onRemove={p.onRemoveInstance} onParams={p.onInstanceParams} onPanel={p.onPanel} onDone={ind.close} />
        </Popover>
      </div>
      <div {...overflowItem("markup", fit)}>
        <MarkupMenu markup={p.markup} custom={p.custom} onSelect={p.onMarkup} onLayers={p.onLayers} />
      </div>
      <div {...overflowItem("alert", fit)}>
        <Button
          {...p.alert.triggerProps}
          variant="ghost"
          onClick={(e) => {
            if (!p.alert.open) p.onAlertOpen();
            p.alert.toggle(e.currentTarget);
          }}
        >
          <span data-ov-extra>
            <IconBell />
          </span>
          {t("Алерт")}
          {p.alertsCount ? ` (${p.alertsCount})` : ""}
        </Button>
        <Popover open={p.alert.open} onClose={p.alert.close} anchor={p.alert.anchor} label={t("Алерт по цене")} id={p.alert.id} width={320}>
          <AlertForm authed={p.authed} draft={p.alertDraft} onDraft={p.onAlertDraft} onSubmit={p.onAlertSubmit} count={p.alertsCount} />
        </Popover>
      </div>
      <span className={c.spacer} />
      <span {...overflowItem("snap", fit)}>
        <IconButton label={t("Снимок")} title={t("Снимок PNG с водяным знаком")} onClick={p.onSnapshot}>
          <IconCamera />
        </IconButton>
      </span>
      <span {...overflowItem("multi", fit)}>
        <IconButton label={t("Мультичарт")} title={t("Мультичарт: 2 или 4 графика")} href="/multichart">
          <IconGrid />
        </IconButton>
      </span>
      <span {...overflowItem("more", fit)}>
        <Menu
          items={more}
          align="end"
          minWidth={200}
          trigger={(m) => (
            <IconButton {...m} label={t("Ещё")}>
              <IconMore />
            </IconButton>
          )}
        />
      </span>
      <span {...overflowItem("objects", fit)}>
        <Button variant="ghost" aria-label={t("Объекты")} aria-pressed={p.objectsShown} title={t("Панель объектов: найденное, рисунки, слои, раскладки")} onClick={p.onObjects}>
          <IconPanel />
          <span data-ov-extra>{t("Объекты")}</span>
          <FoundCounter store={p.store} figures={p.figures} patterns={p.patterns}>
            {(found) =>
              found > 0 && (
                <span className={c.badge} data-ov-extra aria-hidden="true">
                  {found}
                </span>
              )
            }
          </FoundCounter>
        </Button>
      </span>
    </div>
  );
});
