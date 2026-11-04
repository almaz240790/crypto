"use client";

import { formatSignedPercent, formatUsd, type LevelRow, type SceneIndex } from "@platform/charts";
import { memo, type ReactNode } from "react";
import { Tooltip } from "@/components/ui";
import { IconInfo } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { formatPrice } from "@/lib/format";
import { TF_LABEL, type Timeframe } from "@/lib/timeframes";
import { zoneName } from "@/lib/zones";
import { isLiqRow } from "./counts";
import p from "../panels.module.css";

/** Слово типа уровня (ключ перевода) и тон полосы слева. */
const WORD: Record<LevelRow["kind"], string> = {
  resistance: "Сопротивление",
  support: "Поддержка",
  demand: "Спрос",
  supply: "Предложение",
  zone: "Зона",
  pdh: "Макс. дня",
  pdl: "Мин. дня",
  pwh: "Макс. недели",
  pwl: "Мин. недели",
  "liq-short": "Ликвидации шортов",
  "liq-long": "Ликвидации лонгов",
};
const TONE: Partial<Record<LevelRow["kind"], "up" | "down" | "liq">> = { support: "up", demand: "up", resistance: "down", supply: "down", "liq-short": "liq", "liq-long": "liq" };

type Props = {
  index: SceneIndex | null;
  tick: string | null;
  /**
   * Закрытие последней закрытой свечи: разделитель «Закрытие последней свечи 4ч» между уровнями выше и ниже. Уровни и
   * расстояния считаются по закрытым свечам, поэтому разделитель — не «текущая цена» (она в шапке и на шкале и идёт
   * тиками); изменение в шапке «за свечу 4ч» считается от этого же закрытия, и «Сводка» показывает его рядом с ценой.
   */
  lastClose: number | null;
  tf: Timeframe;
  selected: string | null;
  onPick: (id: string | null) => void;
};

/**
 * «Найдено → Уровни» (план 2B.9 §8.1, 2A.4): каталог сцены — независимо от слоёв (на графике подписи может отрезать
 * пресет или бюджет, здесь видны все). Таблица с выровненными колонками: тип (полоса тона и слово) | цена |
 * расстояние от цены | подробности (касания, источники зоны словами). Между уровнями выше и ниже — «Закрытие последней
 * свечи 4ч» (не меняется на тиках: панель не перерисовывается).
 * Цены — formatPrice по шагу инструмента (класс num — только у цен, контракт e2e), расстояние — класс pct.
 * Ликвидации — последней строкой, свёрнутой группой «Ликвидации (оценка)» с пояснением в подсказке.
 */
export const LevelsTable = memo(function LevelsTable({ index, tick, lastClose, tf, selected, onPick }: Props) {
  const t = useT();
  const tfLabel = t(TF_LABEL[tf]);
  const px = (v: number) => formatPrice(v, tick);
  const rows = index?.levels ?? [];
  const main = rows.filter((r) => !isLiqRow(r.kind));
  const liq = rows.filter((r) => isLiqRow(r.kind));
  const above = main.filter((r) => r.distancePct > 0);
  const below = main.filter((r) => r.distancePct <= 0);
  const liqTitle = t("Карта ликвидаций — расчётная оценка: суммы позиций с плечом 10–100×, которые могли бы закрыться принудительно при подходе цены. Считается по приросту открытого интереса, а не по данным биржи.");

  const detail = (r: LevelRow): ReactNode => {
    if (r.kind === "support" || r.kind === "resistance") return t("касаний: {n}", { n: r.touches ?? 0 });
    if (r.kind === "demand" || r.kind === "supply" || r.kind === "zone") return zoneNames(r).map((n) => t(n)).join(" + ");
    if (isLiqRow(r.kind)) return <span className={p.amount}>≈ {formatUsd(r.amountUsd ?? 0)}</span>;
    return null;
  };
  const row = (r: LevelRow) => {
    const sel = r.id === selected;
    const zone = r.priceTo !== undefined && r.priceTo !== r.price;
    const hi = zone ? Math.max(r.price, r.priceTo!) : r.price;
    const lo = zone ? Math.min(r.price, r.priceTo!) : r.price;
    const dist = zone && r.distancePct === 0 ? t("в зоне") : formatSignedPercent(r.distancePct, 1);
    const more = detail(r);
    const title = r.cluster ? `${t("сумма по {n} соседним ценам", { n: r.cluster.n })}: ${px(r.cluster.lo)}–${px(r.cluster.hi)}` : undefined;
    return (
      <li key={r.id} data-selected={sel || undefined} title={title}>
        <button type="button" className={p.level} data-tone={TONE[r.kind]} data-off={!r.onChart || undefined} aria-pressed={sel} onClick={() => onPick(sel ? null : r.id)}>
          <span className={p.levelWord}>{t(WORD[r.kind])}</span>
          <span className={p.levelPrice}>
            <span className="num">{px(hi)}</span>
            {zone && <span className="num">{px(lo)}</span>}
          </span>
          <span className={p.pct}>{dist}</span>
          <span className={p.levelDetail}>
            {more}
            {!r.onChart && (
              <span className={p.offChart} data-sep={more ? "" : undefined}>
                {t("не на графике")}
              </span>
            )}
          </span>
        </button>
      </li>
    );
  };

  if (main.length === 0 && liq.length === 0) {
    return index?.liqUnavailable ? <LiqUnavailable /> : <p className={p.empty}>{t("Уровней и зон рядом с ценой нет.")}</p>;
  }
  return (
    <>
      <ul className={p.levels} aria-label={t("уровни поддержки и сопротивления")}>
        {above.map(row)}
        {lastClose !== null && (
          <li className={p.divider} title={t("Расстояния до уровней — от закрытия последней свечи {tf}; текущая цена — в шапке и на шкале", { tf: tfLabel })}>
            <span>{t("Закрытие последней свечи {tf}", { tf: tfLabel })}</span> <span className="num">{px(lastClose)}</span>
          </li>
        )}
        {below.map(row)}
        {liq.length > 0 && (
          <li className={p.liqGroup}>
            <details>
              <summary>
                <span>
                  {t("Ликвидации (оценка)")} · {liq.length}
                </span>
                <Tooltip label={t("Пояснение")} text={liqTitle}>
                  <IconInfo />
                </Tooltip>
              </summary>
              <ul className={p.levels} aria-label={t("ликвидации (оценка)")}>
                {liq.map(row)}
              </ul>
            </details>
          </li>
        )}
      </ul>
      {liq.length === 0 && index?.liqUnavailable && <LiqUnavailable />}
    </>
  );
});

function LiqUnavailable() {
  const t = useT();
  return (
    <p className={p.note} data-testid="liq-unavailable">
      {t("Карта ликвидаций на этом таймфрейме недоступна: мало данных открытого интереса.")}
    </p>
  );
}

/** Названия исходных зон словами (ключи перевода), в порядке ob → sd → fvg. */
function zoneNames(z: LevelRow): string[] {
  const out: string[] = [];
  for (const part of z.parts ?? (z.kinds ?? []).map((kind) => ({ kind, dir: z.kind === "supply" ? ("down" as const) : ("up" as const) }))) {
    const n = zoneName(part.kind, part.dir);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}
