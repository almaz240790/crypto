"use client";

import type { Timeframe } from "@platform/charts";
import dynamic from "next/dynamic";
import { useT } from "@/i18n/client";
import { OBJECTS_W_DEFAULT, objectsWidthCss } from "./state/useTerminalUi";
import s from "./terminal.module.css";

/**
 * Пока грузится модуль терминала — его каркас (план 2B.9 §14): та же сетка .page — на десктопе строки шапки 44 и тулбара
 * 40 (под пальцем 52), колонка рисования и правая панель от 1280 px. Раскладку выбирают медиазапросы CSS, а не JS:
 * каркас приходит с сервера и до гидратации не знает ширину окна. Терминал встаёт на его место без скачка сетки;
 * посередине колонки графика — «Загрузка графика…».
 */
function Loading() {
  const t = useT();
  return (
    <div className={`${s.page} ${s.skeleton}`} aria-busy="true" data-testid="terminal-skeleton">
      <div className={s.skelRow} />
      <div className={s.skelRow} />
      <div className={s.area} data-objects="hidden" data-panel="inline" style={{ "--objects-w": objectsWidthCss(OBJECTS_W_DEFAULT) } as React.CSSProperties}>
        <div className={s.toolbar} />
        <div className={s.chartCol}>
          <p className={s.empty}>{t("Загрузка графика…")}</p>
        </div>
        <div className={s.objects} />
      </div>
    </div>
  );
}

const Page = dynamic(() => import("./TerminalShell").then((m) => m.TerminalShell), { ssr: false, loading: () => <Loading /> });

export function TerminalClient({ symbol, tf }: { symbol: string; tf: Timeframe }) {
  return <Page symbol={symbol} tf={tf} />;
}
