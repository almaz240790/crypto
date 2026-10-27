"use client";

import Link from "next/link";
import { useState } from "react";
import { askChart, explainPattern, type Explanation, type FigureOnChart, type FigureStat, type PatternOnChart, type PatternStat } from "@/lib/chart";
import type { Timeframe } from "@/lib/timeframes";
import s from "./terminal.module.css";

/** Панель «Найдено на графике» (план 3.17, 2A.10): свечные паттерны с контекстом и исторической
 * отработкой. Тексты — только разрешённые формулировки 2A.10.6. */

export function statText(st: PatternStat | undefined): string {
  if (!st || st.low_n || !st.success_rate) return "историческая отработка: мало данных";
  const pct = Math.round(Number(st.success_rate) * 100);
  return `историческая отработка ${pct} % (n=${st.n}, ${st.horizon} свечей)`;
}

export function contextFacts(p: PatternOnChart): string[] {
  const c = p.context;
  const out: string[] = [];
  const run = Number(c.prior_run ?? 0);
  if (run <= -3) out.push(`после ${-run} свечей снижения`);
  if (run >= 3) out.push(`после ${run} свечей роста`);
  if (c.sweep) out.push("снята ликвидность (sweep)");
  if (c.pierced) out.push("хвост проткнул уровень и закрылся обратно");
  const zd = c.zone_distance_atr == null ? null : Number(c.zone_distance_atr);
  if (zd !== null && zd <= 0.5) out.push(zd === 0 ? "внутри зоны" : `у зоны (${zd.toFixed(2)} ATR)`);
  const vr = c.volume_ratio == null ? null : Number(c.volume_ratio);
  if (vr !== null && vr >= 1.2) out.push(`объём ×${vr.toFixed(1)} к среднему`);
  if (c.overheat) out.push("перегрев: ход > 3 ATR");
  if (c.trend) out.push(`структура TF: ${c.trend === "up" ? "вверх" : c.trend === "down" ? "вниз" : "флэт"}`);
  if (c.htf_trend) out.push(`старший TF: ${c.htf_trend === "up" ? "вверх" : c.htf_trend === "down" ? "вниз" : "флэт"}`);
  if (c.above_ema === true) out.push("выше EMA50");
  if (c.above_ema === false) out.push("ниже EMA50");
  return out;
}

export function FoundList({ items, stats, selected, onSelect, tf, symbol, canExplain = false }: { items: PatternOnChart[]; stats: Record<string, PatternStat>; selected: number | null; onSelect: (id: number | null) => void; tf: string; symbol?: string; canExplain?: boolean }) {
  const [explained, setExplained] = useState<Record<number, Explanation | "loading" | { error: string }>>({});
  const explain = (id: number) => {
    if (!symbol) return;
    setExplained((p) => ({ ...p, [id]: "loading" }));
    explainPattern(symbol, tf as Timeframe, id)
      .then((r) => setExplained((p) => ({ ...p, [id]: r })))
      .catch((e: Error) => setExplained((p) => ({ ...p, [id]: { error: e.message } })));
  };
  const list = [...items].reverse().slice(0, 40);
  if (list.length === 0) return <p className="caption">На видимом участке паттернов не найдено. Отметки появляются после закрытия свечи {tf.toUpperCase()}.</p>;
  return (
    <ul className={s.objList} aria-label="найденные паттерны">
      {list.map((p) => {
        const sel = p.id === selected;
        return (
          <li key={p.id} className={s.found} data-selected={sel || undefined}>
            <button type="button" className={s.objName} aria-pressed={sel} onClick={() => onSelect(sel ? null : p.id)}>
              <strong>{p.title}</strong>{" "}
              <span className="caption">
                {new Date(p.t * 1000).toLocaleString("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} UTC · {p.significant ? "значимый" : "найден"}
              </span>
            </button>
            {sel && (
              <div className={s.foundDetails}>
                <div>подтверждено на закрытии свечи</div>
                {contextFacts(p).map((f) => (
                  <div key={f}>{f}</div>
                ))}
                <div>
                  {statText(stats[p.type])}{" "}
                  <Link href={`/stats/patterns?tf=${p.tf}&type=${p.type}`}>подробнее</Link>
                </div>
                <div className="caption">не является сигналом или рекомендацией</div>
                {canExplain && symbol && (
                  <div className={s.explain}>
                    {explained[p.id] === undefined && (
                      <button type="button" className={s.chip} onClick={() => explain(p.id)}>
                        Объяснить
                      </button>
                    )}
                    {explained[p.id] === "loading" && <span className="caption">составляю текст по данным графика…</span>}
                    {typeof explained[p.id] === "object" && "error" in (explained[p.id] as object) && <span className="caption">{(explained[p.id] as { error: string }).error}</span>}
                    {typeof explained[p.id] === "object" && "text" in (explained[p.id] as object) && (
                      <div data-testid="explanation">
                        <p>{(explained[p.id] as Explanation).text}</p>
                        <p className="caption">
                          {(explained[p.id] as Explanation).footer}
                          {(explained[p.id] as Explanation).source === "template" ? " Шаблонный текст из фактов." : " Текст модели прошёл проверку: все числа — из данных графика."}
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
  );
}


export function figureStatText(st: FigureStat | undefined): string {
  if (!st || st.low_n || !st.success_rate) return "историческая отработка: мало данных";
  return `историческая отработка ${Math.round(Number(st.success_rate) * 100)} % (n=${st.n}, до цели за 20 свечей)`;
}

const FIGURE_STATUS: Record<FigureOnChart["status"], string> = { forming: "формируется", confirmed: "подтверждена", invalidated: "отменена" };

/** Список фигур в панели «Найдено» (4B.6): статус, качество геометрии, цель, отработка типа. */
export function FiguresList({ items, stats, selected, onSelect }: { items: FigureOnChart[]; stats: Record<string, FigureStat>; selected: number | null; onSelect: (id: number | null) => void }) {
  const list = [...items].reverse().slice(0, 20);
  if (list.length === 0) return <p className="caption">Фигур на видимом участке нет. Фигуры ищутся на H4, D1 и W1 по закрытым свечам.</p>;
  return (
    <ul className={s.objList} aria-label="найденные фигуры">
      {list.map((f) => {
        const sel = f.id === selected;
        return (
          <li key={f.id} className={s.found} data-selected={sel || undefined}>
            <button type="button" className={s.objName} aria-pressed={sel} onClick={() => onSelect(sel ? null : f.id)}>
              <strong>{f.title}</strong>{" "}
              <span className="caption">
                {FIGURE_STATUS[f.status]} · качество {f.quality.toFixed(2)}
                {f.confirm_t ? ` · пробой ${new Date(f.confirm_t * 1000).toLocaleString("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} UTC` : ""}
              </span>
            </button>
            {sel && (
              <div className={s.foundDetails}>
                <div>{f.status === "confirmed" ? "подтверждена закрытием свечи за линией" : f.status === "forming" ? "геометрия без подтверждения: цель и статистика не показываются" : "отменена: цена закрылась против фигуры или вышло время"}</div>
                {f.status === "confirmed" && f.target && <div>расчётная цель {f.target}{f.invalidation ? `, инвалидация ${f.invalidation}` : ""}</div>}
                {f.status === "confirmed" && <div>{figureStatText(stats[f.type])}</div>}
                <div className="caption">не является сигналом или рекомендацией</div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}


/** Поле вопроса о графике (план 3.17, 4B.7): Premium; остальным — пояснение из ответа сервера. */
export function AskBox({ symbol, tf }: { symbol: string; tf: string }) {
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
    <form className={s.ask} onSubmit={submit} aria-label="вопрос о графике">
      <label>
        Вопрос о графике
        <textarea aria-label="текст вопроса" maxLength={500} rows={2} placeholder="например: почему зона считается активной?" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className={s.askRow}>
        <span className="caption">{q.length}/500 · только по фактам графика, без рекомендаций и прогнозов</span>
        <button type="submit" className={s.chip} disabled={state === "loading" || !q.trim()}>
          Спросить
        </button>
      </div>
      {state === "loading" && <p className="caption">составляю ответ по данным графика…</p>}
      {state !== null && typeof state === "object" && "error" in state && <p className="caption">{state.error}</p>}
      {state !== null && typeof state === "object" && "text" in state && (
        <div data-testid="ask-answer">
          <p>{state.text}</p>
          <p className="caption">
            {state.footer}
            {state.source === "template" ? "" : " Ответ прошёл проверку: все числа — из данных графика."}
          </p>
        </div>
      )}
    </form>
  );
}
