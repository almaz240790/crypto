"use client";

import { INDICATORS, type PanelKey } from "@platform/charts";
import { useState, type ReactElement } from "react";
import { Button, Input } from "@/components/ui";
import { useT } from "@/i18n/client";
import { IND_COLOR_VAR, PANELS, indicatorColor } from "../chart/ChartSurface";
import c from "../chrome/chrome.module.css";

type Props = {
  /** id включённых индикаторов (экземпляры с параметрами — PR C1c). */
  active: ReadonlySet<string>;
  panels: readonly PanelKey[];
  onIndicator: (id: string) => void;
  onPanel: (k: PanelKey) => void;
  onDone: () => void;
};

/** Подсказки панелей производных: ликвидации — публичный поток, не полный объём. */
const PANEL_HINT: Partial<Record<PanelKey, string>> = { liq: "данные публичного потока, не полный объём" };

/**
 * Выбор индикаторов на десктопе (план 2B.9, §9): поиск, «Готово» и две колонки — «На графике», «Под графиком»
 * и «Данные фьючерсов». Строка — нативный флажок (getByRole("checkbox") в e2e), точка цвета и название;
 * цвет постоянный (решение владельца), поэтому выбора цвета и радиогрупп нет.
 */
export function IndicatorsPicker({ active, panels, onIndicator, onPanel, onDone }: Props) {
  const t = useT();
  const [q, setQ] = useState("");
  const match = (title: string) => !q.trim() || title.toLowerCase().includes(q.trim().toLowerCase());
  const row = (key: string, title: string, checked: boolean, onChange: () => void, color?: string, hint?: string) =>
    match(title) && (
      <label key={key} className={c.pickerRow} title={hint}>
        <input type="checkbox" checked={checked} onChange={onChange} />
        {color && <span className={c.dot} style={{ background: `var(${color})` }} aria-hidden="true" />}
        {title}
      </label>
    );
  const group = (legend: string, rows: (false | ReactElement)[]) =>
    rows.some(Boolean) && (
      <fieldset className={c.pickerGroup}>
        <legend>{legend}</legend>
        {rows}
      </fieldset>
    );
  const ind = (pane: "overlay" | "separate") => INDICATORS.filter((i) => i.pane === pane).map((i) => row(i.id, t(i.title), active.has(i.id), () => onIndicator(i.id), IND_COLOR_VAR[indicatorColor(i.id)]));
  return (
    <div className={c.picker}>
      <div className={c.pickerHead}>
        <Input aria-label={t("поиск индикатора")} placeholder={t("Поиск")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button onClick={onDone}>{t("Готово")}</Button>
      </div>
      <div className={c.pickerGrid}>
        {group(t("На графике"), ind("overlay"))}
        <div className={c.pickerGroup}>
          {group(t("Под графиком"), ind("separate"))}
          {group(
            t("Данные фьючерсов"),
            PANELS.map((pn) => row(pn.id, t(pn.title), panels.includes(pn.id), () => onPanel(pn.id), undefined, PANEL_HINT[pn.id] ? t(PANEL_HINT[pn.id]!) : undefined)),
          )}
        </div>
      </div>
    </div>
  );
}
