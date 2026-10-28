"use client";

import { TOOL_TITLES, type Drawing, type DrawingType, type LiqMap, type SrLevel } from "@platform/charts";
import type React from "react";
import { useState } from "react";
import s from "./terminal.module.css";
import { AskBox, FiguresList, FoundList, LevelsList } from "./FoundPanel";
import { TEMPLATES } from "./templates";
import type { FigureOnChart, FigureStat, PatternOnChart, PatternStat } from "@/lib/chart";
import type { LayerKey, PanelKey } from "./TerminalView";
import { useT } from "@/i18n/client";
import { ToolIcon } from "./ToolIcon";
import type { ZoneGroup } from "@/lib/zones";

const TOOLS: { t: DrawingType; key?: string }[] = [
  { t: "hline", key: "Alt+H" },
  { t: "hray" },
  { t: "vline" },
  { t: "trend", key: "Alt+T" },
  { t: "ray" },
  { t: "extended" },
  { t: "channel" },
  { t: "rect" },
  { t: "fib" },
  { t: "position-long" },
  { t: "position-short" },
  { t: "note" },
  { t: "ruler" },
];

/** Левая панель инструментов (десктоп, план 3.17 / 2A.8). */
export function DrawToolbar({ tool, onTool, magnet, onMagnet, canUndo, canRedo, onUndo, onRedo }: { tool: DrawingType | null; onTool: (t: DrawingType | null) => void; magnet: boolean; onMagnet: (v: boolean) => void; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void }) {
  const t = useT();
  return (
    <div className={s.toolbar} role="toolbar" aria-label={t("панель рисования")}>
      {TOOLS.map((x) => (
        <button key={x.t} type="button" className={s.tool} aria-pressed={tool === x.t} title={`${TOOL_TITLES[x.t]}${x.key ? ` (${x.key})` : ""}`} aria-label={TOOL_TITLES[x.t]} onClick={() => onTool(tool === x.t ? null : x.t)}>
          <ToolIcon name={x.t} />
        </button>
      ))}
      <span className={s.toolSep} />
      <button type="button" className={s.tool} aria-pressed={magnet} title={t("Магнит к OHLC")} aria-label={t("магнит")} onClick={() => onMagnet(!magnet)}>
        <ToolIcon name="magnet" />
      </button>
      <button type="button" className={s.tool} disabled={!canUndo} title={t("Отменить (Ctrl+Z)")} aria-label={t("отменить")} onClick={onUndo}>
        <ToolIcon name="undo" />
      </button>
      <button type="button" className={s.tool} disabled={!canRedo} title={t("Повторить (Ctrl+Y)")} aria-label={t("повторить")} onClick={onRedo}>
        <ToolIcon name="redo" />
      </button>
    </div>
  );
}

type Props = {
  drawings: Drawing[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onLock: (id: string) => void;
  onRemove: (id: string) => void;
  layers: Record<LayerKey, boolean>;
  onLayer: (k: LayerKey) => void;
  panels: PanelKey[];
  onPanel: (k: PanelKey) => void;
  onTemplate: (id: string) => void;
  layouts: { name: string }[];
  onSaveLayout: (name: string) => void;
  onLoadLayout: (name: string) => void;
  onDeleteLayout: (name: string) => void;
  authed: boolean;
  layoutsLimit: number | null;
  /** Перетаскивание левого края панели (ширина хранится в TerminalPage). */
  onResize?: { start: (e: React.PointerEvent<HTMLElement>) => void; step: (delta: number) => void; active: boolean };
  found: { count?: number; items: PatternOnChart[]; stats: Record<string, PatternStat>; selected: number | null; onSelect: (id: number | null) => void; tf: string; symbol: string; canExplain: boolean; askAccess: "guest" | "plan" | "ok" | null; sr: SrLevel[]; liq: LiqMap | null; tick: string | null; zones: ZoneGroup[]; figures: FigureOnChart[]; figureStats: Record<string, FigureStat>; selectedFigure: number | null; onSelectFigure: (id: number | null) => void };
};

const LAYER_LABEL: Record<LayerKey, string> = { structure: "Структура", zones: "Зоны", levels: "Макс./мин. дня и недели", signals: "Сигналы", patterns: "Паттерны", figures: "Фигуры", volume_profile: "Профиль объёма", sr: "Поддержка и сопротивление", liq_map: "Карта ликвидаций (оценка)" };
const PANEL_LABEL: Record<PanelKey, string> = { funding: "Funding", oi: "Open interest", liq: "Ликвидации", ls: "L/S ratio" };

/** Правая панель объектов (десктоп): рисунки, слои, раскладки и шаблоны. */
export function ObjectsPanel(p: Props) {
  const t = useT();
  const [tab, setTab] = useState<"found" | "drawings" | "layers" | "layouts">("found");
  const [name, setName] = useState("");
  return (
    <aside className={s.objects} aria-label={t("панель объектов")}>
      {p.onResize && (
        <button
          type="button"
          className={s.splitter}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("ширина панели объектов")}
          title={t("Тяните, чтобы изменить ширину; ← → с клавиатуры")}
          data-active={p.onResize.active || undefined}
          onPointerDown={p.onResize.start}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") p.onResize!.step(20);
            else if (e.key === "ArrowRight") p.onResize!.step(-20);
            else return;
            e.preventDefault();
          }}
        />
      )}
      <div className={s.objTabs} role="tablist">
        {(["found", "drawings", "layers", "layouts"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={s.objTab} onClick={() => setTab(k)}>
            {k === "found" ? t("Найдено ({n})", { n: p.found.count ?? p.found.items.length + p.found.figures.length }) : k === "drawings" ? t("Рисунки ({n})", { n: p.drawings.length }) : k === "layers" ? t("Слои") : t("Раскладки")}
          </button>
        ))}
      </div>
      {tab === "found" && (
        <div className={s.objScroll}>
          <AskBox symbol={p.found.symbol} tf={p.found.tf} access={p.found.askAccess} />
          <LevelsList sr={p.found.sr} liq={p.found.liq} tick={p.found.tick} zones={p.found.zones} />
          <strong className={s.objHead}>{t("Фигуры")}</strong>
          <FiguresList items={p.found.figures} stats={p.found.figureStats} selected={p.found.selectedFigure} onSelect={p.found.onSelectFigure} />
          <strong className={s.objHead}>{t("Свечные паттерны")}</strong>
          <FoundList items={p.found.items} stats={p.found.stats} selected={p.found.selected} onSelect={p.found.onSelect} tf={p.found.tf} symbol={p.found.symbol} canExplain={p.found.canExplain} />
        </div>
      )}
      {tab === "drawings" && (
        <ul className={s.objList}>
          {p.drawings.length === 0 && <li className="caption">{t("Рисунков нет. Alt+H — линия, Alt+T — трендовая.")}</li>}
          {p.drawings.map((d) => (
            <li key={d.id} className={s.objRow} data-selected={d.id === p.selectedId || undefined}>
              <button type="button" className={s.objName} onClick={() => p.onSelect(d.id)}>
                {TOOL_TITLES[d.type]}
                {d.text ? ` · ${d.text}` : ""}
                <span className="caption"> {d.timeframe ?? t("все TF")}</span>
              </button>
              <button type="button" className={s.tool} aria-label={`${d.locked ? t("разблокировать") : t("заблокировать")} ${TOOL_TITLES[d.type]}`} title={d.locked ? t("Разблокировать") : t("Заблокировать")} onClick={() => p.onLock(d.id)}>
                {d.locked ? "🔒" : "🔓"}
              </button>
              <button type="button" className={s.tool} aria-label={`удалить ${TOOL_TITLES[d.type]}`} title={t("Удалить")} disabled={d.locked} onClick={() => p.onRemove(d.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {tab === "layers" && (
        <ul className={s.objList}>
          {(Object.keys(LAYER_LABEL) as LayerKey[]).map((k) => (
            <li key={k}>
              <label>
                <input type="checkbox" checked={p.layers[k]} onChange={() => p.onLayer(k)} /> {t(LAYER_LABEL[k])}
              </label>
            </li>
          ))}
          {(Object.keys(PANEL_LABEL) as PanelKey[]).map((k) => (
            <li key={k}>
              <label>
                <input type="checkbox" checked={p.panels.includes(k)} onChange={() => p.onPanel(k)} /> {t(PANEL_LABEL[k])}
              </label>
            </li>
          ))}
        </ul>
      )}
      {tab === "layouts" && (
        <div className={s.objList}>
          <strong>{t("Шаблоны индикаторов")}</strong>
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" className={s.chip} onClick={() => p.onTemplate(t.id)}>
              {t.title}
            </button>
          ))}
          <strong>{t("Мои раскладки")}</strong>
          {!p.authed && <span className="caption">{t("Войдите, чтобы сохранять раскладки.")}</span>}
          {p.layouts.map((l) => (
            <span key={l.name} className={s.objRow}>
              <button type="button" className={s.objName} onClick={() => p.onLoadLayout(l.name)}>
                {l.name}
              </button>
              <button type="button" className={s.tool} aria-label={t("удалить раскладку {name}", { name: l.name })} onClick={() => p.onDeleteLayout(l.name)}>
                ✕
              </button>
            </span>
          ))}
          {p.authed && (
            <form
              className={s.objRow}
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) {
                  p.onSaveLayout(name.trim());
                  setName("");
                }
              }}
            >
              <input aria-label={t("имя раскладки")} placeholder={t("имя раскладки")} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
              <button type="submit" className={s.chip} disabled={!name.trim() || (p.layoutsLimit !== null && p.layouts.length >= p.layoutsLimit)}>{t("Сохранить")}</button>
            </form>
          )}
          {p.layoutsLimit !== null && <span className="caption">лимит тарифа: {p.layoutsLimit}</span>}
        </div>
      )}
    </aside>
  );
}
