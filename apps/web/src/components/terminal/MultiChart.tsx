"use client";

/** Мультичарт (план 3.17, v2; только десктоп): 2 или 4 графика с независимыми инструментом и таймфреймом. */
import { createChartStore, NONE, PRESETS, SELECTABLE_PRESETS, type ChartState, type ChartStore, type IndicatorInstance, type MarkupSettings, type PresetId, type Timeframe } from "@platform/charts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button, EmptyState, Menu, SegmentedControl, Select, Tooltip, type MenuItemSpec } from "@/components/ui";
import { IconChevronDown, IconInfo, IconLayers } from "@/components/ui/icons";
import { getAccessToken } from "@/lib/auth-client";
import { formatPrice } from "@/lib/format";
import type { HeaderPrice } from "@/lib/liveSource";
import { INTRADAY, TF_LABEL, TIMEFRAMES } from "@/lib/timeframes";
import { getInstruments, type Instrument } from "@/lib/user";
import s from "./terminal.module.css";
import { ChartLoadError } from "./ChartLoadError";
import { ChartSurface } from "./chart/ChartSurface";
import { useChartStore } from "./chart/useChartStore";
import { presetNote, presetTitle } from "./MarkupPicker";
import { MARKUP_MENU_MAX } from "./chrome/MarkupMenu";
import { SymbolPicker } from "./chrome/TerminalHeader";
import { useLivePrice } from "./chrome/facts";
import { usePlan } from "./state/usePlan";
import { useTerminalData } from "./useTerminalData";
import { useT } from "@/i18n/client";
import { MQ } from "@/lib/breakpoints";

type Cell = { symbol: string; tf: Timeframe };
/** markup — один пресет разметки на все ячейки (по умолчанию «Компактный», план 2B.2 / M23). */
type Saved = { count: 2 | 4; cells: Cell[]; markup: PresetId };
const STORAGE = "pl-multichart";
const DEFAULT: Saved = {
  count: 2,
  cells: [
    { symbol: "BTCUSDT", tf: "4h" },
    { symbol: "ETHUSDT", tf: "4h" },
    { symbol: "SOLUSDT", tf: "1d" },
    { symbol: "BNBUSDT", tf: "1d" },
  ],
  markup: "compact",
};
/** Пресеты в «Разметке» мультичарта: «Компактный» (бюджет ячейки) и пять выбираемых. */
const CELL_PRESETS: readonly PresetId[] = ["compact", ...SELECTABLE_PRESETS.filter((id) => PRESETS[id].userSelectable)];
const DESKTOP = MQ.desktop;
const NO_INDICATORS: readonly IndicatorInstance[] = [];
const NO_PANELS: never[] = [];

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return DEFAULT;
    const v = JSON.parse(raw) as Partial<Saved>;
    const cells = Array.isArray(v.cells) ? v.cells.filter((c): c is Cell => typeof c?.symbol === "string" && (TIMEFRAMES as readonly string[]).includes(c?.tf)) : [];
    const markup = CELL_PRESETS.includes(v.markup as PresetId) ? (v.markup as PresetId) : DEFAULT.markup;
    return { count: v.count === 4 ? 4 : 2, cells: [...cells, ...DEFAULT.cells.slice(cells.length)].slice(0, 4), markup };
  } catch {
    return DEFAULT;
  }
}

const selectCross = (st: ChartState) => st.crosshair;

/** Цена ячейки (лист): под перекрестием — открытие и закрытие свечи, иначе последняя цена (живая — подписка ячейки сама). */
function CellPrice({ store, prices, fallback, tick, error }: { store: ChartStore; prices: HeaderPrice; fallback: number | null; tick: string | null; error: boolean }) {
  const t = useT();
  const cross = useChartStore(selectCross, store);
  const { price } = useLivePrice(prices, fallback, null);
  const text = cross ? `${t("Откр")} ${formatPrice(cross.candle.open, tick)} ${t("Закр")} ${formatPrice(cross.candle.close, tick)}` : price != null ? formatPrice(price, tick) : error ? t("нет данных") : "…";
  return <span className={`num ${s.multiPrice}`}>{text}</span>;
}

/**
 * Ячейка. Минутные ТФ — по тарифу, как в терминале (usePlan, аудит TSA-4): закрытые (гость, Free) — в списке
 * недоступны с пометкой «Pro», сохранённая минутная ячейка показывается на 4ч (сохранение не меняется — после входа
 * с Pro она снова минутная); отказ сервера (403) и другие сбои — объяснение вместо графика (ChartLoadError).
 */
function ChartCell({ cell, instruments, authed, intradayLocked, markup, onChange }: { cell: Cell; instruments: Instrument[]; authed: boolean; intradayLocked: boolean; markup: MarkupSettings; onChange: (c: Cell) => void }) {
  const t = useT();
  const data = useTerminalData(cell.symbol, cell.tf, authed ? getAccessToken() : null);
  const [store] = useState(createChartStore);
  const last = data.current ?? data.candles?.[data.candles.length - 1] ?? null;
  const lockedHint = intradayLocked ? (authed ? t("1м, 5м и 15м — с подпиской Pro.") : t("1м, 5м и 15м — после входа с подпиской Pro.")) : undefined;
  return (
    <section className={s.multiCell} aria-label={t("график {symbol} {tf}", { symbol: cell.symbol, tf: cell.tf })}>
      <div className={s.multiHead}>
        <SymbolPicker compact symbol={cell.symbol} instruments={instruments} onSymbol={(symbol) => onChange({ ...cell, symbol })} />
        <span className={s.multiTf}>
          <Select small aria-label={t("таймфрейм")} title={lockedHint} value={cell.tf} onChange={(e) => onChange({ ...cell, tf: e.target.value as Timeframe })}>
            {TIMEFRAMES.map((x) => {
              const locked = intradayLocked && INTRADAY.includes(x);
              return (
                <option key={x} value={x} disabled={locked}>
                  {locked ? t("{tf} · Pro", { tf: t(TF_LABEL[x]) }) : t(TF_LABEL[x])}
                </option>
              );
            })}
          </Select>
        </span>
        <CellPrice store={store} prices={data.prices} fallback={last?.close ?? null} tick={data.tick} error={!!data.error} />
        <Link href={`/chart/${cell.symbol}/${cell.tf}`} prefetch={false} className={s.multiOpen}>
          {t("открыть в терминале")}
        </Link>
      </div>
      <div className={s.multiChart}>
        {data.error ? (
          <ChartLoadError error={data.error} symbol={cell.symbol} tf={cell.tf} guest={!authed} retrying={data.retrying} onRetry={data.retry} home={false} />
        ) : (
          <ChartSurface store={store} device="cell" markup={markup} authed={authed} candles={data.candles ?? []} current={data.current} tf={cell.tf} type="candles" indicators={NO_INDICATORS} layers={data.layers} figures={data.figures?.items} alerts={NONE} derivatives={null} panels={NO_PANELS} tick={data.tick} dataKey={cell.symbol} onNeedOlder={data.loadOlder} live={data.live} />
        )}
      </div>
    </section>
  );
}

/** «Разметка» для всех ячеек сразу (замечание критика, M23): «Компактный» и выбираемые пресеты, бюджет — ячейки. */
function CellsMarkupMenu({ value, onSelect }: { value: PresetId; onSelect: (id: PresetId) => void }) {
  const t = useT();
  const name = presetTitle(value, t);
  const items: MenuItemSpec[] = [
    { type: "group", id: "head", label: t("Разметка всех графиков") },
    ...CELL_PRESETS.map((id): MenuItemSpec => ({ type: "radio", id, label: presetTitle(id, t), hint: presetNote(id, t), checked: value === id, onSelect: () => onSelect(id) })),
  ];
  return (
    <Menu
      items={items}
      minWidth={300}
      maxWidth={MARKUP_MENU_MAX}
      trigger={(p) => (
        <Button {...p} variant="ghost" size="sm" aria-label={t("Разметка: {name}", { name })} title={t("Разметка всех графиков")}>
          <IconLayers />
          {name}
          <IconChevronDown />
        </Button>
      )}
    />
  );
}

export function MultiChart() {
  const t = useT();
  const { user } = useAuth();
  const { intradayLocked } = usePlan();
  const [saved, setSaved] = useState<Saved | null>(null);
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const on = () => setDesktop(mq.matches);
    queueMicrotask(() => {
      on();
      setSaved(load());
    });
    mq.addEventListener("change", on);
    getInstruments()
      .then(setInstruments)
      .catch(() => {});
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (!saved) return;
    try {
      localStorage.setItem(STORAGE, JSON.stringify(saved));
    } catch {
      /* приватный режим */
    }
  }, [saved]);
  // минутная ячейка без тарифа — на 4ч (сохранение прежнее)
  const cells = useMemo(() => (saved ? saved.cells.slice(0, saved.count).map((c): Cell => (intradayLocked && INTRADAY.includes(c.tf) ? { ...c, tf: "4h" } : c)) : []), [saved, intradayLocked]);
  const preset = saved?.markup ?? DEFAULT.markup;
  const markup = useMemo<MarkupSettings>(() => ({ preset, overrides: {} }), [preset]);
  if (desktop === null || !saved) return null;
  if (!desktop) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState text={t("Мультичарт доступен на десктопе (ширина экрана от 900 px). На телефоне откройте терминал одного инструмента.")} action={<Link href="/chart/BTCUSDT/4h">{t("Открыть терминал")}</Link>} />
      </div>
    );
  }
  return (
    <div className={s.multi} data-count={saved.count}>
      <div className={s.multiBar}>
        <span className={s.multiLabel}>{t("Графиков:")}</span>
        <SegmentedControl
          mode="toggle"
          size="sm"
          label={t("число графиков")}
          value={String(saved.count) as "2" | "4"}
          items={[
            { value: "2", label: "2" },
            { value: "4", label: "4" },
          ]}
          onSelect={(v) => setSaved({ ...saved, count: v === "4" ? 4 : 2 })}
        />
        <CellsMarkupMenu value={saved.markup} onSelect={(id) => setSaved({ ...saved, markup: id })} />
        <Tooltip label={t("Пояснение")} text={t("Инструмент и таймфрейм у каждого графика свои; разметка — одна на все графики. Рисунки и индикаторы — в терминале.")}>
          <IconInfo />
        </Tooltip>
      </div>
      <div className={s.multiGrid} data-count={saved.count}>
        {cells.map((c, i) => (
          <ChartCell key={i} cell={c} instruments={instruments} authed={!!user} intradayLocked={intradayLocked} markup={markup} onChange={(next) => setSaved({ ...saved, cells: saved.cells.map((x, j) => (j === i ? next : x)) })} />
        ))}
      </div>
    </div>
  );
}
