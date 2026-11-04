"use client";

import { Button, IconButton } from "@/components/ui";
import { IconMinus, IconPlus, IconToEnd } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import c from "./chrome.module.css";

/**
 * Угол графика (план 2B.9, §3.4, только десктоп): «отдалить», «приблизить», «показать последние свечи» —
 * внизу по центру основной панели, полупрозрачно до наведения. ChartSurface ставит его над шкалой времени
 * и передаёт прямоугольник в uiObstacles: подписи разметки его обходят.
 */
export function ChartCorner({ onZoom, onReset }: { onZoom: (factor: number) => void; onReset: () => void }) {
  const t = useT();
  return (
    <div className={c.corner}>
      <IconButton size="sm" label={t("отдалить")} title={t("Отдалить (клавиша −)")} onClick={() => onZoom(0.8)}>
        <IconMinus />
      </IconButton>
      <IconButton size="sm" label={t("приблизить")} title={t("Приблизить (клавиша +, колесо мыши)")} onClick={() => onZoom(1.25)}>
        <IconPlus />
      </IconButton>
      <IconButton size="sm" label={t("показать последние свечи")} title={t("Последние свечи (двойной клик по графику)")} onClick={onReset}>
        <IconToEnd />
      </IconButton>
    </div>
  );
}

/**
 * Режим рисования (десктоп): чип в правом верхнем углу основной панели, левее шкалы цены и не поверх легенды —
 * «Рисую: {инструмент}» (фокус на кнопке инструмента в левой панели) и «Готово» (закончить рисование; то же — Esc).
 */
export function DrawModeChip({ tool, onFinish }: { tool: string; onFinish: () => void }) {
  const t = useT();
  return (
    <div className={c.drawChip}>
      <Button size="sm" variant="ghost" onClick={() => document.querySelector<HTMLElement>('[role="toolbar"] [aria-pressed="true"]')?.focus()}>
        {t("Рисую: {tool}", { tool })}
      </Button>
      <Button size="sm" variant="primary" aria-label={t("закончить рисование")} onClick={onFinish}>
        {t("Готово")}
      </Button>
    </div>
  );
}
