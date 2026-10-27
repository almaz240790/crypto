"use client";

import { TOOL_TITLES, type Drawing, type DrawingType } from "@platform/charts";
import type React from "react";
import { useState } from "react";
import s from "./terminal.module.css";
import { AskBox, FiguresList, FoundList } from "./FoundPanel";
import { TEMPLATES } from "./templates";
import type { FigureOnChart, FigureStat, PatternOnChart, PatternStat } from "@/lib/chart";
import type { LayerKey, PanelKey } from "./TerminalView";

const TOOLS: { t: DrawingType; k: string; key?: string }[] = [
  { t: "hline", k: "—", key: "Alt+H" },
  { t: "hray", k: "—›" },
  { t: "vline", k: "|" },
  { t: "trend", k: "╱", key: "Alt+T" },
  { t: "ray", k: "╱›" },
  { t: "extended", k: "‹╱›" },
  { t: "channel", k: "═" },
  { t: "rect", k: "▭" },
  { t: "fib", k: "Fib" },
  { t: "position-long", k: "L" },
  { t: "position-short", k: "S" },
  { t: "note", k: "T" },
  { t: "ruler", k: "⟷" },
];

/** Левая панель инструментов (десктоп, план 3.17 / 2A.8). */
export function DrawToolbar({ tool, onTool, magnet, onMagnet, canUndo, canRedo, onUndo, onRedo }: { tool: DrawingType | null; onTool: (t: DrawingType | null) => void; magnet: boolean; onMagnet: (v: boolean) => void; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void }) {
  return (
    <div className={s.toolbar} role="toolbar" aria-label="панель рисования">
      {TOOLS.map((x) => (
        <button key={x.t} type="button" className={s.tool} aria-pressed={tool === x.t} title={`${TOOL_TITLES[x.t]}${x.key ? ` (${x.key})` : ""}`} aria-label={TOOL_TITLES[x.t]} onClick={() => onTool(tool === x.t ? null : x.t)}>
          {x.k}
        </button>
      ))}
      <span className={s.toolSep} />
      <button type="button" className={s.tool} aria-pressed={magnet} title="Магнит к OHLC" aria-label="магнит" onClick={() => onMagnet(!magnet)}>
        ◎
      </button>
      <button type="button" className={s.tool} disabled={!canUndo} title="Отменить (Ctrl+Z)" aria-label="отменить" onClick={onUndo}>
        ↶
      </button>
      <button type="button" className={s.tool} disabled={!canRedo} title="Повторить (Ctrl+Y)" aria-label="повторить" onClick={onRedo}>
        ↷
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
  found: { count?: number; items: PatternOnChart[]; stats: Record<string, PatternStat>; selected: number | null; onSelect: (id: number | null) => void; tf: string; symbol: string; canExplain: boolean; figures: FigureOnChart[]; figureStats: Record<string, FigureStat>; selectedFigure: number | null; onSelectFigure: (id: number | null) => void };
};

const LAYER_LABEL: Record<LayerKey, string> = { structure: "Структура", zones: "Зоны", levels: "Уровни", signals: "Сигналы", patterns: "Паттерны", figures: "Фигуры", volume_profile: "Профиль объёма" };
const PANEL_LABEL: Record<PanelKey, string> = { funding: "Funding", oi: "Open interest", liq: "Ликвидации", ls: "L/S ratio" };

/** Правая панель объектов (десктоп): рисунки, слои, раскладки и шаблоны. */
export function ObjectsPanel(p: Props) {
  const [tab, setTab] = useState<"found" | "drawings" | "layers" | "layouts">("found");
  const [name, setName] = useState("");
  return (
    <aside className={s.objects} aria-label="панель объектов">
      {p.onResize && (
        <button
          type="button"
          className={s.splitter}
          role="separator"
          aria-orientation="vertical"
          aria-label="ширина панели объектов"
          title="Тяните, чтобы изменить ширину; ← → с клавиатуры"
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
        {(["found", "drawings", "layers", "layouts"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={s.objTab} onClick={() => setTab(t)}>
            {t === "found" ? `Найдено (${p.found.count ?? p.found.items.length + p.found.figures.length})` : t === "drawings" ? `Рисунки (${p.drawings.length})` : t === "layers" ? "Слои" : "Раскладки"}
          </button>
        ))}
      </div>
      {tab === "found" && (
        <>
          <strong className={s.objHead}>Фигуры</strong>
          <FiguresList items={p.found.figures} stats={p.found.figureStats} selected={p.found.selectedFigure} onSelect={p.found.onSelectFigure} />
          <strong className={s.objHead}>Свечные паттерны</strong>
          <FoundList items={p.found.items} stats={p.found.stats} selected={p.found.selected} onSelect={p.found.onSelect} tf={p.found.tf} symbol={p.found.symbol} canExplain={p.found.canExplain} />
          {p.found.canExplain && <AskBox symbol={p.found.symbol} tf={p.found.tf} />}
        </>
      )}
      {tab === "drawings" && (
        <ul className={s.objList}>
          {p.drawings.length === 0 && <li className="caption">Рисунков нет. Alt+H — линия, Alt+T — трендовая.</li>}
          {p.drawings.map((d) => (
            <li key={d.id} className={s.objRow} data-selected={d.id === p.selectedId || undefined}>
              <button type="button" className={s.objName} onClick={() => p.onSelect(d.id)}>
                {TOOL_TITLES[d.type]}
                {d.text ? ` · ${d.text}` : ""}
                <span className="caption"> {d.timeframe ?? "все TF"}</span>
              </button>
              <button type="button" className={s.tool} aria-label={`${d.locked ? "разблокировать" : "заблокировать"} ${TOOL_TITLES[d.type]}`} title={d.locked ? "Разблокировать" : "Заблокировать"} onClick={() => p.onLock(d.id)}>
                {d.locked ? "🔒" : "🔓"}
              </button>
              <button type="button" className={s.tool} aria-label={`удалить ${TOOL_TITLES[d.type]}`} title="Удалить" disabled={d.locked} onClick={() => p.onRemove(d.id)}>
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
                <input type="checkbox" checked={p.layers[k]} onChange={() => p.onLayer(k)} /> {LAYER_LABEL[k]}
              </label>
            </li>
          ))}
          {(Object.keys(PANEL_LABEL) as PanelKey[]).map((k) => (
            <li key={k}>
              <label>
                <input type="checkbox" checked={p.panels.includes(k)} onChange={() => p.onPanel(k)} /> {PANEL_LABEL[k]}
              </label>
            </li>
          ))}
        </ul>
      )}
      {tab === "layouts" && (
        <div className={s.objList}>
          <strong>Шаблоны индикаторов</strong>
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" className={s.chip} onClick={() => p.onTemplate(t.id)}>
              {t.title}
            </button>
          ))}
          <strong>Мои раскладки</strong>
          {!p.authed && <span className="caption">Войдите, чтобы сохранять раскладки.</span>}
          {p.layouts.map((l) => (
            <span key={l.name} className={s.objRow}>
              <button type="button" className={s.objName} onClick={() => p.onLoadLayout(l.name)}>
                {l.name}
              </button>
              <button type="button" className={s.tool} aria-label={`удалить раскладку ${l.name}`} onClick={() => p.onDeleteLayout(l.name)}>
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
              <input aria-label="имя раскладки" placeholder="имя раскладки" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
              <button type="submit" className={s.chip} disabled={!name.trim() || (p.layoutsLimit !== null && p.layouts.length >= p.layoutsLimit)}>
                Сохранить
              </button>
            </form>
          )}
          {p.layoutsLimit !== null && <span className="caption">лимит тарифа: {p.layoutsLimit}</span>}
        </div>
      )}
    </aside>
  );
}
