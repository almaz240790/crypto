"use client";

import { LAYER_KEYS, type LayerKey, type MarkupSettings, type PresetId } from "@platform/charts";
import { memo } from "react";
import { useT } from "@/i18n/client";
import { MarkupPicker } from "../MarkupPicker";
import p from "./panels.module.css";

export const LAYER_LABEL: Record<LayerKey, string> = { structure: "Структура", zones: "Зоны", levels: "Макс./мин. дня и недели", signals: "Сигналы", patterns: "Паттерны", figures: "Фигуры", volume_profile: "Профиль объёма", sr: "Поддержка и сопротивление", liq_map: "Карта ликвидаций (оценка)" };
/** Слои в «Слоях»: «Сигналы» — только вошедшим (M24), а пока сигналы закрыты — только admin и owner (ADR-0013). */
export const layerKeysFor = (signals: boolean): LayerKey[] => (Object.keys(LAYER_LABEL) as LayerKey[]).filter((k) => LAYER_KEYS.includes(k) && (signals || k !== "signals"));

type Props = {
  markup: MarkupSettings;
  custom: boolean;
  onMarkup: (id: PresetId) => void;
  layers: Readonly<Record<LayerKey, boolean>>;
  onLayer: (k: LayerKey) => void;
  /** Показывать ли слой «Сигналы»: вошедшему, которому сигналы видны. */
  signals: boolean;
  liqUnavailable: boolean;
};

/**
 * «Слои» (план 2B.9 §8.2): радиогруппа «Разметка» (пресеты B) и флажки слоёв поверх пресета («Свой»).
 * Панели производных отсюда убраны — они в «Индикаторах» («Данные фьючерсов»), дубля больше нет.
 */
export const LayersTab = memo(function LayersTab({ markup, custom, onMarkup, layers, onLayer, signals, liqUnavailable }: Props) {
  const t = useT();
  return (
    <div className={p.tab}>
      <MarkupPicker markup={markup} custom={custom} onSelect={onMarkup} liqUnavailable={liqUnavailable} />
      <fieldset className={p.checks}>
        <legend>{t("Слои на графике")}</legend>
        {layerKeysFor(signals).map((k) => (
          <label key={k} className={p.check}>
            <input type="checkbox" checked={layers[k]} onChange={() => onLayer(k)} /> {t(LAYER_LABEL[k])}
            {k === "liq_map" && liqUnavailable && <span className={p.note}>{t("нет данных открытого интереса на этом таймфрейме")}</span>}
          </label>
        ))}
      </fieldset>
    </div>
  );
});
