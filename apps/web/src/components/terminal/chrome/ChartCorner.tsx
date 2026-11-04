"use client";

import { Button, IconButton } from "@/components/ui";
import { IconMinus, IconPlus, IconToEnd } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import c from "./chrome.module.css";

/**
 * Угол графика (план 2B.9, §3.4, только десктоп): «отдалить», «приблизить», «показать последние свечи» —
 * внизу по центру основной панели, полупрозрачно, пока курсор не над колонкой графика (terminal.module.css
 * `.chartCol:hover [data-corner]`) и под пальцем — непрозрачно. ChartSurface ставит его над шкалой времени
 * и передаёт прямоугольник в uiObstacles: подписи разметки его обходят.
 */
export function ChartCorner({ onZoom, onReset }: { onZoom: (factor: number) => void; onReset: () => void }) {
  const t = useT();
  return (
    <div className={c.corner} data-corner>
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
 * Режим рисования (ADR-0009, «Рисование»): чип в правом верхнем углу основной панели, левее шкалы цены и не поверх
 * легенды, — на десктопе и на телефоне. «{инструмент} · {подсказка шага}» («Нажмите вторую точку») и одна кнопка:
 * «Отменить» — бросить начатый рисунок и вернуть курсор (то же — Esc); в «серии», пока рисунок не начат, — «Готово»
 * (закончить серию). Подсказка читается с экрана при смене шага (aria-live, без role=status: он один — тост).
 */
export function DrawModeChip({ tool, hint, finish, onExit }: { tool: string; hint: string; finish: boolean; onExit: () => void }) {
  const t = useT();
  return (
    <div className={c.drawChip} role="group" aria-label={t("режим рисования")} data-testid="draw-chip">
      <span className={c.drawHint} aria-live="polite">
        <span className={c.drawTool}>{tool}</span> <span>{hint}</span>
      </span>
      {finish ? (
        <Button size="sm" variant="primary" aria-label={t("Готово — закончить рисование")} title={t("Закончить серию рисунков (Esc)")} onClick={onExit}>
          {t("Готово")}
        </Button>
      ) : (
        <Button size="sm" variant="ghost" aria-label={t("Отменить рисунок")} title={t("Отменить рисунок и вернуть курсор (Esc)")} onClick={onExit}>
          {t("Отменить")}
        </Button>
      )}
    </div>
  );
}
