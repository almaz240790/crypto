"use client";

import Link from "next/link";
import { useState } from "react";
import { askChart, explainPattern, type Explanation, type FigureOnChart, type FigureStat, type PatternOnChart, type PatternStat } from "@/lib/chart";
import { formatPrice } from "@/lib/format";
import type { Timeframe } from "@/lib/timeframes";
import s from "./terminal.module.css";
import { useT } from "@/i18n/client";
import type { T } from "@/i18n";

/** Панель «Найдено на графике» (план 3.17, 2A.10): свечные паттерны с контекстом и исторической
 * отработкой. Тексты — только разрешённые формулировки 2A.10.6. */

export function statText(st: PatternStat | undefined, t: T): string {
  if (!st || st.low_n || !st.success_rate) return t("историческая отработка: мало данных");
  const pct = Math.round(Number(st.success_rate) * 100);
  return t("историческая отработка {pct} % (n={n}, {h} свечей)", { pct, n: st.n, h: st.horizon });
}

export function contextFacts(p: PatternOnChart, t: T): string[] {
  const c = p.context;
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

export function FoundList({ items, stats, selected, onSelect, tf, symbol, canExplain = false }: { items: PatternOnChart[]; stats: Record<string, PatternStat>; selected: number | null; onSelect: (id: number | null) => void; tf: string; symbol?: string; canExplain?: boolean }) {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const [explained, setExplained] = useState<Record<number, Explanation | "loading" | { error: string }>>({});
  const explain = (id: number) => {
    if (!symbol) return;
    setExplained((p) => ({ ...p, [id]: "loading" }));
    explainPattern(symbol, tf as Timeframe, id)
      .then((r) => setExplained((p) => ({ ...p, [id]: r })))
      .catch((e: Error) => setExplained((p) => ({ ...p, [id]: { error: e.message } })));
  };
  // по умолчанию — только значимые (с контекстом из правил); остальные по кнопке
  const significant = items.filter((p) => p.significant || p.id === selected);
  const list = [...(showAll ? items : significant)].reverse().slice(0, 40);
  const more = items.length - significant.length;
  const toggle = more > 0 && (
    <button type="button" className={s.linkBtn} onClick={() => setShowAll(!showAll)}>
      {showAll ? t("Только значимые") : t("Показать все ({n})", { n: items.length })}
    </button>
  );
  if (list.length === 0)
    return (
      <>
        <p className="caption">{items.length ? t("Значимых паттернов на видимом участке нет.") : t("На видимом участке паттернов не найдено. Отметки появляются после закрытия свечи {tf}.", { tf: tf.toUpperCase() })}</p>
        {toggle}
      </>
    );
  return (
    <>
    <ul className={s.objList} aria-label={t("найденные паттерны")}>
      {list.map((p) => {
        const sel = p.id === selected;
        return (
          <li key={p.id} className={s.found} data-selected={sel || undefined}>
            <button type="button" className={s.objName} aria-pressed={sel} onClick={() => onSelect(sel ? null : p.id)}>
              <strong>{p.title}</strong>{" "}
              <span className="caption">
                {new Date(p.t * 1000).toLocaleString("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} UTC · {p.significant ? t("значимый") : t("найден")}
              </span>
            </button>
            {sel && (
              <div className={s.foundDetails}>
                <div>{t("подтверждено на закрытии свечи")}</div>
                {contextFacts(p, t).map((f) => (
                  <div key={f}>{f}</div>
                ))}
                <div>
                  {statText(stats[p.type], t)}{" "}
                  <Link href={`/stats/patterns?tf=${p.tf}&type=${p.type}`}>{t("подробнее")}</Link>
                </div>
                <div className="caption">{t("не является сигналом или рекомендацией")}</div>
                {canExplain && symbol && (
                  <div className={s.explain}>
                    {explained[p.id] === undefined && (
                      <button type="button" className={s.chip} onClick={() => explain(p.id)}>{t("Объяснить")}</button>
                    )}
                    {explained[p.id] === "loading" && <span className="caption">{t("составляю текст по данным графика…")}</span>}
                    {typeof explained[p.id] === "object" && "error" in (explained[p.id] as object) && <span className="caption">{(explained[p.id] as { error: string }).error}</span>}
                    {typeof explained[p.id] === "object" && "text" in (explained[p.id] as object) && (
                      <div data-testid="explanation">
                        <p>{(explained[p.id] as Explanation).text}</p>
                        <p className="caption">
                          {(explained[p.id] as Explanation).footer}
                          {(explained[p.id] as Explanation).source === "template" ? t(" Шаблонный текст из фактов.") : t(" Текст модели прошёл проверку: все числа — из данных графика.")}
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
}


export function figureStatText(st: FigureStat | undefined, t: T): string {
  if (!st || st.low_n || !st.success_rate) return t("историческая отработка: мало данных");
  return t("историческая отработка {pct} % (n={n}, до цели за 20 свечей)", { pct: Math.round(Number(st.success_rate) * 100), n: st.n });
}

const FIGURE_STATUS: Record<FigureOnChart["status"], string> = { forming: "формируется", confirmed: "подтверждена", invalidated: "отменена" };

/** Список фигур в панели «Найдено» (4B.6): статус, качество геометрии, цель, отработка типа. */
export function FiguresList({ items, stats, selected, onSelect }: { items: FigureOnChart[]; stats: Record<string, FigureStat>; selected: number | null; onSelect: (id: number | null) => void }) {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const live = items.filter((f) => f.status !== "invalidated" || f.id === selected);
  const list = [...(showAll ? items : live)].reverse().slice(0, 20);
  const hidden = items.length - live.length;
  const toggle = hidden > 0 && (
    <button type="button" className={s.linkBtn} onClick={() => setShowAll(!showAll)}>
      {showAll ? t("Скрыть отменённые") : t("Показать отменённые ({n})", { n: hidden })}
    </button>
  );
  if (list.length === 0)
    return (
      <>
        <p className="caption">{t("Фигур на видимом участке нет. Фигуры ищутся на H4, D1 и W1 по закрытым свечам.")}</p>
        {toggle}
      </>
    );
  return (
    <>
    <ul className={s.objList} aria-label={t("найденные фигуры")}>
      {list.map((f) => {
        const sel = f.id === selected;
        return (
          <li key={f.id} className={s.found} data-selected={sel || undefined}>
            <button type="button" className={s.objName} aria-pressed={sel} onClick={() => onSelect(sel ? null : f.id)}>
              <strong>{f.title}</strong>{" "}
              <span className="caption">
                {t(FIGURE_STATUS[f.status])} · {t("качество")} {f.quality.toFixed(2)}
                {f.confirm_t ? ` · ${t("пробой")} ${new Date(f.confirm_t * 1000).toLocaleString("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} UTC` : ""}
              </span>
            </button>
            {sel && (
              <div className={s.foundDetails}>
                <div>{f.status === "confirmed" ? t("подтверждена закрытием свечи за линией") : f.status === "forming" ? t("геометрия без подтверждения: цель и статистика не показываются") : t("отменена: цена закрылась против фигуры или вышло время")}</div>
                {f.status === "confirmed" && f.target && <div>{t("расчётная цель")} {formatPrice(f.target)}{f.invalidation ? `, ${t("инвалидация")} ${formatPrice(f.invalidation)}` : ""}</div>}
                {f.status === "confirmed" && <div>{figureStatText(stats[f.type], t)}</div>}
                <div className="caption">{t("не является сигналом или рекомендацией")}</div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
    {toggle}
    </>
  );
}


/** Поле вопроса о графике (план 3.17, 4B.7): Premium; остальным — пояснение из ответа сервера. */
export function AskBox({ symbol, tf }: { symbol: string; tf: string }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [state, setState] = useState<Explanation | "loading" | { error: string } | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = q.trim().slice(0, 500);
    if (!text) return;
    setState("loading");
    askChart(symbol, tf as Timeframe, text)
      .then((r) => setState(r))
      .catch((err: Error) => setState({ error: err.message }));
  };
  return (
    <form className={s.ask} onSubmit={submit} aria-label={t("вопрос о графике")}>
      <label>{t("Вопрос о графике")}<textarea aria-label={t("текст вопроса")} maxLength={500} rows={2} placeholder={t("например: почему зона считается активной?")} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className={s.askRow}>
        <span className="caption">{q.length}/500 · только по фактам графика, без рекомендаций и прогнозов</span>
        <button type="submit" className={s.chip} disabled={state === "loading" || !q.trim()}>{t("Спросить")}</button>
      </div>
      {state === "loading" && <p className="caption">{t("составляю ответ по данным графика…")}</p>}
      {state !== null && typeof state === "object" && "error" in state && <p className="caption">{state.error}</p>}
      {state !== null && typeof state === "object" && "text" in state && (
        <div data-testid="ask-answer">
          <p>{state.text}</p>
          <p className="caption">
            {state.footer}
            {state.source === "template" ? "" : t(" Ответ прошёл проверку: все числа — из данных графика.")}
          </p>
        </div>
      )}
    </form>
  );
}
