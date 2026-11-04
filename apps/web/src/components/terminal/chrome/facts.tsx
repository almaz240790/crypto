"use client";

import { formatCountdown, secondsToClose, type Timeframe } from "@platform/charts";
import { useEffect, useState } from "react";
import { useT } from "@/i18n/client";
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

/** До закрытия свечи (в «Сводке»; на графике отсчёт под ценой рисует контроллер, PR B). */
export function Countdown({ tf, lastTime }: { tf: Timeframe; lastTime: number | null }) {
  const t = useT();
  const now = useSecond();
  const left = lastTime == null ? null : secondsToClose(tf, lastTime, now);
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

/** Связь с потоком цен: точка (--up — онлайн), текст — для чтения с экрана и в подсказке. */
export function LiveDot({ on }: { on: boolean }) {
  const t = useT();
  const text = on ? t("онлайн") : t("без связи");
  return (
    <span className={c.live} data-on={on || undefined} title={text}>
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
