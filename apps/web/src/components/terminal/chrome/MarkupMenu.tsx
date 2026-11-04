"use client";

import { PRESETS, SELECTABLE_PRESETS, type MarkupSettings, type PresetId } from "@platform/charts";
import { Button, Menu, type MenuItemSpec } from "@/components/ui";
import { IconChevronDown, IconLayers } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { presetNote, presetTitle } from "../MarkupPicker";

type Props = {
  markup: MarkupSettings;
  /** Есть поправки слоёв поверх пресета: отмечен «Свой». */
  custom: boolean;
  onSelect: (id: PresetId) => void;
  /** «Настроить слои…»: правая панель на вкладке «Слои». */
  onLayers: () => void;
};

/**
 * «Разметка» в тулбаре (план 2B.9, §3.3; ADR-0008): пять выбираемых пресетов (menuitemradio) с пояснением,
 * «Свой» — недоступен и отмечен, пока есть поправки; «Настроить слои…» открывает вкладку «Слои».
 * Выбор пресета сбрасывает поправки (selectPreset). Имя кнопки — «Разметка: {имя}» и в компактном виде.
 */
export function MarkupMenu({ markup, custom, onSelect, onLayers }: Props) {
  const t = useT();
  const name = custom ? t("Свой") : presetTitle(markup.preset, t);
  const items: MenuItemSpec[] = [
    { type: "group", id: "head", label: t("Разметка графика") },
    ...SELECTABLE_PRESETS.filter((id) => PRESETS[id].userSelectable).map(
      (id): MenuItemSpec => ({ type: "radio", id, label: presetTitle(id, t), hint: presetNote(id, t), checked: !custom && markup.preset === id, onSelect: () => onSelect(id) }),
    ),
    { type: "radio", id: "custom", label: t("Свой"), checked: custom, disabled: true, hint: custom ? t("ваши изменения поверх «{preset}»", { preset: presetTitle(markup.preset, t) }) : t("появляется, когда слои изменены вручную") },
    { type: "separator", id: "sep" },
    { id: "layers", label: t("Настроить слои…"), onSelect: onLayers },
  ];
  return (
    <Menu
      items={items}
      minWidth={300}
      trigger={(p) => (
        <Button {...p} variant="ghost" aria-label={t("Разметка: {name}", { name })} title={t("Разметка графика")}>
          <IconLayers />
          <span data-ov-extra>{name}</span>
          <span data-ov-extra>
            <IconChevronDown />
          </span>
        </Button>
      )}
    />
  );
}
