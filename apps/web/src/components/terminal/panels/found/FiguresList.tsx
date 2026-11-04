"use client";

import { memo, useState } from "react";
import type { FigureOnChart, FigureStat } from "@/lib/chart";
import { useLocale } from "@/i18n/client";
import type { T } from "@/i18n";
import { formatPrice } from "@/lib/format";
import { visibleFigures } from "./counts";
import { formatBarTime } from "./dates";
import p from "../panels.module.css";

export function figureStatText(st: FigureStat | undefined, t: T): string {
  if (!st || st.low_n || !st.success_rate) return t("историческая отработка: мало данных");
  return t("историческая отработка {pct} % (n={n}, до цели за 20 свечей)", { pct: Math.round(Number(st.success_rate) * 100), n: st.n });
}

const FIGURE_STATUS: Record<FigureOnChart["status"], string> = { forming: "формируется", confirmed: "подтверждена", invalidated: "отменена" };

type Props = {
  items: readonly FigureOnChart[];
  stats: Record<string, FigureStat>;
  selected: number | null;
  onSelect: (f: FigureOnChart | null) => void;
  tick: string | null;
  visibleFrom: number | null;
};

/**
 * «Найдено → Фигуры» (план 2B.9 §8.1, 4B.6): не отменённые фигуры на видимом участке — столько же, сколько в счётчике
 * раздела. Строка в две строки без многоточия: имя и статус, ниже — качество и время пробоя. «Показать все» —
 * отменённые и за кадром; выбор фигуры за кадром прокручивает к ней график.
 */
export const FiguresList = memo(function FiguresList({ items, stats, selected, onSelect, tick, visibleFrom }: Props) {
  const { t, locale } = useLocale();
  const [showAll, setShowAll] = useState(false);
  const shown = visibleFigures(items, visibleFrom);
  const ids = new Set(shown.map((f) => f.id));
  const list = [...(showAll ? items : items.filter((f) => ids.has(f.id) || f.id === selected))].reverse().slice(0, 20);
  const rest = items.length - shown.length;
  const toggle = rest > 0 && (
    <button type="button" className={p.more} onClick={() => setShowAll(!showAll)}>
      {showAll ? t("Только на графике") : t("Показать все ({n})", { n: items.length })}
    </button>
  );
  if (list.length === 0)
    return (
      <>
        <p className={p.empty}>{t("Фигур на видимом участке нет. Фигуры ищутся на H4, D1 и W1 по закрытым свечам.")}</p>
        {toggle}
      </>
    );
  return (
    <>
      <ul className={p.items} aria-label={t("найденные фигуры")}>
        {list.map((f) => {
          const sel = f.id === selected;
          return (
            <li key={f.id} className={p.item} data-selected={sel || undefined}>
              <button type="button" className={p.itemBtn} aria-pressed={sel} onClick={() => onSelect(sel ? null : f)}>
                <span className={p.itemHead}>
                  <strong>{t(f.title)}</strong>
                  <span className={p.chip} data-status={f.status}>
                    {t(FIGURE_STATUS[f.status])}
                  </span>
                </span>
                <span className={p.meta}>
                  {t("качество")} {f.quality.toFixed(2)}
                  {f.confirm_t ? ` · ${t("пробой")} ${formatBarTime(f.confirm_t, locale)}` : ""}
                </span>
              </button>
              {sel && (
                <div className={p.details}>
                  <div>{f.status === "confirmed" ? t("подтверждена закрытием свечи за линией") : f.status === "forming" ? t("геометрия без подтверждения: цель и статистика не показываются") : t("отменена: цена закрылась против фигуры или вышло время")}</div>
                  {f.status === "confirmed" && f.target && (
                    <div>
                      {t("расчётная цель")} {formatPrice(f.target, tick)}
                      {f.invalidation ? `, ${t("инвалидация")} ${formatPrice(f.invalidation, tick)}` : ""}
                    </div>
                  )}
                  {f.status === "confirmed" && <div>{figureStatText(stats[f.type], t)}</div>}
                  <div className={p.note}>{t("не является сигналом или рекомендацией")}</div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {toggle}
    </>
  );
});
