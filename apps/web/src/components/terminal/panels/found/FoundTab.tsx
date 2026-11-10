"use client";

import type { ChartState, ChartStore, SceneIndex } from "@platform/charts";
import Link from "next/link";
import { memo, useCallback, useState } from "react";
import { SegmentedControl } from "@/components/ui";
import { useT } from "@/i18n/client";
import type { FigureOnChart, FigureStat, PatternOnChart, PatternStat } from "@/lib/chart";
import { signalsLinkHref, type SignalsLink } from "@/lib/signals";
import type { Timeframe } from "@/lib/timeframes";
import { useChartStore } from "../../chart/useChartStore";
import { AskBox } from "./AskBox";
import { foundCounts } from "./counts";
import { FiguresList } from "./FiguresList";
import { LevelsTable } from "./LevelsTable";
import { PatternsList } from "./PatternsList";
import p from "../panels.module.css";

export type FoundSection = "levels" | "figures" | "patterns";

export type FoundData = {
  symbol: string;
  tf: Timeframe;
  tick: string | null;
  lastClose: number | null;
  figures: readonly FigureOnChart[];
  figureStats: Record<string, FigureStat>;
  patterns: readonly PatternOnChart[];
  patternStats: Record<string, PatternStat>;
  canExplain: boolean;
  askAccess: "guest" | "plan" | "ok" | null;
  /** «сигналов по инструменту: N» (вошедшим, если сигналы есть). */
  signals: SignalsLink | null;
  /** Строка уровня → выбрать объект и показать его (повторно — снять). */
  onLevel: (id: string | null) => void;
  /** Фигура или паттерн → выбрать и прокрутить к времени, если за кадром. */
  onFocus: (objectId: string | null, time?: number) => void;
};

const selectIndex = (s: ChartState) => s.sceneIndex;
const selectFrom = (s: ChartState) => s.visible.fromTime;
const selectSelection = (s: ChartState) => s.selection;

/**
 * «Найдено» (план 2B.9 §8.1): разделы «Уровни (n) | Фигуры (n) | Паттерны (n)» с теми же числами, что в списках,
 * по умолчанию — «Уровни»; ниже — сигналы по инструменту и вопрос о графике (свой компактный блок в конце).
 * Лист: читает сцену, видимый участок и выбор из хранилища графика — TerminalShell от них не зависит.
 */
export const FoundTab = memo(function FoundTab({ store, data, ask = true }: { store: ChartStore; data: FoundData; ask?: boolean }) {
  const t = useT();
  const [section, setSection] = useState<FoundSection>("levels");
  const index: SceneIndex | null = useChartStore(selectIndex, store);
  const visibleFrom = useChartStore(selectFrom, store);
  const selection = useChartStore(selectSelection, store);
  const counts = foundCounts(index, data.figures, data.patterns, visibleFrom);
  const figureSel = selection?.startsWith("fig:") ? Number(selection.slice(4)) : null;
  const patternSel = selection?.startsWith("pat:") ? Number(selection.slice(4)) : null;
  const { onFocus } = data;
  const onFigure = useCallback((f: FigureOnChart | null) => onFocus(f ? `fig:${f.id}` : null, f ? f.end_t : undefined), [onFocus]);
  const onPattern = useCallback((x: PatternOnChart | null) => onFocus(x ? `pat:${x.id}` : null, x ? x.t : undefined), [onFocus]);
  const items = [
    { value: "levels" as const, label: t("Уровни ({n})", { n: counts.levels }) },
    { value: "figures" as const, label: t("Фигуры ({n})", { n: counts.figures }) },
    { value: "patterns" as const, label: t("Паттерны ({n})", { n: counts.patterns }) },
  ];
  return (
    <div className={p.found}>
      <SegmentedControl mode="tabs" items={items} value={section} onSelect={setSection} label={t("разделы найденного")} size="sm" className={p.sections} />
      <div className={p.section}>
        {section === "levels" && <LevelsTable index={index} tick={data.tick} lastClose={data.lastClose} tf={data.tf} selected={selection} onPick={data.onLevel} />}
        {section === "figures" && <FiguresList items={data.figures} stats={data.figureStats} selected={figureSel} onSelect={onFigure} tick={data.tick} visibleFrom={visibleFrom} />}
        {section === "patterns" && <PatternsList items={data.patterns} stats={data.patternStats} selected={patternSel} onSelect={onPattern} tf={data.tf} symbol={data.symbol} canExplain={data.canExplain} visibleFrom={visibleFrom} />}
        {data.signals && data.signals.n > 0 && (
          <Link className={p.signals} href={signalsLinkHref(data.signals)}>
            {data.signals.test ? t("тестовых сигналов по инструменту: {n}", { n: data.signals.n }) : t("сигналов по инструменту: {n}", { n: data.signals.n })}
          </Link>
        )}
      </div>
      {ask && (
        <div className={p.askHost}>
          <AskBox symbol={data.symbol} tf={data.tf} access={data.askAccess} compact />
        </div>
      )}
    </div>
  );
});
