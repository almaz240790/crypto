"use client";

import Link from "next/link";
import { memo, useState } from "react";
import { Button } from "@/components/ui";
import { explainPattern, type Explanation, type PatternOnChart, type PatternStat } from "@/lib/chart";
import { useLocale } from "@/i18n/client";
import type { T } from "@/i18n";
import { TF_LABEL, type Timeframe } from "@/lib/timeframes";
import { visiblePatterns } from "./counts";
import { formatBarTime } from "./dates";
import p from "../panels.module.css";

/** Свечные паттерны (план 3.17, 2A.10): тексты — только разрешённые формулировки 2A.10.6. */
export function statText(st: PatternStat | undefined, t: T): string {
  if (!st || st.low_n || !st.success_rate) return t("историческая отработка: мало данных");
  const pct = Math.round(Number(st.success_rate) * 100);
  return t("историческая отработка {pct} % (n={n}, {h} свечей)", { pct, n: st.n, h: st.horizon });
}

export function contextFacts(pt: PatternOnChart, t: T): string[] {
  const c = pt.context;
  const out: string[] = [];
  const run = Number(c.prior_run ?? 0);
  if (run <= -3) out.push(t("после {n} свечей снижения", { n: -run }));
  if (run >= 3) out.push(t("после {n} свечей роста", { n: run }));
  if (c.sweep) out.push(t("снята ликвидность (sweep)"));
  if (c.pierced) out.push(t("хвост проткнул уровень и закрылся обратно"));
  const zd = c.zone_distance_atr == null ? null : Number(c.zone_distance_atr);
  if (zd !== null && zd <= 0.5) out.push(zd === 0 ? t("внутри зоны") : t("у зоны ({d} ATR)", { d: zd.toFixed(2) }));
  const vr = c.volume_ratio == null ? null : Number(c.volume_ratio);
  if (vr !== null && vr >= 1.2) out.push(t("объём ×{x} к среднему", { x: vr.toFixed(1) }));
  if (c.overheat) out.push(t("перегрев: ход > 3 ATR"));
  if (c.trend) out.push(`${t("структура TF")}: ${c.trend === "up" ? t("вверх") : c.trend === "down" ? t("вниз") : t("флэт")}`);
  if (c.htf_trend) out.push(`${t("старший TF")}: ${c.htf_trend === "up" ? t("вверх") : c.htf_trend === "down" ? t("вниз") : t("флэт")}`);
  if (c.above_ema === true) out.push(t("выше EMA50"));
  if (c.above_ema === false) out.push(t("ниже EMA50"));
  return out;
}

type Props = {
  items: readonly PatternOnChart[];
  stats: Record<string, PatternStat>;
  selected: number | null;
  onSelect: (pt: PatternOnChart | null) => void;
  tf: Timeframe;
  symbol: string;
  canExplain: boolean;
  visibleFrom: number | null;
};

/**
 * «Найдено → Паттерны» (план 2B.9 §8.1): значимые паттерны на видимом участке — столько же, сколько в счётчике.
 * Строка в две строки без многоточия; подробности — контекст, отработка, «Объяснить» (2B.15). «Показать все» —
 * незначимые и за кадром; выбор паттерна за кадром прокручивает к нему график.
 */
export const PatternsList = memo(function PatternsList({ items, stats, selected, onSelect, tf, symbol, canExplain, visibleFrom }: Props) {
  const { t, locale } = useLocale();
  const [showAll, setShowAll] = useState(false);
  const [explained, setExplained] = useState<Record<number, Explanation | "loading" | { error: string }>>({});
  const explain = (id: number) => {
    setExplained((x) => ({ ...x, [id]: "loading" }));
    explainPattern(symbol, tf, id)
      .then((r) => setExplained((x) => ({ ...x, [id]: r })))
      .catch((e: Error) => setExplained((x) => ({ ...x, [id]: { error: e.message } })));
  };
  const shown = visiblePatterns(items, visibleFrom);
  const ids = new Set(shown.map((x) => x.id));
  const list = [...(showAll ? items : items.filter((x) => ids.has(x.id) || x.id === selected))].reverse().slice(0, 40);
  const rest = items.length - shown.length;
  const toggle = rest > 0 && (
    <button type="button" className={p.more} onClick={() => setShowAll(!showAll)}>
      {showAll ? t("Только значимые на графике") : t("Показать все ({n})", { n: items.length })}
    </button>
  );
  if (list.length === 0)
    return (
      <>
        <p className={p.empty}>{items.length ? t("Значимых паттернов на видимом участке нет.") : t("На видимом участке паттернов не найдено. Отметки появляются после закрытия свечи {tf}.", { tf: t(TF_LABEL[tf]) })}</p>
        {toggle}
      </>
    );
  return (
    <>
      <ul className={p.items} aria-label={t("найденные паттерны")}>
        {list.map((pt) => {
          const sel = pt.id === selected;
          const ex = explained[pt.id];
          return (
            <li key={pt.id} className={p.item} data-selected={sel || undefined}>
              <button type="button" className={p.itemBtn} aria-pressed={sel} onClick={() => onSelect(sel ? null : pt)}>
                <span className={p.itemHead}>
                  <strong>{t(pt.title)}</strong>
                  <span className={p.chip} data-status={pt.significant ? "significant" : "found"}>
                    {pt.significant ? t("значимый") : t("найден")}
                  </span>
                </span>
                <span className={p.meta}>{formatBarTime(pt.t, locale)}</span>
              </button>
              {sel && (
                <div className={p.details}>
                  <div>{t("подтверждено на закрытии свечи")}</div>
                  {contextFacts(pt, t).map((f) => (
                    <div key={f}>{f}</div>
                  ))}
                  <div>
                    {statText(stats[pt.type], t)} <Link href={`/stats/patterns?tf=${pt.tf}&type=${pt.type}`}>{t("подробнее")}</Link>
                  </div>
                  <div className={p.note}>{t("не является сигналом или рекомендацией")}</div>
                  {canExplain && (
                    <div className={p.explain}>
                      {ex === undefined && (
                        <Button size="sm" onClick={() => explain(pt.id)}>
                          {t("Объяснить")}
                        </Button>
                      )}
                      {ex === "loading" && <span className={p.note}>{t("составляю текст по данным графика…")}</span>}
                      {typeof ex === "object" && "error" in ex && <span className={p.note}>{ex.error}</span>}
                      {typeof ex === "object" && "text" in ex && (
                        <div data-testid="explanation">
                          <p>{ex.text}</p>
                          <p className={p.note}>
                            {ex.footer}
                            {ex.source === "template" ? t(" Шаблонный текст из фактов.") : t(" Текст модели прошёл проверку: все числа — из данных графика.")}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
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
