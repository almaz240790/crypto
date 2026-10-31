"use client";

import { PRESETS, SELECTABLE_PRESETS, type MarkupSettings, type PresetId } from "@platform/charts";
import { useId } from "react";
import { useT } from "@/i18n/client";
import s from "./terminal.module.css";

/** Название пресета (литералы — для check-i18n и проверки текстов владельцем). */
function presetTitle(id: PresetId, t: (s: string) => string): string {
  switch (id) {
    case "clean":
      return t("Чистый");
    case "structure":
      return t("Структура");
    case "levels":
      return t("Уровни и зоны");
    case "liquidity":
      return t("Карта ликвидаций");
    case "detailed":
      return t("Подробный");
    default:
      return t("Компактный");
  }
}

/** Одна строка пояснения к пресету: что он показывает на графике. */
function presetNote(id: PresetId, t: (s: string) => string): string {
  switch (id) {
    case "clean":
      return t("Свечи, ближайшие поддержка, сопротивление и зона");
    case "structure":
      return t("Последний пробой и смена направления, равные максимумы и минимумы рядом с ценой");
    case "levels":
      return t("Две поддержки и два сопротивления, ближайшие спрос и предложение, максимумы и минимумы вчера и прошлой недели");
    case "liquidity":
      return t("Оценка ликвидаций справа от свечей и ближайшие уровни");
    default:
      return t("Вся автоматическая разметка: структура, зоны, уровни, ликвидации, фигура");
  }
}

/**
 * Выбор разметки графика (план 2B.2, ADR-0008): пресет переключает только слои и лимиты — индикаторы и панели
 * не трогает. Флажок слоя поверх пресета — поправка: тогда отмечен «Свой» (виден, только пока активен);
 * выбор любого пресета поправки сбрасывает.
 */
export function MarkupPicker({ markup, custom, onSelect }: { markup: MarkupSettings; custom: boolean; onSelect: (id: PresetId) => void }) {
  const t = useT();
  const uid = useId();
  const name = `markup${uid}`;
  return (
    <div role="radiogroup" aria-label={t("Разметка")} className={s.markup}>
      {SELECTABLE_PRESETS.filter((id) => PRESETS[id].userSelectable).map((id) => (
        <div key={id} className={s.markupItem}>
          <label>
            <input type="radio" name={name} checked={!custom && markup.preset === id} onChange={() => onSelect(id)} aria-describedby={`${uid}-${id}`} /> {presetTitle(id, t)}
          </label>
          <span id={`${uid}-${id}`} className={s.markupNote}>
            {presetNote(id, t)}
          </span>
        </div>
      ))}
      {custom && (
        <div className={s.markupItem}>
          <label>
            <input type="radio" name={name} checked disabled readOnly aria-describedby={`${uid}-custom`} /> {t("Свой")}
          </label>
          <span id={`${uid}-custom`} className={s.markupNote}>
            {t("ваши изменения поверх «{preset}»", { preset: presetTitle(markup.preset, t) })}
          </span>
        </div>
      )}
    </div>
  );
}
