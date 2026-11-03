"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { askChart, explainPattern, type Explanation, type FigureOnChart, type FigureStat, type PatternOnChart, type PatternStat } from "@/lib/chart";
import { formatPrice, formatUsdCompact } from "@/lib/format";
import type { Timeframe } from "@/lib/timeframes";
import s from "./terminal.module.css";
import { useT } from "@/i18n/client";
import type { T } from "@/i18n";
import type { LiqMap, SrLevel } from "@platform/charts";
import type { ZoneGroup } from "@/lib/zones";

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
              <strong>{t(p.title)}</strong>{" "}
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
export function FiguresList({ items, stats, selected, onSelect, tick = null }: { items: FigureOnChart[]; stats: Record<string, FigureStat>; selected: number | null; onSelect: (id: number | null) => void; tick?: string | null }) {
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
              <strong>{t(f.title)}</strong>{" "}
              <span className="caption">
                {t(FIGURE_STATUS[f.status])} · {t("качество")} {f.quality.toFixed(2)}
                {f.confirm_t ? ` · ${t("пробой")} ${new Date(f.confirm_t * 1000).toLocaleString("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} UTC` : ""}
              </span>
            </button>
            {sel && (
              <div className={s.foundDetails}>
                <div>{f.status === "confirmed" ? t("подтверждена закрытием свечи за линией") : f.status === "forming" ? t("геометрия без подтверждения: цель и статистика не показываются") : t("отменена: цена закрылась против фигуры или вышло время")}</div>
                {f.status === "confirmed" && f.target && <div>{t("расчётная цель")} {formatPrice(f.target, tick)}{f.invalidation ? `, ${t("инвалидация")} ${formatPrice(f.invalidation, tick)}` : ""}</div>}
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
/** Уровни списком (план 2A.4, 2A.6): на графике подписи могут скрываться при наложении, здесь видны все. */
export function LevelsList({ sr, liq, tick, zones = [], liqUnavailable = false }: { sr: SrLevel[]; liq: LiqMap | null; tick: string | null; zones?: ZoneGroup[]; liqUnavailable?: boolean }) {
  const t = useT();
  // точность — по шагу цены инструмента, как на шкале (в том числе для шага в записи 1.000E-7)
  const px = (p: number) => formatPrice(p, tick);
  if (sr.length === 0 && !liq && zones.length === 0 && !liqUnavailable) return null;
  const res = sr.filter((l) => l.side === "resistance").sort((a, b) => b.price - a.price);
  const sup = sr.filter((l) => l.side === "support").sort((a, b) => b.price - a.price);
  return (
    <>
      <strong className={s.objHead}>{t("Уровни")}</strong>
      <ul className={s.levelList} aria-label={t("уровни поддержки и сопротивления")}>
        {[...(liq?.topShorts ?? [])].sort((a, b) => b.price - a.price).map((b) => (
          <li key={`ls${b.price}`} title={t("Оценка по приросту открытого интереса для плеч 10–100×, не данные биржи.")}>
            <span className={s.levelLiq}>{t("Ликвидации шортов")}</span> <span className="num">{px(b.price)}</span> <strong className={`num ${s.levelLiq}`}>≈ {formatUsdCompact(b.short)}</strong>
          </li>
        ))}
        {res.map((l) => (
          <li key={`r${l.price}`}>
            <strong className="down">R</strong> <span className="caption">{t("сопротивление")}</span> <span className="num">{px(l.price)}</span> <span className="caption">{t("касаний: {n}", { n: l.touches })}</span>
          </li>
        ))}
        {zones.map((z) => (
          <li key={`z${z.bottom}`}>
            <strong className={z.dir === "up" ? "up" : z.dir === "down" ? "down" : ""}>{z.codes.join("+")}</strong> <span className="caption">{z.names.map((n) => t(n)).join(" + ")}</span> <span className={`num ${s.levelRange}`}>{px(z.bottom)}–{px(z.top)}</span>
          </li>
        ))}
        {sup.map((l) => (
          <li key={`s${l.price}`}>
            <strong className="up">S</strong> <span className="caption">{t("поддержка")}</span> <span className="num">{px(l.price)}</span> <span className="caption">{t("касаний: {n}", { n: l.touches })}</span>
          </li>
        ))}
        {[...(liq?.topLongs ?? [])].sort((a, b) => b.price - a.price).map((b) => (
          <li key={`ll${b.price}`} title={t("Оценка по приросту открытого интереса для плеч 10–100×, не данные биржи.")}>
            <span className={s.levelLiq}>{t("Ликвидации лонгов")}</span> <span className="num">{px(b.price)}</span> <strong className={`num ${s.levelLiq}`}>≈ {formatUsdCompact(b.long)}</strong>
          </li>
        ))}
      </ul>
      {liq && <p className={`caption ${s.levelNote}`}>{t("Карта ликвидаций — расчётная оценка: суммы позиций с плечом 10–100×, которые закроются принудительно при подходе цены. Считается по приросту открытого интереса, а не по данным биржи.")}</p>}
      {!liq && liqUnavailable && <p className={`caption ${s.levelNote}`} data-testid="liq-unavailable">{t("Карта ликвидаций на этом таймфрейме недоступна: мало данных открытого интереса.")}</p>}
    </>
  );
}

/** Готовые вопросы: человеку без опыта проще начать с примера. */
const ASK_EXAMPLES = [
  "Какой сейчас тренд на старших таймфреймах?",
  "Где ближайшая зона и далеко ли до неё цена?",
  "Что за паттерн на последних свечах и как он отрабатывал раньше?",
  "Где проходят важные уровни выше и ниже цены?",
];
/** Ответы-заглушки сервера (нет тарифа, выключено, лимит) — показываем как уведомление, а не как ответ. */
const ASK_NOTICE = new Set(["plan", "disabled", "limit", "budget", "empty"]);

/**
 * Вопрос о графике (план 2A.10.3, 4B.7): Premium; текст ≤ 500 символов уходит как данные.
 * access: null — ещё неизвестно, "guest" — не вошёл, "plan" — тариф ниже Premium, "ok" — можно спрашивать.
 */
export function AskBox({ symbol, tf, access, heading = true }: { symbol: string; tf: string; access: "guest" | "plan" | "ok" | null; heading?: boolean }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [state, setState] = useState<Explanation | "loading" | { error: string } | null>(null);
  const answerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state && state !== "loading") answerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [state]);
  const send = (question: string) => {
    const text = question.trim().slice(0, 500);
    if (!text) return;
    setQ(text);
    setState("loading");
    askChart(symbol, tf as Timeframe, text)
      .then((r) => setState(r))
      .catch((err: Error) => setState({ error: err.message }));
  };
  if (access === "guest")
    return (
      <div className={s.ask}>
        {heading && <strong>{t("Вопрос о графике")}</strong>}
        <p className={s.askNote}>
          <Link href="/login">{t("Войдите")}</Link>, {t("чтобы задавать вопросы о графике.")}
        </p>
      </div>
    );
  if (access === "plan")
    return (
      <div className={s.ask}>
        {heading && <strong>{t("Вопрос о графике")}</strong>}
        <p className={s.askNote}>
          {t("Вопросы о графике доступны с подпиской Premium: ответ составляется только по данным этого графика — тренд, зоны, уровни, паттерны.")}{" "}
          <Link href="/billing">{t("Подписка")}</Link>
        </p>
      </div>
    );
  const busy = state === "loading";
  const notice = state !== null && typeof state === "object" && "text" in state && state.source === "template" && ASK_NOTICE.has(state.reason ?? "");
  return (
    <form
      className={s.ask}
      onSubmit={(e) => {
        e.preventDefault();
        send(q);
      }}
      aria-label={t("вопрос о графике")}
    >
      {heading && <strong>{t("Вопрос о графике")}</strong>}
      <div className={s.askExamples}>
        {ASK_EXAMPLES.map((x) => (
          <button key={x} type="button" className={s.askExample} disabled={busy} onClick={() => send(t(x))}>
            {t(x)}
          </button>
        ))}
      </div>
      <textarea aria-label={t("текст вопроса")} maxLength={500} rows={2} placeholder={t("или напишите свой вопрос")} value={q} onChange={(e) => setQ(e.target.value)} />
      <button type="submit" className={s.askSubmit} disabled={busy || !q.trim()}>
        {busy ? t("Составляю ответ…") : t("Спросить")}
      </button>
      <span className="caption">{t("Только по данным графика: без рекомендаций и прогнозов.")}</span>
      <div ref={answerRef} aria-live="polite">
        {busy && <p className={s.askNote}>{t("составляю ответ по данным графика…")}</p>}
        {state !== null && typeof state === "object" && "error" in state && <p className={s.askError}>{state.error}</p>}
        {state !== null && typeof state === "object" && "text" in state && (
          <div data-testid="ask-answer" className={notice ? s.askNote : s.askAnswer}>
            <p>{state.text}</p>
            {!notice && (
              <p className="caption">
                {state.footer}
                {state.source === "template" ? "" : t(" Ответ прошёл проверку: все числа — из данных графика.")}
              </p>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
