"use client";

import type { Timeframe } from "@platform/charts";
import dynamic from "next/dynamic";
import { useT } from "@/i18n/client";
import { MQ, useMediaQuery } from "@/lib/breakpoints";
import { OBJECTS_W_DEFAULT, objectsWidthCss } from "./state/useTerminalUi";
import s from "./terminal.module.css";

/**
 * Пока грузится модуль терминала — его каркас (план 2B.9 §14): та же сетка .page с data-layout, на десктопе строки
 * шапки 44 и тулбара 40 (под пальцем 52), колонка рисования и правая панель от 1280 px. Терминал встаёт на её место
 * без скачка сетки; посередине колонки графика — «Загрузка графика…».
 */
function Loading() {
  const t = useT();
  const desktop = useMediaQuery(MQ.desktop, true);
  const wide = useMediaQuery(MQ.wide, true);
  const panel = desktop && wide;
  return (
    <div className={s.page} data-layout={desktop ? "desktop" : "phone"} aria-busy="true" data-testid="terminal-skeleton">
      {desktop && <div className={s.skelRow} />}
      {desktop && <div className={s.skelRow} />}
      <div className={s.area} data-objects={panel ? "shown" : "hidden"} data-panel="inline" style={{ "--objects-w": objectsWidthCss(OBJECTS_W_DEFAULT) } as React.CSSProperties}>
        {desktop && <div className={s.toolbar} />}
        <div className={s.chartCol}>
          <p className={s.empty}>{t("Загрузка графика…")}</p>
        </div>
        {panel && <div className={s.objects} />}
      </div>
    </div>
  );
}

const Page = dynamic(() => import("./TerminalShell").then((m) => m.TerminalShell), { ssr: false, loading: () => <Loading /> });

export function TerminalClient({ symbol, tf }: { symbol: string; tf: Timeframe }) {
  return <Page symbol={symbol} tf={tf} />;
}
