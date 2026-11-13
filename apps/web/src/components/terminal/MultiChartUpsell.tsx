"use client";

import { Button } from "@/components/ui";
import { useT } from "@/i18n/client";
import s from "./terminal.module.css";

/**
 * Экран вместо сетки мультичарта без права на него (план, раздел 4: Premium — «Все + мультичарт (v2)»; ADR-0009,
 * дополнение 2026-11-13): что это, на каком тарифе, подписка (гость — /pricing и вход: Premium мог уже быть, вошедший —
 * /billing) и терминал одного инструмента. На любой ширине: сначала тариф, а «только на десктопе» — в тексте.
 */
export function MultiChartUpsell({ guest }: { guest: boolean }) {
  const t = useT();
  return (
    <div className={s.multiUpsell} data-testid="multichart-upsell">
      <div className={s.multiUpsellBody}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={s.multiUpsellShot} src="/landing/multi.8073678b.webp" width={2000} height={1312} alt={t("Мультичарт PlatformSol: четыре графика — BTCUSDT и ETHUSDT на 4 часах, SOLUSDT и BNBUSDT на 1 дне — с поддержкой, сопротивлением и зонами спроса и предложения")} />
        <h2>{t("Доступно с подпиской Premium")}</h2>
        <p>{t("Мультичарт — 2 или 4 графика на одном экране: у каждого свой инструмент и таймфрейм, разметка структуры рынка, зон и уровней — одна на все графики. Работает на десктопе (ширина экрана от 900 px).")}</p>
        {guest && <p className={s.multiUpsellNote}>{t("Если подписка Premium уже есть, войдите.")}</p>}
        <div className={s.loadErrorActions}>
          <Button variant="primary" size="sm" href={guest ? "/pricing" : "/billing"}>
            {t("Подписка")}
          </Button>
          {guest && (
            <Button variant="ghost" size="sm" href="/login?next=/multichart">
              {t("Войти")}
            </Button>
          )}
          <Button variant="ghost" size="sm" href="/chart/BTCUSDT/4h">
            {t("Открыть терминал")}
          </Button>
        </div>
      </div>
    </div>
  );
}
