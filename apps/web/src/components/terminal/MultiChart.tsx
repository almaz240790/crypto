"use client";

/** Мультичарт (план 3.17, v2; только десктоп): 2 или 4 графика с независимыми инструментом и таймфреймом. */
import { createChartStore, NONE, PRESETS, SELECTABLE_PRESETS, type ChartState, type ChartStore, type IndicatorInstance, type MarkupSettings, type PresetId, type Timeframe } from "@platform/charts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button, EmptyState, Menu, SegmentedControl, Tooltip, type MenuItemSpec } from "@/components/ui";
import { IconChevronDown, IconInfo, IconLayers } from "@/components/ui/icons";
import { getAccessToken } from "@/lib/auth-client";
import { formatPrice } from "@/lib/format";
import { INTRADAY, TF_LABEL, TIMEFRAMES } from "@/lib/timeframes";
import { getInstruments, type Instrument } from "@/lib/user";
import s from "./terminal.module.css";
import { ChartSurface } from "./chart/ChartSurface";
import { useChartStore } from "./chart/useChartStore";
import { presetNote, presetTitle } from "./MarkupPicker";
import { MARKUP_MENU_MAX } from "./chrome/MarkupMenu";
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

/** Цена ячейки (лист): под перекрестием — открытие и закрытие свечи, иначе последняя цена. */
function CellPrice({ store, price, tick, error }: { store: ChartStore; price: number | null; tick: string | null; error: boolean }) {
  const t = useT();
  const cross = useChartStore(selectCross, store);
  const text = cross ? `O ${formatPrice(cross.candle.open, tick)} C ${formatPrice(cross.candle.close, tick)}` : price != null ? formatPrice(price, tick) : error ? t("нет данных") : "…";
  return <span className={`num ${s.multiPrice}`}>{text}</span>;
}

function ChartCell({ cell, instruments, authed, markup, onChange }: { cell: Cell; instruments: Instrument[]; authed: boolean; markup: MarkupSettings; onChange: (c: Cell) => void }) {
  const t = useT();
  const data = useTerminalData(cell.symbol, cell.tf, authed ? getAccessToken() : null);
  const [store] = useState(createChartStore);
  const last = data.current ?? data.candles?.[data.candles.length - 1] ?? null;
  const price = data.price ? Number(data.price) : last?.close ?? null;
  const tfs = TIMEFRAMES.filter((x) => authed || !INTRADAY.includes(x));
  return (
    <section className={s.multiCell} aria-label={t("график {symbol} {tf}", { symbol: cell.symbol, tf: cell.tf })}>
      <div className={s.multiHead}>
        <select className={s.multiSymbol} aria-label={t("инструмент")} value={cell.symbol} onChange={(e) => onChange({ ...cell, symbol: e.target.value })}>
          {(instruments.length ? instruments : [{ symbol: cell.symbol } as Instrument]).map((i) => (
            <option key={i.symbol} value={i.symbol}>
              {i.symbol}
            </option>
          ))}
        </select>
        <select className={s.multiTf} aria-label={t("таймфрейм")} value={cell.tf} onChange={(e) => onChange({ ...cell, tf: e.target.value as Timeframe })}>
          {tfs.map((x) => (
            <option key={x} value={x}>
              {t(TF_LABEL[x])}
            </option>
          ))}
        </select>
        <CellPrice store={store} price={price} tick={data.tick} error={!!data.error} />
        <Link href={`/chart/${cell.symbol}/${cell.tf}`} prefetch={false} className={s.multiOpen}>
          {t("открыть в терминале")}
        </Link>
      </div>
      <div className={s.multiChart}>
        <ChartSurface store={store} device="cell" markup={markup} authed={authed} candles={data.candles ?? []} current={data.current} tf={cell.tf} type="candles" indicators={NO_INDICATORS} layers={data.layers} figures={data.figures?.items} alerts={NONE} derivatives={null} panels={NO_PANELS} tick={data.tick} dataKey={cell.symbol} onNeedOlder={data.loadOlder} />
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
  const cells = useMemo(() => (saved ? saved.cells.slice(0, saved.count) : []), [saved]);
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
          <ChartCell key={i} cell={c} instruments={instruments} authed={!!user} markup={markup} onChange={(next) => setSaved({ ...saved, cells: saved.cells.map((x, j) => (j === i ? next : x)) })} />
        ))}
      </div>
    </div>
  );
}
