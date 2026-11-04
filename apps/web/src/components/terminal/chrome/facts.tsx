"use client";

import { countdownSeconds, formatCountdown, type Timeframe } from "@platform/charts";
import { useEffect, useState } from "react";
import { useT } from "@/i18n/client";
import { useHeaderPrice, type HeaderPrice, type PriceSource } from "@/lib/liveSource";
import type { Trend, TrendDir } from "../state/useTrend";
import c from "./chrome.module.css";

/**
 * Листовые факты шапки (план 2B.9): у каждого таймера — свой интервал 1 с (на паузе в скрытой вкладке),
 * поэтому раз в секунду перерисовывается только он, а не терминал.
 */

const nowSec = () => Math.floor(Date.now() / 1000);

/** Текущее время в секундах, раз в секунду; пока вкладка скрыта — не тикает. */
function useSecond(): number {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    const tick = () => setNow(nowSec());
    let id: ReturnType<typeof setInterval> | undefined = setInterval(tick, 1000);
    const onVis = () => {
      clearInterval(id);
      if (document.hidden) return;
      tick();
      id = setInterval(tick, 1000);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return now;
}

/**
 * До закрытия свечи (в «Сводке»; на графике отсчёт под ценой рисует контроллер, PR B): идущего интервала — на 1m
 * последняя свеча уже закрыта, и отсчёт от неё был бы «0:00» (countdownSeconds).
 */
export function Countdown({ tf, lastTime }: { tf: Timeframe; lastTime: number | null }) {
  const t = useT();
  const now = useSecond();
  const left = lastTime == null ? null : countdownSeconds(tf, lastTime, now);
  return <span className={c.num}>{left == null ? "—" : formatCountdown(left, t("{d}д {hm}"))}</span>;
}

/** «Фандинг 0.0100 % · через 6:31:26»: ставка и отсчёт до следующего начисления. */
export function FundingChip({ rate, next, label = true }: { rate: string; next: number | null; label?: boolean }) {
  const t = useT();
  const now = useSecond();
  return (
    <span className={c.fact} title={t("Ставка финансирования фьючерса: плюс — лонги платят шортам, минус — наоборот.")}>
      {label && <>{t("Фандинг")} </>}
      <span className={c.num}>{(Number(rate) * 100).toFixed(4)} %</span>
      {next != null && (
        <>
          {" "}
          · {t("через")} <span className={c.num}>{formatCountdown(Math.max(0, next - now))}</span>
        </>
      )}
    </span>
  );
}

/** Подсказка «онлайн»: откуда цена (ADR-0010, дополнение «цена с биржи»). */
const SOURCE_TITLE: Record<PriceSource, string> = {
  binance: "цена с биржи в реальном времени",
  server: "цена с сервера, раз в секунду",
};

/** Подсказка состояния связи: онлайн — источник цены, без связи — undefined (текст говорит сам). */
export function liveTitle(t: (s: string) => string, online: boolean, source: PriceSource): string | undefined {
  return online ? t(SOURCE_TITLE[source]) : undefined;
}

/**
 * Цена шапки и изменение за свечу: живая цена (HeaderPrice — компонент подписан сам, ≤ 4 раз в секунду), без неё —
 * закрытие последней свечи (fallback); изменение — от закрытия предыдущей свечи (prevClose).
 */
export function useLivePrice(store: HeaderPrice | null, fallback: number | null, prevClose: number | null): { price: number | null; change: number | null } {
  const live = useHeaderPrice(store);
  const price = live != null ? Number(live) : fallback;
  const change = price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;
  return { price, change };
}

/**
 * Живая цена (ADR-0010): точка (--up — онлайн: цена с биржи или тик сервера за последние 5 с), текст — для чтения с
 * экрана; в подсказке — откуда цена.
 */
export function LiveDot({ on, source }: { on: boolean; source: PriceSource }) {
  const t = useT();
  const text = on ? t("онлайн") : t("без связи");
  return (
    <span className={c.live} data-on={on || undefined} data-source={on ? source : undefined} title={liveTitle(t, on, source) ?? text}>
      {/* e2e ищут «онлайн» в группе «состояние»: текст для чтения с экрана, не удалять */}
      <span className="sr-only">{text}</span>
    </span>
  );
}

const ARROW: Record<TrendDir, string> = { up: "↑", down: "↓", flat: "↔" };
const WORD: Record<TrendDir, string> = { up: "вверх", down: "вниз", flat: "боковик" };

/** Слот тренда шапки: «День ↑ Неделя ↔». Источник — useTrend (позже — лесенка topdown). */
export function TrendSlot({ trend }: { trend: Trend }) {
  const t = useT();
  return (
    <span className={c.trend} title={t("Направление старших таймфреймов, с которым система ищет входы: день (D1) и неделя (W1).")}>
      <span className={c.chip} data-dir={trend.day} title={t("Тренд дня: {dir}", { dir: t(WORD[trend.day]) })}>
        {t("День")} {ARROW[trend.day]}
      </span>
      <span className={c.chip} data-dir={trend.week} title={t("Тренд недели: {dir}", { dir: t(WORD[trend.week]) })}>
        {t("Неделя")} {ARROW[trend.week]}
      </span>
    </span>
  );
}
