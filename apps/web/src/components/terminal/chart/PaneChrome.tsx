"use client";

import type { ChartStore } from "@platform/charts";
import { INTERACTION } from "@platform/charts";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { IconButton, Menu, Popover, usePopover } from "@/components/ui";
import { IconArrowDown, IconArrowUp, IconClose, IconGear, IconMaximize, IconMore, IconRestore, IconScaleVertical } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { MQ, useMediaQuery } from "@/lib/breakpoints";
import { IndicatorParams } from "../sheets/IndicatorParams";
import { PaneValue } from "./PaneValue";
import { paneSeparators, type ChartGeo, type PaneGeo, type PaneSep } from "./paneGeo";
import c from "./chart.module.css";

/**
 * Управление панелями графика (ADR-0009, «Управление панелями»; как в TradingView): поверх холста LWC —
 * заголовки панелей с кнопками «выше», «ниже», «развернуть / вернуть», «настройки», «убрать», границы панелей
 * с ручкой (перетаскивание — высота, двойной клик — высоты по умолчанию), кнопка «A» (автомасштаб) у шкалы цены,
 * растянутой вручную, подсветка шкалы под курсором и однократная подсказка. Геометрию считает ChartSurface
 * (координаты колонки графика, CSS px), действия выполняет он же: здесь только DOM и указатель.
 */

export type { ChartGeo, PaneGeo, PaneSep } from "./paneGeo";

export type ResizePhase = "start" | "move" | "end";

type Actions = {
  onCollapse: (key: string, collapsed: boolean) => void;
  onMove: (key: string, dir: -1 | 1) => void;
  onMaximize: (key: string | null) => void;
  onRemove?: (key: string) => void;
  onParams?: (uid: string, params: Record<string, number>) => void;
  onResize: (sep: PaneSep, dy: number, phase: ResizePhase) => void;
  onResetHeights: () => void;
  onAutoScale: (index: number) => void;
};

type Props = Actions & {
  /** Колонка графика (.chart): по движению указателя над ней — панель под курсором и шкала цены. */
  host: HTMLElement | null;
  store: ChartStore;
  geo: ChartGeo;
  maximized: string | null;
  /** Телефон и ячейка: действия панели — в меню «⋯» (в строку не помещаются). */
  compact: boolean;
  /** Подсказка «как управлять панелями» — один раз (терминал; мультичарт без панелей — нет). */
  hint: boolean;
  /** Заголовок основной панели, пока развёрнута другая. */
  mainTitle: string;
};

/** Ключ однократной подсказки (как уведомление о разметке). */
export const PANES_HINT_KEY = "pl-panes-hint";
const HINT_MS = 15_000;
/** Шаг границы стрелками с клавиатуры, px. */
const KEY_STEP_PX = 8;
/** Двойное касание границы (палец): два тапа не дальше этого по времени — высоты по умолчанию. */
const DOUBLE_TAP_MS = 350;

export function PaneChrome({ host, store, geo, maximized, compact, hint, mainTitle, ...act }: Props) {
  const t = useT();
  const coarse = useMediaQuery(MQ.coarse);
  const [hover, setHover] = useState<{ index: number; scale: boolean } | null>(null);
  const geoRef = useRef(geo);
  useEffect(() => {
    geoRef.current = geo;
  }, [geo]);

  // панель и шкала под курсором (мышь): кнопки заголовка и подсветка шкалы. Слушаем колонку целиком — и холст,
  // и сами заголовки: курсор на кнопке — всё ещё над своей панелью
  useEffect(() => {
    if (!host) return;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const g = geoRef.current;
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const p = g.panes.find((q) => y >= q.top && y < q.top + q.height);
      const next = p ? { index: p.index, scale: x >= g.plotW && x < g.plotW + g.scaleW && e.buttons === 0 } : null;
      setHover((h) => (h?.index === next?.index && h?.scale === next?.scale ? h : next));
    };
    const onLeave = () => setHover(null);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    return () => {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, [host]);

  const others = geo.panes.filter((p) => p.index > 0);
  const seps = paneSeparators(geo.panes, maximized !== null);
  const main = geo.panes[0];
  const hovered = hover ? geo.panes.find((p) => p.index === hover.index) : undefined;
  return (
    <>
      {maximized && main && (
        <div className={c.paneHead} data-collapsed data-main style={{ top: main.top }}>
          <span className={c.paneTitle}>{mainTitle}</span>
          <IconButton size="xs" className={c.paneBtn} label={t("вернуть панели")} onClick={() => act.onMaximize(null)}>
            <IconRestore />
          </IconButton>
        </div>
      )}
      {others.map((p, i) => (
        <PaneHeader key={p.key} pane={p} store={store} first={i === 0} last={i === others.length - 1} maximized={maximized} compact={compact} hover={hover?.index === p.index} {...act} />
      ))}
      {seps.map((sep) => (
        <Separator key={sep.key} sep={sep} coarse={coarse} width={geo.width} onResize={act.onResize} onReset={act.onResetHeights} />
      ))}
      {!coarse && hovered && hover?.scale && hovered.scalable && !hovered.collapsed && (
        <div className={c.scaleHover} data-testid="scale-hover" style={{ left: geo.plotW, top: hovered.top, width: geo.scaleW, height: hovered.height }} aria-hidden="true">
          <span className={c.scaleGrip}>
            <IconScaleVertical />
          </span>
        </div>
      )}
      {geo.panes
        .filter((p) => p.manual && !p.collapsed)
        .map((p) => (
          <div key={p.key} className={c.autoHost} style={{ left: geo.plotW, top: p.top + p.height, width: geo.scaleW }}>
            <IconButton size="xs" className={c.autoBtn} label={t("автомасштаб: {name}", { name: p.index === 0 ? t("цена") : p.title })} title={t("Вернуть автомасштаб (то же — двойной клик по шкале)")} onClick={() => act.onAutoScale(p.index)}>
              A
            </IconButton>
          </div>
        ))}
      {hint && others.length > 0 && seps[0] && <PanesHint y={seps[0].y} right={geo.width - geo.plotW} coarse={coarse} />}
    </>
  );
}

type HeaderProps = Actions & { pane: PaneGeo; store: ChartStore; first: boolean; last: boolean; maximized: string | null; compact: boolean; hover: boolean };

/**
 * Заголовок панели (24 px, под пальцем 44): имя цветом экземпляра, значения, «свернуть / развернуть» и действия.
 * Действия на десктопе — при наведении на панель и при фокусе с клавиатуры, под пальцем — всегда; на телефоне —
 * в меню «⋯». Свайп вниз по заголовку сворачивает панель, вверх — раскрывает (план 2A.7).
 */
function PaneHeader({ pane, store, first, last, maximized, compact, hover, onCollapse, onMove, onMaximize, onRemove, onParams }: HeaderProps) {
  const t = useT();
  const pop = usePopover();
  const swipe = useRef<number | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const name = pane.title;
  const isMax = maximized === pane.key;
  const canParams = !!(pane.inst && onParams);
  const maxLabel = isMax ? t("вернуть панели") : t("развернуть {name} на весь график", { name });
  const toggleMax = () => onMaximize(isMax ? null : pane.key);
  const toggle = (
    <IconButton size="xs" className={c.paneBtn} aria-expanded={!pane.collapsed} label={t(pane.collapsed ? "развернуть панель {name}" : "свернуть панель {name}", { name })} onClick={() => onCollapse(pane.key, !pane.collapsed)}>
      <span aria-hidden="true">{pane.collapsed ? "▴" : "▾"}</span>
    </IconButton>
  );
  return (
    <div
      ref={headRef}
      className={c.paneHead}
      data-collapsed={pane.collapsed || undefined}
      data-hover={hover || pop.open || undefined}
      data-testid={`pane-${pane.testId}`}
      style={{ top: pane.top }}
      onTouchStart={(e) => {
        swipe.current = e.touches[0]?.clientY ?? null;
      }}
      onTouchEnd={(e) => {
        const y0 = swipe.current;
        swipe.current = null;
        if (y0 === null) return;
        const dy = (e.changedTouches[0]?.clientY ?? y0) - y0;
        if (dy > INTERACTION.swipePx && !pane.collapsed) onCollapse(pane.key, true);
        else if (dy < -INTERACTION.swipePx && pane.collapsed) onCollapse(pane.key, false);
      }}
    >
      <span className={c.paneTitle} style={pane.color ? { color: pane.color } : undefined}>
        {name}
      </span>
      {pane.values && !pane.collapsed && <PaneValue store={store} uid={pane.key} compact={pane.compactValues} />}
      {toggle}
      {compact ? (
        <Menu
          label={t("действия с панелью {name}", { name })}
          align="start"
          trigger={(p) => (
            <IconButton size="xs" className={c.paneBtn} label={t("действия с панелью {name}", { name })} {...p}>
              <IconMore />
            </IconButton>
          )}
          items={[
            { id: "up", label: t("Выше"), disabled: first, onSelect: () => onMove(pane.key, -1) },
            { id: "down", label: t("Ниже"), disabled: last, onSelect: () => onMove(pane.key, 1) },
            { id: "max", label: isMax ? t("Вернуть панели") : t("Развернуть на весь график"), onSelect: toggleMax },
            // окно параметров — у заголовка: фокус, вернувшийся из меню на «⋯», остаётся внутри якоря
            ...(canParams ? [{ id: "params", label: t("Настройки"), onSelect: () => headRef.current && pop.toggle(headRef.current) }] : []),
            ...(onRemove ? [{ id: "remove", label: t("Убрать"), onSelect: () => onRemove(pane.key) }] : []),
          ]}
        />
      ) : (
        <span className={c.paneActions} data-open={pop.open || undefined}>
          <IconButton size="xs" className={c.paneBtn} label={t("переместить {name} выше", { name })} disabled={first} onClick={() => onMove(pane.key, -1)}>
            <IconArrowUp />
          </IconButton>
          <IconButton size="xs" className={c.paneBtn} label={t("переместить {name} ниже", { name })} disabled={last} onClick={() => onMove(pane.key, 1)}>
            <IconArrowDown />
          </IconButton>
          <IconButton size="xs" className={c.paneBtn} label={maxLabel} pressed={isMax} onClick={toggleMax}>
            {isMax ? <IconRestore /> : <IconMaximize />}
          </IconButton>
          {canParams && (
            <IconButton size="xs" className={c.paneBtn} {...pop.triggerProps} label={t("настроить {name}", { name })}>
              <IconGear />
            </IconButton>
          )}
          {onRemove && (
            <IconButton size="xs" className={c.paneBtn} label={t("убрать {name}", { name })} onClick={() => onRemove(pane.key)}>
              <IconClose />
            </IconButton>
          )}
        </span>
      )}
      {canParams && pane.inst && (
        <Popover open={pop.open} onClose={pop.close} anchor={pop.anchor} label={t("Параметры {name}", { name })} id={pop.id} width={240}>
          <div className={c.paramsPop}>
            <strong>{t("Параметры {name}", { name })}</strong>
            <IndicatorParams inst={pane.inst} onChange={onParams!} />
          </div>
        </Popover>
      )}
    </div>
  );
}

/**
 * Граница панелей: зона 9 px (под пальцем 44), курсор row-resize; при наведении и перетаскивании — линия --accent
 * и ручка по центру (под пальцем ручка видна всегда). Двойной клик — высоты по умолчанию; стрелки — шаг 8 px.
 */
function Separator({ sep, coarse, width, onResize, onReset }: { sep: PaneSep; coarse: boolean; width: number; onResize: Actions["onResize"]; onReset: () => void }) {
  const t = useT();
  const start = useRef<number | null>(null);
  const lastTap = useRef(0);
  const [active, setActive] = useState(false);
  const end = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const y0 = start.current;
      if (y0 === null) return;
      start.current = null;
      setActive(false);
      const dy = e.clientY - y0;
      onResize(sep, dy, "end");
      // палец: dblclick после касаний браузеры шлют не всегда — двойное касание считаем сами
      if (e.pointerType === "mouse" || Math.abs(dy) > INTERACTION.tapSlopPx) return;
      if (e.timeStamp - lastTap.current < DOUBLE_TAP_MS) {
        lastTap.current = 0;
        onReset();
      } else lastTap.current = e.timeStamp;
    },
    [onResize, onReset, sep],
  );
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const dy = e.key === "ArrowUp" ? -KEY_STEP_PX : e.key === "ArrowDown" ? KEY_STEP_PX : 0;
    if (dy) {
      e.preventDefault();
      onResize(sep, 0, "start");
      onResize(sep, dy, "end");
    } else if (e.key === "Enter" || e.key === "Home") {
      e.preventDefault();
      onReset();
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("граница панелей")}
      title={t("Потяните — высота панели. Двойной клик — высоты по умолчанию")}
      tabIndex={0}
      className={c.sep}
      data-active={active || undefined}
      data-coarse={coarse || undefined}
      data-testid="pane-separator"
      style={{ top: sep.y, width }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = e.clientY;
        setActive(true);
        onResize(sep, 0, "start");
      }}
      onPointerMove={(e) => {
        if (start.current !== null) onResize(sep, e.clientY - start.current, "move");
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
      onKeyDown={onKey}
    >
      <span className={c.sepLine} aria-hidden="true" />
      <span className={c.sepGrip} aria-hidden="true" />
    </div>
  );
}

/**
 * Однократная подсказка (как уведомление о разметке): когда появляется первая панель под графиком — плашка поверх
 * графика над первой границей, справа (не строка раскладки, клики проходят на график, кроме «закрыть»). Флаг
 * в localStorage ставится при показе; плашка исчезает сама через 15 с.
 */
function PanesHint({ y, right, coarse }: { y: number; right: number; coarse: boolean }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(PANES_HINT_KEY)) return;
      localStorage.setItem(PANES_HINT_KEY, "1");
    } catch {
      return;
    }
    queueMicrotask(() => setShown(true));
    const timer = setTimeout(() => setShown(false), HINT_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <div role="note" aria-label={t("Как управлять панелями")} className={c.panesHint} data-testid="panes-hint" style={{ top: y, right: right + 8 }}>
      <p className={c.panesHintText}>
        {coarse
          ? t("Потяните границу — высота панели. Потяните шкалу справа — растянуть по вертикали. «A» у шкалы — вернуть. Кнопки в заголовке панели — порядок, развернуть, убрать.")
          : t("Потяните границу — высота панели. Потяните шкалу справа — растянуть по вертикали. Двойной клик по шкале — вернуть. Кнопки в заголовке панели — порядок, развернуть, убрать.")}
      </p>
      <IconButton size="xs" className={c.panesHintClose} label={t("закрыть подсказку")} onClick={() => setShown(false)}>
        <IconClose />
      </IconButton>
    </div>
  );
}
