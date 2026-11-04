"use client";

import { CHART_TYPES, formatCountdown, secondsToClose, type ChartType, type ScaleMode, type Timeframe } from "@platform/charts";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useT } from "@/i18n/client";
import { formatPct, formatPrice } from "@/lib/format";
import { INTRADAY, TF_LABEL, TIMEFRAMES } from "@/lib/timeframes";
import type { Instrument } from "@/lib/user";
import type { HeaderFacts } from "./TerminalHeader";
import { SCALE_LABEL, TYPE_LABEL } from "./labels";
import s from "../terminal.module.css";

/**
 * Строки терминала на телефоне (< 900 px) — прежние, без изменений DOM, до раскладки телефона (PR C2):
 * верхняя строка (инструмент, ТФ, масштаб, вид), строка состояния и нижняя строка действий.
 */

/** Тренд старшего таймфрейма простыми словами. */
const TREND_WORD: Record<string, string> = { up: "вверх", down: "вниз", flat: "боковик" };
const TREND_TONE: Record<string, string> = { up: "up", down: "down" };

type TopProps = {
  symbol: string;
  tf: Timeframe;
  instruments: readonly Instrument[];
  onSymbol: (symbol: string) => void;
  guest: boolean;
  type: ChartType;
  scale: ScaleMode;
  onType: (t: ChartType) => void;
  onScale: (s: ScaleMode) => void;
  onZoom: (factor: number) => void;
  onReset: () => void;
  onSnapshot: () => void;
};

export function PhoneTop(p: TopProps) {
  const t = useT();
  return (
    <div className={s.top}>
      <select aria-label={t("инструмент")} value={p.symbol} onChange={(e) => p.onSymbol(e.target.value)}>
        {(p.instruments.length ? p.instruments : [{ symbol: p.symbol } as Instrument]).map((i) => (
          <option key={i.symbol} value={i.symbol}>
            {i.symbol}
          </option>
        ))}
      </select>
      <nav className={s.tfs} aria-label={t("таймфрейм")}>
        {TIMEFRAMES.map((x) => (
          <Link key={x} href={`/chart/${p.symbol}/${x}`} prefetch={false} aria-current={x === p.tf ? "page" : undefined} aria-disabled={INTRADAY.includes(x) && p.guest ? "true" : undefined} title={INTRADAY.includes(x) && p.guest ? t("после входа, подписка Pro") : undefined}>
            {t(TF_LABEL[x])}
          </Link>
        ))}
      </nav>
      <button type="button" className={s.chip} onClick={() => p.onZoom(1.25)} aria-label={t("приблизить")} title={t("Приблизить (клавиша +, колесо мыши)")}>
        +
      </button>
      <button type="button" className={s.chip} onClick={() => p.onZoom(0.8)} aria-label={t("отдалить")} title={t("Отдалить (клавиша −)")}>
        −
      </button>
      <button type="button" className={s.chip} onClick={p.onReset} aria-label={t("показать последние свечи")} title={t("Последние свечи (двойной клик по графику)")}>
        ⟲
      </button>
      <select aria-label={t("тип графика")} value={p.type} onChange={(e) => p.onType(e.target.value as ChartType)}>
        {CHART_TYPES.map((x) => (
          <option key={x} value={x}>
            {t(TYPE_LABEL[x])}
          </option>
        ))}
      </select>
      <select aria-label={t("шкала")} value={p.scale} onChange={(e) => p.onScale(e.target.value as ScaleMode)} title={t("Ценовая шкала")}>
        {(Object.keys(SCALE_LABEL) as ScaleMode[]).map((m) => (
          <option key={m} value={m}>
            {t(SCALE_LABEL[m])}
          </option>
        ))}
      </select>
      <span className={s.topSpacer} />
      <button type="button" className={s.chip} onClick={p.onSnapshot} title={t("Снимок PNG с водяным знаком")}>
        {t("Снимок")}
      </button>
    </div>
  );
}

/** Строка состояния телефона: свой таймер 1 с (отсчёт до закрытия и до фандинга), терминал не перерисовывается. */
export function PhoneStrip(p: HeaderFacts & { tf: Timeframe }) {
  const t = useT();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const countdown = p.lastTime == null ? null : secondsToClose(p.tf, p.lastTime, now);
  const trend = p.trend;
  return (
    <div className={s.strip} aria-label={t("состояние")}>
      <span>
        {t("цена")} <strong>{formatPrice(p.price == null ? null : String(p.price), p.tick)}</strong>
      </span>
      <span className={p.change == null ? "" : p.change >= 0 ? "up" : "down"}>{formatPct(p.change)}</span>
      <span>
        {t("до закрытия")} <strong>{countdown == null ? "—" : formatCountdown(countdown, t("{d}д {hm}"))}</strong>
      </span>
      {trend && (
        <span title={t("Направление старших таймфреймов, с которым система ищет входы: день (D1) и неделя (W1).")}>
          {t("Тренд")}: {t("день")} <strong className={TREND_TONE[trend.day] ?? ""}>{t(TREND_WORD[trend.day] ?? trend.day)}</strong> · {t("неделя")} <strong className={TREND_TONE[trend.week] ?? ""}>{t(TREND_WORD[trend.week] ?? trend.week)}</strong>
        </span>
      )}
      <span className={`caption ${s.live}`} data-on={p.connected || undefined}>
        {p.connected ? t("онлайн") : t("без связи")}
      </span>
      {p.heikin && <span className="caption">{t("Heikin Ashi: паттерны и сигналы считаются по обычным свечам")}</span>}
    </div>
  );
}

type BottomProps = {
  sheet: string | null;
  onSheet: (id: "indicators" | "layers" | "ask" | "found" | "draw" | null) => void;
  onAlert: () => void;
  indicatorsCount: number;
  /** «Найдено (n)»: лист-счётчик (FoundCounter) — оболочка не перерисовывается при сдвиге графика. */
  found: ReactNode;
  alertsCount: number;
  tool: string | null;
  onFinishTool: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  drawingsCount: number;
  sync: string | null;
  signalsLink: { symbol: string; n: number } | null;
};

export function PhoneBottom(p: BottomProps) {
  const t = useT();
  const toggle = (id: "indicators" | "layers" | "ask" | "found" | "draw") => p.onSheet(p.sheet === id ? null : id);
  return (
    <div className={s.bottom}>
      <button type="button" className={s.chip} aria-pressed={p.sheet === "indicators"} onClick={() => toggle("indicators")}>
        {t("Индикаторы ({n})", { n: p.indicatorsCount })}
      </button>
      <button type="button" className={s.chip} aria-pressed={p.sheet === "layers"} onClick={() => toggle("layers")}>
        {t("Слои")}
      </button>
      <button type="button" className={s.chip} aria-pressed={p.sheet === "ask"} onClick={() => toggle("ask")}>
        {t("Спросить")}
      </button>
      <button type="button" className={s.chip} aria-pressed={p.sheet === "found"} onClick={() => toggle("found")}>
        {p.found}
      </button>
      <button type="button" className={s.chip} aria-pressed={p.sheet === "alert"} onClick={() => (p.sheet === "alert" ? p.onSheet(null) : p.onAlert())}>
        {t("Алерт")}
        {p.alertsCount ? ` (${p.alertsCount})` : ""}
      </button>
      <button type="button" className={s.chip} aria-pressed={p.sheet === "draw" || p.tool !== null} onClick={() => toggle("draw")}>
        {p.tool ? t("Рисую: {tool}", { tool: p.tool }) : t("Рисовать")}
      </button>
      {p.tool && (
        <button type="button" className={s.chip} onClick={p.onFinishTool} aria-label={t("закончить рисование")}>
          {t("Готово")}
        </button>
      )}
      <button type="button" className={s.chip} onClick={p.onUndo} disabled={!p.canUndo} aria-label={t("отменить")}>
        ↶
      </button>
      <button type="button" className={s.chip} onClick={p.onRedo} disabled={!p.canRedo} aria-label={t("повторить")}>
        ↷
      </button>
      {/* счётчик и статус синхронизации для e2e и чтения с экрана — в TerminalShell (drawings-count) */}
      <span className="caption" aria-hidden="true">
        {t("рисунков: {n}", { n: p.drawingsCount })}
      </span>
      {p.sync && (
        <span className="caption" aria-hidden="true">
          {p.sync}
        </span>
      )}
      {p.signalsLink && (
        <Link className="caption" href={`/signals?symbol=${p.signalsLink.symbol}&tab=all`}>
          {t("сигналов по инструменту: {n}", { n: p.signalsLink.n })}
        </Link>
      )}
    </div>
  );
}
