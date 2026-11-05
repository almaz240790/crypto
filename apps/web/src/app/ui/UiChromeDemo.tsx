"use client";

import { useState } from "react";
import { Button, IconButton, Menu, Popover, SegmentedControl, Select, usePopover, type MenuItemSpec } from "@/components/ui";
import { IconCamera, IconChevronDown, IconGrid, IconLayers, IconLock, IconMagnet, IconMinus, IconPlus, IconRedo, IconToEnd, IconUndo } from "@/components/ui/icons";
import { makeT } from "@/i18n";
import { INTRADAY, TF_LABEL, TIMEFRAMES, tfOrder } from "@/lib/timeframes";
import s from "./page.module.css";

/** Пресеты разметки в меню (как в тулбаре терминала): пять выбираемых и «Свой» при поправках. */
const PRESETS = [
  ["clean", "Чистый"],
  ["structure", "Структура"],
  ["levels", "Уровни и зоны"],
  ["liquidity", "Карта ликвидаций"],
  ["detailed", "Подробный"],
] as const;

const ru = makeT("ru");
const en = makeT("en");

/**
 * Витрина элементов терминала (план 2B.9): SegmentedControl, IconButton, Menu и Popover — клиентский
 * остров страницы /ui. Тема переключается кнопкой вверху страницы; клавиатура: Tab, стрелки, Home/End, Esc.
 */
export function UiChromeDemo() {
  const [count, setCount] = useState<"2" | "4">("2");
  const [section, setSection] = useState<"levels" | "figures" | "patterns">("levels");
  const [preset, setPreset] = useState<string>("clean");
  const [magnet, setMagnet] = useState(true);
  const [type, setType] = useState("candles");
  const [log, setLog] = useState("—");
  const view = usePopover();
  const locked = usePopover();

  const menuItems: MenuItemSpec[] = [
    { type: "group", id: "g", label: "Разметка графика" },
    ...PRESETS.map(([id, title]): MenuItemSpec => ({ type: "radio", id, label: title, checked: preset === id, onSelect: () => setPreset(id) })),
    { type: "radio", id: "custom", label: "Свой", checked: false, disabled: true, hint: "появляется, когда слои изменены вручную" },
    { type: "separator", id: "sep" },
    { id: "layers", label: "Настроить слои…", onSelect: () => setLog("Настроить слои…") },
  ];
  const presetTitle = PRESETS.find(([id]) => id === preset)?.[1] ?? "Свой";
  const tfItems = tfOrder(true).map((x) =>
    INTRADAY.includes(x)
      ? {
          value: x,
          label: (
            <>
              {ru(TF_LABEL[x])} <IconLock />
            </>
          ),
          attrs: { "data-locked": "true", "aria-haspopup": "dialog", "aria-expanded": locked.open },
        }
      : { value: x, label: ru(TF_LABEL[x]), href: `/chart/BTCUSDT/${x}` },
  );

  return (
    <div className={s.col} data-testid="ui-chrome-demo">
      <div className={s.demoRow}>
        <span className="caption">SegmentedControl · links (гость: минутные после доступных, с замком)</span>
        <SegmentedControl mode="links" label="таймфрейм" value="4h" items={tfItems} onSelect={(_, el) => locked.toggle(el)} />
        <Popover open={locked.open} onClose={locked.close} anchor={locked.anchor} label="Минутные таймфреймы" id={locked.id} width={280}>
          <p style={{ margin: "0 0 12px" }}>1м, 5м и 15м — после входа с подпиской Pro.</p>
          <div className={s.row}>
            <Button variant="primary" size="sm" href="/login?next=/chart/BTCUSDT/1m">
              Войти
            </Button>
            <Button variant="ghost" size="sm" href="/pricing">
              Подписка
            </Button>
          </div>
        </Popover>
      </div>

      <div className={s.demoRow}>
        <span className="caption">SegmentedControl · toggle и tabs</span>
        <div className={s.row}>
          <span className="text-2">Графиков:</span>
          <SegmentedControl
            mode="toggle"
            label="число графиков"
            value={count}
            items={[
              { value: "2", label: "2" },
              { value: "4", label: "4" },
            ]}
            onSelect={setCount}
          />
          <SegmentedControl
            mode="tabs"
            label="разделы найденного"
            idBase="demo-found"
            panelId={(v) => `demo-found-panel-${v}`}
            value={section}
            items={[
              { value: "levels", label: "Уровни (6)", ariaLabel: "Уровни (6)" },
              { value: "figures", label: "Фигуры (1)" },
              { value: "patterns", label: "Паттерны (2)" },
            ]}
            onSelect={setSection}
          />
        </div>
        <p id={`demo-found-panel-${section}`} role="tabpanel" aria-labelledby={`demo-found-tab-${section}`} className="caption" style={{ margin: 0 }}>
          Раздел: {section === "levels" ? "уровни" : section === "figures" ? "фигуры" : "паттерны"}
        </p>
      </div>

      <div className={s.demoRow}>
        <span className="caption">IconButton · 32 px, под pointer: coarse — 44 px; нажатая, недоступная, ссылка</span>
        <div className={s.row}>
          <IconButton label="отдалить" onClick={() => setLog("отдалить")}>
            <IconMinus />
          </IconButton>
          <IconButton label="приблизить" onClick={() => setLog("приблизить")}>
            <IconPlus />
          </IconButton>
          <IconButton label="показать последние свечи" onClick={() => setLog("показать последние свечи")}>
            <IconToEnd />
          </IconButton>
          <IconButton label="Снимок" title="Снимок PNG с водяным знаком" onClick={() => setLog("Снимок")}>
            <IconCamera />
          </IconButton>
          <IconButton label="магнит к OHLC" pressed={magnet} onClick={() => setMagnet(!magnet)}>
            <IconMagnet />
          </IconButton>
          <IconButton label="отменить" disabled>
            <IconUndo />
          </IconButton>
          <IconButton label="повторить" disabled>
            <IconRedo />
          </IconButton>
          <IconButton label="Мультичарт" href="/multichart">
            <IconGrid />
          </IconButton>
          <IconButton label="приблизить" size="sm">
            <IconPlus />
          </IconButton>
        </div>
      </div>

      <div className={s.demoRow}>
        <span className="caption">Menu (стрелки, Home/End, буквы, Esc) и Popover (Esc, клик снаружи, фокус возвращается)</span>
        <div className={s.row}>
          <Menu
            items={menuItems}
            trigger={(p) => (
              <Button {...p} variant="ghost" aria-label={`Разметка: ${presetTitle}`}>
                <IconLayers /> {presetTitle} <IconChevronDown />
              </Button>
            )}
          />
          <Button {...view.triggerProps} variant="ghost">
            Вид <IconChevronDown />
          </Button>
          <Popover open={view.open} onClose={view.close} anchor={view.anchor} label="Вид" id={view.id} width={280}>
            <Select label="Тип графика" aria-label="тип графика" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="candles">Свечи</option>
              <option value="bars">Бары</option>
              <option value="line">Линия</option>
              <option value="heikin">Heikin Ashi</option>
            </Select>
            {type === "heikin" && <p className="caption">Паттерны и сигналы считаются по обычным свечам</p>}
          </Popover>
          <span className="caption" data-testid="ui-demo-log">
            последнее действие: {log}
          </span>
        </div>
      </div>

      <div className={s.demoRow}>
        <span className="caption">Подписи таймфреймов (TF_LABEL через t())</span>
        <div className={s.nums}>
          <span className="text-2">RU</span>
          <span>{TIMEFRAMES.map((x) => ru(TF_LABEL[x])).join(" ")}</span>
          <span className="text-2">EN</span>
          <span>{TIMEFRAMES.map((x) => en(TF_LABEL[x])).join(" ")}</span>
        </div>
      </div>
    </div>
  );
}
