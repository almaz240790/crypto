"use client";

import { INDICATORS, canAdd, instanceColors, instanceTitle, maxInstances, type IndicatorInstance, type IndicatorSpec, type PanelKey } from "@platform/charts";
import { useMemo, useState, type ReactElement } from "react";
import { Button, IconButton, Input } from "@/components/ui";
import { IconClose } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { IND_COLOR_VAR, PANELS, indicatorColor } from "../chart/ChartSurface";
import c from "../chrome/chrome.module.css";
import { IndicatorParams } from "./IndicatorParams";

type Props = {
  /** Экземпляры индикаторов (uid «ema#2»): флажок отмечен, если есть хотя бы один. */
  instances: readonly IndicatorInstance[];
  panels: readonly PanelKey[];
  /** Флажок: нет экземпляров — добавить один, есть — убрать все. */
  onIndicator: (id: string) => void;
  /** «+ ещё EMA»: ещё один экземпляр (до 3 у EMA и SMA). */
  onAdd: (id: string) => void;
  onRemove: (uid: string) => void;
  onParams: (uid: string, params: Record<string, number>) => void;
  onPanel: (k: PanelKey) => void;
  onDone: () => void;
};

/** Название в списке: объём — «Объём», как заголовок его панели (в реестре — «Volume»). */
const pickerTitle = (spec: IndicatorSpec, t: (s: string) => string) => (spec.id === "volume" ? t("Объём") : t(spec.title));
/** Порядок под графиком (§9): RSI, MACD, Stochastic, ATR, CCI, OBV и последним — объём; остальное — как в реестре. */
const pickerOrder = (list: readonly IndicatorSpec[]) => [...list].sort((a, b) => Number(a.id === "volume") - Number(b.id === "volume"));

/** Подсказки панелей производных: ликвидации — публичный поток, не полный объём. */
const PANEL_HINT: Partial<Record<PanelKey, string>> = { liq: "данные публичного потока, не полный объём" };

/**
 * Выбор индикаторов на десктопе (план 2B.9, §9): поиск, «Готово» и две колонки — «На графике», «Под графиком»
 * и «Данные фьючерсов». Строка — нативный флажок (getByRole("checkbox") в e2e), точка цвета и название; под
 * включённым индикатором — его экземпляры: параметры, «убрать {имя}» и у скользящих средних «+ ещё EMA» (до 3).
 * Цвет постоянный (решение владельца), поэтому выбора цвета и радиогрупп нет.
 */
export function IndicatorsPicker({ instances, panels, onIndicator, onAdd, onRemove, onParams, onPanel, onDone }: Props) {
  const t = useT();
  const [q, setQ] = useState("");
  const colors = useMemo(() => instanceColors(instances), [instances]);
  const match = (title: string) => !q.trim() || title.toLowerCase().includes(q.trim().toLowerCase());
  const row = (key: string, title: string, checked: boolean, onChange: () => void, color?: string, hint?: string) => (
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
  const indicator = (spec: IndicatorSpec): false | ReactElement => {
    const title = pickerTitle(spec, t);
    if (!match(title)) return false;
    const mine = instances.filter((i) => i.id === spec.id);
    const multi = maxInstances(spec.id) > 1 && spec.pane === "overlay";
    const color = mine[0] ? colors.get(mine[0].uid) : undefined;
    return (
      <div key={spec.id} className={c.pickerItem}>
        {row(spec.id, title, mine.length > 0, () => onIndicator(spec.id), IND_COLOR_VAR[color ?? indicatorColor(spec.id)])}
        {mine.length > 0 && (spec.params.length > 0 || multi) && (
          <div className={c.instances}>
            {mine.map((inst) => {
              const name = instanceTitle(spec, inst.params, t);
              return (
                <div key={inst.uid} className={c.instance}>
                  {/* точка и «убрать» — на уровне первой строки полей, когда поля переносятся на несколько строк */}
                  <span className={c.instanceLead} aria-hidden="true">
                    <span className={c.dot} style={{ background: `var(${IND_COLOR_VAR[colors.get(inst.uid) ?? indicatorColor(spec.id)]})` }} />
                  </span>
                  <IndicatorParams inst={inst} onChange={onParams} />
                  {multi && (
                    <span className={c.instanceLead}>
                      <IconButton size="xs" label={t("убрать {name}", { name })} onClick={() => onRemove(inst.uid)}>
                        <IconClose />
                      </IconButton>
                    </span>
                  )}
                </div>
              );
            })}
            {multi && (
              <Button variant="ghost" size="sm" className={c.addInstance} disabled={!canAdd(instances, spec.id)} onClick={() => onAdd(spec.id)}>
                {t("+ ещё {name}", { name: spec.title })}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };
  const ind = (pane: "overlay" | "separate") => pickerOrder(INDICATORS.filter((i) => i.pane === pane)).map(indicator);
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
            PANELS.map((pn) => match(t(pn.title)) && row(pn.id, t(pn.title), panels.includes(pn.id), () => onPanel(pn.id), undefined, PANEL_HINT[pn.id] ? t(PANEL_HINT[pn.id]!) : undefined)),
          )}
        </div>
      </div>
    </div>
  );
}
