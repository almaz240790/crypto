"use client";

import type { Timeframe } from "@platform/charts";
import { Button } from "@/components/ui";
import { useT } from "@/i18n/client";
import { TF_LABEL } from "@/lib/timeframes";
import { loadErrorKind, type LoadError } from "./loadError";
import s from "./terminal.module.css";

/**
 * Объяснение вместо графика, когда первая порция свечей не загрузилась (аудит chart-data-live-1, TSA-2) — терминал и
 * ячейка мультичарта. По статусу ответа, а не по тексту сервера (он русский): 403 на минутном ТФ — «1m–15m — Pro»
 * со входом и подпиской; 404 — «инструмент не найден» (в терминале — ссылка на BTCUSDT 4ч); остальное — сбой с
 * «Повторить» (повторы с паузами идут и сами, «Загрузка…» — пока запрос в пути).
 */
export function ChartLoadError({ error, symbol, tf, guest, retrying, onRetry, home = true }: { error: LoadError; symbol: string; tf: Timeframe; guest: boolean; retrying: boolean; onRetry: () => void; home?: boolean }) {
  const t = useT();
  const kind = loadErrorKind(error, tf);
  if (kind === "intraday")
    return (
      <div className={s.empty}>
        <div className={s.loadError} data-testid="chart-load-error">
          <p>{guest ? t("Таймфреймы 1m–15m доступны после входа с подпиской Pro.") : t("Таймфреймы 1m–15m доступны с подпиской Pro.")}</p>
          <div className={s.loadErrorActions}>
            {guest && (
              <Button variant="primary" size="sm" href={`/login?next=/chart/${symbol}/${tf}`}>
                {t("Войти")}
              </Button>
            )}
            <Button variant={guest ? "ghost" : "primary"} size="sm" href={guest ? "/pricing" : "/billing"}>
              {t("Подписка")}
            </Button>
          </div>
        </div>
      </div>
    );
  return (
    <div className={s.empty}>
      <div className={s.loadError} role="alert" data-testid="chart-load-error">
        {kind === "not_found" ? (
          <>
            <p>{t("Инструмент {symbol} не найден.", { symbol })}</p>
            {home && (
              <div className={s.loadErrorActions}>
                <Button variant="ghost" size="sm" href="/chart/BTCUSDT/4h">
                  {t("Открыть BTCUSDT {tf}", { tf: t(TF_LABEL["4h"]) })}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <p>{error.status === null ? t("Не удалось загрузить свечи: нет связи с сервером.") : t("Не удалось загрузить свечи (ошибка {status}).", { status: error.status })}</p>
            <div className={s.loadErrorActions}>
              <Button variant="ghost" size="sm" disabled={retrying} onClick={onRetry}>
                {retrying ? t("Загрузка…") : t("Повторить")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
