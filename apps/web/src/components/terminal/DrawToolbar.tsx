"use client";

import { TOOL_TITLES, type DrawingType } from "@platform/charts";
import { memo, Fragment } from "react";
import { useT } from "@/i18n/client";
import { ToolIcon } from "./ToolIcon";
import s from "./terminal.module.css";

/** Группы инструментов (план 2B.9 §3.5): линии, наклонные, фигура и Фибоначчи, позиции, текст и линейка. */
const GROUPS: { t: DrawingType; key?: string }[][] = [
  [{ t: "hline", key: "Alt+H" }, { t: "hray" }, { t: "vline" }],
  [{ t: "trend", key: "Alt+T" }, { t: "ray" }, { t: "extended" }, { t: "channel" }],
  [{ t: "rect" }, { t: "fib" }],
  [{ t: "position-long" }, { t: "position-short" }],
  [{ t: "note" }, { t: "ruler" }],
];

type Props = {
  tool: DrawingType | null;
  onTool: (t: DrawingType | null) => void;
  magnet: boolean;
  onMagnet: (v: boolean) => void;
  /** Скрыть все рисунки (на всех таймфреймах этого инструмента). */
  hidden: boolean;
  onHidden: (v: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
};

/**
 * Левая панель рисования десктопа (план 2A.8, 2B.9 §3.5): кнопки 32 × 32 группами через разделитель, затем магнит
 * и «скрыть все рисунки», затем отменить/повторить. Нажатый инструмент — фон --row-hover и рамка --accent; включённый
 * магнит — точка --accent в углу (не рамка: настройка меняется редко и не должна притягивать взгляд); недоступная
 * кнопка — цвет --text-3 без прозрачности. Имена кнопок — прежние (контракт e2e).
 */
export const DrawToolbar = memo(function DrawToolbar({ tool, onTool, magnet, onMagnet, hidden, onHidden, canUndo, canRedo, onUndo, onRedo }: Props) {
  const t = useT();
  return (
    <div className={s.toolbar} role="toolbar" aria-label={t("панель рисования")} aria-orientation="vertical">
      {GROUPS.map((g, i) => (
        <Fragment key={g[0]!.t}>
          {i > 0 && <span className={s.toolSep} aria-hidden="true" />}
          {g.map((x) => (
            <button key={x.t} type="button" className={s.tool} aria-pressed={tool === x.t} title={`${t(TOOL_TITLES[x.t])}${x.key ? ` (${x.key})` : ""}`} aria-label={t(TOOL_TITLES[x.t])} onClick={() => onTool(tool === x.t ? null : x.t)}>
              <ToolIcon name={x.t} />
            </button>
          ))}
        </Fragment>
      ))}
      <span className={s.toolSep} aria-hidden="true" />
      <button type="button" className={`${s.tool} ${s.toolSwitch}`} aria-pressed={magnet} title={t("Магнит к OHLC")} aria-label={t("магнит")} onClick={() => onMagnet(!magnet)}>
        <ToolIcon name="magnet" />
      </button>
      <button type="button" className={`${s.tool} ${s.toolSwitch}`} aria-pressed={hidden} title={t("Скрыть все рисунки")} aria-label={t("скрыть все рисунки")} onClick={() => onHidden(!hidden)}>
        <ToolIcon name={hidden ? "eyeOff" : "eye"} />
      </button>
      <span className={s.toolSep} aria-hidden="true" />
      <button type="button" className={s.tool} disabled={!canUndo} title={t("Отменить (Ctrl+Z)")} aria-label={t("отменить")} onClick={onUndo}>
        <ToolIcon name="undo" />
      </button>
      <button type="button" className={s.tool} disabled={!canRedo} title={t("Повторить (Ctrl+Y)")} aria-label={t("повторить")} onClick={onRedo}>
        <ToolIcon name="redo" />
      </button>
    </div>
  );
});
