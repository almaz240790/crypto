"use client";

import type { Timeframe } from "@platform/charts";
import { usePathname } from "next/navigation";
import { memo, useMemo, useState } from "react";
import { Button, Popover, usePopover } from "@/components/ui";
import { IconChevronDown } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { formatPct, formatPrice } from "@/lib/format";
import { TF_LABEL } from "@/lib/timeframes";
import type { Instrument } from "@/lib/user";
import type { Trend } from "../state/useTrend";
import type { HeaderPrice, PriceSource } from "@/lib/liveSource";
import { Countdown, FundingChip, LiveDot, liveTitle, TrendSlot, useLivePrice } from "./facts";
import { overflowItem, useOverflow } from "./useOverflow";
import type { ShedStep } from "./fitByPriority";
import c from "./chrome.module.css";

/** Порядок скрытия фактов шапки, когда не хватает ширины (план 2B.9, §3.2): цена и связь — никогда. */
const HEADER_SHED: readonly ShedStep[] = [
  { id: "heikin", action: "hide" },
  { id: "funding", action: "hide" },
  { id: "atr", action: "hide" },
  { id: "trend", action: "hide" },
  { id: "change", action: "compact" },
];

/** Ширина «Сводки»: подпись «Закрытие последней свечи 4ч» и фандинг с отсчётом в одну строку. */
const SUMMARY_W = 400;

export type HeaderFacts = {
  /** Живая цена (ADR-0010): шапка подписана на неё сама — терминал на тиках не перерисовывается. */
  prices: HeaderPrice | null;
  /** Цена без живой — закрытие последней свечи (текущей, а без неё — закрытой). */
  fallback: number | null;
  /** Закрытие свечи перед текущей — основа изменения, %. */
  prevClose: number | null;
  tick: string | null;
  /** Закрытие последней закрытой свечи — то же число, что разделитель «Найдено → Уровни» (в «Сводке»). */
  lastClose: number | null;
  trend: Trend | null;
  atr: string | null;
  funding: { rate: string; next: number | null } | null;
  heikin: boolean;
  /** «Онлайн»: цена с биржи или тик сервера за последние 5 с (ADR-0010), а не просто открытый сокет. */
  online: boolean;
  /** Откуда цена: биржа напрямую или сервер (подсказка «онлайн»). */
  source: PriceSource;
  /** Время открытия последней свечи (отсчёт до закрытия в «Сводке»). */
  lastTime: number | null;
};

type Props = HeaderFacts & {
  symbol: string;
  tf: Timeframe;
  instruments: readonly Instrument[];
  onSymbol: (symbol: string) => void;
  guest: boolean;
};

/**
 * Инструмент: «BTCUSDT» 16/600 и тег биржи; поверх — прозрачный нативный select (выбор с клавиатуры,
 * поиск по буквам и selectOption в e2e). Не сжимается: имя всегда целиком. compact — шапка ячейки мультичарта:
 * 13/600, высота 28 (под пальцем 44), без тега биржи.
 */
export function SymbolPicker({ symbol, instruments, onSymbol, compact = false }: { symbol: string; instruments: readonly Instrument[]; onSymbol: (s: string) => void; compact?: boolean }) {
  const t = useT();
  // символа из адреса нет в списке (неизвестный или переименованный): он первым — значение выбора совпадает с
  // подписью, и выбор BTCUSDT — настоящая смена (аудит TSA-2)
  const list = instruments.some((i) => i.symbol === symbol) ? instruments : [{ symbol } as Instrument, ...instruments];
  return (
    <div className={c.symbol} data-overflow-item={compact ? undefined : "symbol"} data-compact={compact || undefined}>
      <span className={c.symbolName} aria-hidden="true">
        {symbol}
      </span>
      {!compact && (
        <span className={c.symbolTag} aria-hidden="true">
          Binance
        </span>
      )}
      <IconChevronDown />
      <select aria-label={t("инструмент")} value={symbol} onChange={(e) => onSymbol(e.target.value)}>
        {list.map((i) => (
          <option key={i.symbol} value={i.symbol}>
            {i.symbol}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Направление последнего тика: цвет цены (--up / --down), до первого изменения — нейтральный. */
function useTickDirection(price: number | null): "up" | "down" | undefined {
  const [prev, setPrev] = useState(price);
  const [dir, setDir] = useState<"up" | "down" | undefined>(undefined);
  if (price !== prev) {
    setPrev(price);
    if (price != null && prev != null && price !== prev) setDir(price > prev ? "up" : "down");
  }
  return dir;
}

/** «Сводка»: все факты шапки, в том числе спрятанные по ширине, и отсчёт до закрытия свечи. */
function Summary(p: Omit<HeaderFacts, "prices" | "fallback" | "prevClose"> & { tf: Timeframe; price: number | null; change: number | null }) {
  const t = useT();
  const tfLabel = t(TF_LABEL[p.tf]);
  return (
    <dl className={c.summary}>
      <dt>{t("Цена")}</dt>
      <dd className={c.num}>{formatPrice(p.price, p.tick)}</dd>
      <dt>{t("Закрытие последней свечи {tf}", { tf: tfLabel })}</dt>
      <dd className={c.num}>{formatPrice(p.lastClose, p.tick)}</dd>
      <dt>{t("Изменение за свечу {tf}", { tf: tfLabel })}</dt>
      <dd className={c.num} data-dir={p.change == null ? undefined : p.change >= 0 ? "up" : "down"}>
        {formatPct(p.change)}
      </dd>
      <dt>{t("До закрытия свечи")}</dt>
      <dd>
        <Countdown tf={p.tf} lastTime={p.lastTime} />
      </dd>
      {p.trend && (
        <>
          <dt>{t("Тренд")}</dt>
          <dd>
            <TrendSlot trend={p.trend} />
          </dd>
        </>
      )}
      {p.atr && (
        <>
          <dt>{t("Ход за свечу")}</dt>
          <dd className={c.num}>{formatPrice(p.atr, p.tick)}</dd>
        </>
      )}
      {p.funding && (
        <>
          <dt>{t("Фандинг")}</dt>
          <dd>
            <FundingChip rate={p.funding.rate} next={p.funding.next} label={false} />
          </dd>
        </>
      )}
      <dt>{t("Связь")}</dt>
      <dd title={liveTitle(t, p.online, p.source)}>{p.online ? t("онлайн") : t("без связи")}</dd>
      {p.heikin && <p className={c.summaryNote}>{t("Heikin Ashi: паттерны и сигналы считаются по обычным свечам")}</p>}
    </dl>
  );
}

/**
 * Шапка состояния десктопа, 44 px (план 2B.9, §3.2): инструмент, цена 20 px (моноширинный, tabular, цвет
 * по последнему тику), изменение с основой «за свечу 4ч», слот тренда, ход за свечу, фандинг, Heikin Ashi,
 * точка связи; гостю справа — «Войти». Факты прячутся по приоритету (useOverflow) и всегда есть в «Сводке»
 * (клик по цене). Отсчёт до закрытия — на ценовой шкале под ценой (PR B) и в «Сводке».
 */
export const TerminalHeader = memo(function TerminalHeader(p: Props) {
  const t = useT();
  const path = usePathname();
  const summary = usePopover();
  const { price, change } = useLivePrice(p.prices, p.fallback, p.prevClose);
  const dir = useTickDirection(price);
  const priceText = formatPrice(price, p.tick);
  const tfLabel = t(TF_LABEL[p.tf]);
  const changeText = formatPct(change);
  const fundingText = p.funding ? (Number(p.funding.rate) * 100).toFixed(4) : "";
  const key = [p.symbol, p.tf, priceText.length, changeText.length, p.trend ? `${p.trend.day}${p.trend.week}` : "-", p.atr ?? "-", fundingText, p.funding?.next != null, p.heikin].join("|");
  const { ref: rowRef, fit } = useOverflow<HTMLDivElement>(HEADER_SHED, key);
  const facts = useMemo(
    () => ({ price, tick: p.tick, change, lastClose: p.lastClose, trend: p.trend, atr: p.atr, funding: p.funding, heikin: p.heikin, online: p.online, source: p.source, lastTime: p.lastTime }),
    [price, p.tick, change, p.lastClose, p.trend, p.atr, p.funding, p.heikin, p.online, p.source, p.lastTime],
  );
  return (
    <header className={c.header} data-testid="terminal-header">
      <SymbolPicker symbol={p.symbol} instruments={p.instruments} onSymbol={p.onSymbol} />
      {/* «состояние»: e2e читают в группе sr-only «цена» и «онлайн» — не убирать */}
      <div ref={rowRef} className={c.state} role="group" aria-label={t("состояние")}>
        <button type="button" className={c.price} data-dir={dir} style={{ minWidth: `${priceText.length + 1}ch` }} {...summary.triggerProps} title={t("Сводка по инструменту")} {...overflowItem("price", fit)}>
          <span className="sr-only">{t("цена")} </span>
          {priceText}
        </button>
        <span className={c.fact} title={t("Изменение от закрытия последней свечи {tf}", { tf: tfLabel })} {...overflowItem("change", fit)}>
          <span className={c.num} data-dir={change == null ? undefined : change >= 0 ? "up" : "down"}>
            {changeText}
          </span>
          <span className={c.basis} data-ov-extra>
            {t("за свечу {tf}", { tf: tfLabel })}
          </span>
        </span>
        {p.trend && (
          <span {...overflowItem("trend", fit)}>
            <TrendSlot trend={p.trend} />
          </span>
        )}
        {p.atr && (
          <span className={c.fact} title={t("Средний размах одной свечи (ATR 14): насколько обычно ходит цена за свечу.")} {...overflowItem("atr", fit)}>
            {t("Ход за свечу")} <span className={c.num}>{formatPrice(p.atr, p.tick)}</span>
          </span>
        )}
        {p.funding && (
          <span {...overflowItem("funding", fit)}>
            <FundingChip rate={p.funding.rate} next={p.funding.next} />
          </span>
        )}
        {p.heikin && (
          <span className={c.chip} title={t("Паттерны и сигналы считаются по обычным свечам")} {...overflowItem("heikin", fit)}>
            Heikin Ashi
          </span>
        )}
        <span {...overflowItem("live", fit)}>
          <LiveDot on={p.online} source={p.source} />
        </span>
      </div>
      {p.guest && (
        <Button variant="primary" size="sm" href={`/login?next=${encodeURIComponent(path)}`}>
          {t("Войти")}
        </Button>
      )}
      <Popover open={summary.open} onClose={summary.close} anchor={summary.anchor} label={t("Сводка")} id={summary.id} width={SUMMARY_W}>
        <Summary {...facts} tf={p.tf} />
      </Popover>
    </header>
  );
});
