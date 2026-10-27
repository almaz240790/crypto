"use client";

import Link from "next/link";
import type { PatternOnChart, PatternStat } from "@/lib/chart";
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

export function FoundList({ items, stats, selected, onSelect, tf }: { items: PatternOnChart[]; stats: Record<string, PatternStat>; selected: number | null; onSelect: (id: number | null) => void; tf: string }) {
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
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
