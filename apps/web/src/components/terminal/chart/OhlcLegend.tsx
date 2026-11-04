"use client";

import { formatCompactValue, formatIndicatorValue, formatSignedPercent, indicatorById, instanceColors, instanceTitle, type ChartState, type ChartStore, type IndicatorInstance, type IndicatorValue } from "@platform/charts";
import { memo, useMemo } from "react";
import { IconButton, Popover, usePopover } from "@/components/ui";
import { IconClose } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { formatPrice } from "@/lib/format";
import { IndicatorParams } from "../sheets/IndicatorParams";
import { IND_COLOR_VAR } from "./ChartSurface";
import { LegendChip, LiqUnavailableNote } from "./LegendChip";
import { useChartStore } from "./useChartStore";
import c from "./chart.module.css";

type Props = {
  store: ChartStore;
  /** «BTCUSDT · 4ч · Binance». */
  symbol: string;
  tfLabel: string;
  exchange: string;
  tick: string | null;
  /** Экземпляры индикаторов: в легенде — наложения на графике цены (панели подписаны своими заголовками). */
  instances: readonly IndicatorInstance[];
  /** Слой карты ликвидаций включён: пометка «карты нет на этом таймфрейме» (B). */
  liqLayerOn: boolean;
  onHide: (uid: string) => void;
  onRemove: (uid: string) => void;
  onParams: (uid: string, params: Record<string, number>) => void;
};

const selectCross = (s: ChartState) => s.crosshair;
const selectValues = (s: ChartState) => s.values;

/**
 * Легенда графика в стиле TradingView (план 2B.9 §10, M17): в левом верхнем углу панели цены, без рамки и карточки.
 * Строка 1 — «BTCUSDT · 4ч · Binance», «?» (что на графике) и под перекрестием «Откр Макс Мин Закр изм. Объём».
 * Ниже — экземпляры индикаторов на графике: точка цвета, «EMA 50», значение под курсором или последнее; при наведении —
 * «скрыть», «настроить» (окно «Параметры EMA 50») и «убрать». Цены — formatPrice по шагу инструмента, как в шапке.
 * data-testid — «ohlc» под перекрестием (контракт e2e: только при активном перекрестии), иначе «legend».
 * Лист: читает перекрестие и значения из хранилища графика сам — TerminalShell при движении курсора не перерисовывается.
 */
export const OhlcLegend = memo(function OhlcLegend({ store, symbol, tfLabel, exchange, tick, instances, liqLayerOn, onHide, onRemove, onParams }: Props) {
  const t = useT();
  const cross = useChartStore(selectCross, store);
  const last = useChartStore(selectValues, store);
  const values = cross?.values ?? last;
  const colors = useMemo(() => instanceColors(instances), [instances]);
  const overlays = instances.filter((i) => indicatorById(i.id)?.pane === "overlay");
  const k = cross?.candle;
  const px = (v: number) => formatPrice(v, tick);
  const change = k && k.open ? ((k.close - k.open) / k.open) * 100 : null;
  return (
    <div className={c.legend} data-testid={cross ? "ohlc" : "legend"}>
      <div className={c.legendLine}>
        <span className={c.legendSymbol}>
          {symbol} · {tfLabel} · {exchange}
        </span>
        <LegendChip store={store} inline />
        {k && (
          <span className={c.legendOhlc}>
            <Fact label={t("Откр")} value={px(k.open)} />
            <Fact label={t("Макс")} value={px(k.high)} />
            <Fact label={t("Мин")} value={px(k.low)} />
            <Fact label={t("Закр")} value={px(k.close)} />
            {change !== null && <span className={`num ${change >= 0 ? "up" : "down"}`}>{formatSignedPercent(change)}</span>}
            <Fact label={t("Объём")} value={formatCompactValue(k.volume)} />
            {k.open_ && <span className={c.legendNote}>{t("свеча не закрыта")}</span>}
          </span>
        )}
      </div>
      <LiqUnavailableNote store={store} on={liqLayerOn} inline />
      {overlays.map((inst) => (
        <IndicatorRow key={inst.uid} inst={inst} color={`var(${IND_COLOR_VAR[colors.get(inst.uid) ?? "ind1"]})`} values={values} tick={tick} onHide={onHide} onRemove={onRemove} onParams={onParams} />
      ))}
    </div>
  );
});

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className={c.fact}>
      <span className={c.factLabel}>{label}</span> <span className="num">{value}</span>
    </span>
  );
}

function IndicatorRow({ inst, color, values, tick, onHide, onRemove, onParams }: { inst: IndicatorInstance; color: string; values: readonly IndicatorValue[]; tick: string | null; onHide: (uid: string) => void; onRemove: (uid: string) => void; onParams: (uid: string, params: Record<string, number>) => void }) {
  const t = useT();
  const pop = usePopover();
  const spec = indicatorById(inst.id);
  if (!spec) return null;
  const name = instanceTitle(spec, inst.params, t);
  const mine = values.filter((v) => v.uid === inst.uid);
  const fmt = (v: IndicatorValue) => (v.value == null ? "—" : v.price ? formatPrice(v.value, tick) : formatIndicatorValue(v.value));
  return (
    <div className={c.legendRow} data-hidden={inst.hidden || undefined}>
      <span className={c.legendDot} style={{ background: color }} aria-hidden="true" />
      <span className={c.legendName}>{name}</span>
      {!inst.hidden &&
        mine.map((v) => (
          <span key={v.key} className="num" style={{ color: v.color }}>
            {fmt(v)}
          </span>
        ))}
      <span className={c.legendActions} data-open={pop.open || undefined}>
        <IconButton size="xs" label={inst.hidden ? t("показать {name}", { name }) : t("скрыть {name}", { name })} pressed={inst.hidden === true} onClick={() => onHide(inst.uid)}>
          <EyeIcon off={inst.hidden === true} />
        </IconButton>
        {spec.params.length > 0 && (
          <IconButton size="xs" {...pop.triggerProps} label={t("настроить {name}", { name })}>
            <GearIcon />
          </IconButton>
        )}
        <IconButton size="xs" label={t("убрать {name}", { name })} onClick={() => onRemove(inst.uid)}>
          <IconClose />
        </IconButton>
      </span>
      <Popover open={pop.open} onClose={pop.close} anchor={pop.anchor} label={t("Параметры {name}", { name })} id={pop.id} width={240}>
        <div className={c.paramsPop}>
          <strong>{t("Параметры {name}", { name })}</strong>
          <IndicatorParams inst={inst} onChange={onParams} />
        </div>
      </Popover>
    </div>
  );
}

const EyeIcon = ({ off }: { off: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
    {off && <path d="M2.5 13.5 13.5 2.5" />}
  </svg>
);

const GearIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </svg>
);
