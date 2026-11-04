"use client";

import type { ChartStore } from "@platform/charts";
import { INTERACTION, separatorRange } from "@platform/charts";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { IconButton, Menu, Popover, usePopover } from "@/components/ui";
import { IconArrowDown, IconArrowUp, IconClose, IconGear, IconMaximize, IconMore, IconRestore } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { MQ, useMediaQuery } from "@/lib/breakpoints";
import { plural } from "@/lib/format";
import { IndicatorParams } from "../sheets/IndicatorParams";
import { PaneValue } from "./PaneValue";
import { autoBox, gripBox, groupCovers, paneSeparators, PANE_UI, sepAbove, type ChartGeo, type PaneGeo, type PaneSep } from "./paneGeo";
import c from "./chart.module.css";

/**
 * Управление панелями графика (ADR-0009, «Управление панелями»; как в TradingView): поверх холста LWC —
 * заголовки панелей с кнопками «выше», «ниже», «развернуть / вернуть», «настройки», «убрать», границы панелей
 * с ручкой (перетаскивание — высота, двойной клик — высоты по умолчанию), кнопка «A» (автомасштаб) в углу панели
 * у шкалы цены, растянутой вручную, полоса у шкалы под курсором и однократная подсказка. Строк на все панели не
 * хватает (planPanes) — свёрнутые в одной строке «ещё N панелей» с кнопками раскрытия, их полоски закрыты заслонками.
 * Геометрию считает ChartSurface (координаты колонки графика, CSS px), действия выполняет он же: здесь только DOM и
 * указатель. Слои: заголовки, общая строка и заслонки — 5, граница с ручкой — 6 (линию и ручку заголовок не
 * закрывает), открытое меню заголовка — 8.
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

  // подсказка на экране (десктоп): кнопки первой панели видны, пока она о них говорит
  const [hintOn, setHintOn] = useState(false);
  const others = geo.panes.filter((p) => p.index > 0);
  const seps = paneSeparators(geo.panes, maximized !== null);
  const main = geo.panes[0];
  const hovered = hover ? geo.panes.find((p) => p.index === hover.index) : undefined;
  const heights: number[] = [];
  for (const p of geo.panes) heights[p.index] = p.height;
  const grip = gripBox(geo.plotW, coarse);
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
      {groupCovers(geo.panes).map((cv) => (
        <div key={cv.key} className={c.paneCover} data-pane-cover="" aria-hidden="true" style={{ top: cv.top, height: cv.height }} />
      ))}
      {others.map((p, i) =>
        p.group ? (
          <PaneGroupRow key={p.key} pane={p} reserve={Math.max(PANE_UI.edge, geo.width - grip.left)} onCollapse={act.onCollapse} />
        ) : p.grouped ? null : (
          <PaneHeader key={p.key} pane={p} store={store} first={i === 0} last={i === others.length - 1} maximized={maximized} compact={compact} hover={hover?.index === p.index || (i === 0 && hintOn && !compact)} {...act} />
        ),
      )}
      {seps.map((sep) => (
        <Separator key={sep.key} sep={sep} range={separatorRange(heights, sep.above, sep.below, geo.limits)} coarse={coarse} width={geo.width} plotW={geo.plotW} onResize={act.onResize} onReset={act.onResetHeights} />
      ))}
      {/* шкала под курсором: её можно тянуть — полоса --accent по её левому краю, без заливки (метки не бледнеют) */}
      {!coarse && hovered && hover?.scale && hovered.scalable && !hovered.collapsed && <div className={c.scaleHover} data-testid="scale-hover" style={{ left: geo.plotW, top: hovered.top, width: geo.scaleW, height: hovered.height }} aria-hidden="true" />}
      {geo.panes
        .filter((p) => p.manual && !p.collapsed)
        .map((p) => {
          const box = autoBox(p, geo.plotW, coarse);
          return (
            <div key={p.key} className={c.autoHost} data-testid={`auto-${p.testId}`} style={{ left: box.left, top: box.top, width: box.size, height: box.size }}>
              <IconButton size="xs" className={c.autoBtn} label={t("автомасштаб: {name}", { name: p.index === 0 ? t("цена") : p.title })} title={t("Вернуть автомасштаб (то же — двойной клик по шкале)")} onClick={() => act.onAutoScale(p.index)}>
                A
              </IconButton>
            </div>
          );
        })}
      {hint && others.length > 0 && seps[0] && <PanesHint y={seps[0].y - sepAbove(coarse)} right={geo.width - grip.left - grip.w} coarse={coarse} compact={compact} onShown={setHintOn} />}
    </>
  );
}

/**
 * Общая строка свёрнутых панелей (строк на все панели не хватает, planPanes): «ещё N панелей» и кнопка раскрытия
 * на каждую (её data-pane — testid панели). Высота — строка заголовка host (24 px, под пальцем 44). Справа место
 * под ручку границы и «A» (reserve): ручка 44 × 44 не ложится на кнопки. Кнопка раскрывает панель, выходя из
 * «развернуть»; панель раскрыта последней — при нехватке строк сворачиваются раньше раскрытые.
 */
function PaneGroupRow({ pane, reserve, onCollapse }: { pane: PaneGeo; reserve: number; onCollapse: Actions["onCollapse"] }) {
  const t = useT();
  const group = pane.group ?? [];
  const n = group.length;
  return (
    <div className={c.paneGroup} data-testid="pane-group" role="group" aria-label={t("свёрнутые панели")} style={{ top: pane.top, height: pane.height, paddingRight: reserve }}>
      <span className={c.paneGroupLabel}>{t(plural(n, "ещё {n} панель", "ещё {n} панели", "ещё {n} панелей"), { n })}</span>
      <span className={c.paneGroupList}>
        {group.map((g) => (
          <button key={g.key} type="button" className={c.paneChip} data-pane={g.testId} aria-expanded={false} aria-label={t("развернуть панель {name}", { name: g.title })} title={t("развернуть панель {name}", { name: g.title })} onClick={() => onCollapse(g.key, false)}>
            {g.title} <span aria-hidden="true">▴</span>
          </button>
        ))}
      </span>
    </div>
  );
}

type HeaderProps = Actions & { pane: PaneGeo; store: ChartStore; first: boolean; last: boolean; maximized: string | null; compact: boolean; hover: boolean };

/**
 * Заголовок панели (24 px, под пальцем 44): имя цветом экземпляра, «свернуть / развернуть», действия и значения.
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
      {/* кнопки — сразу за именем и ▾, значения — после них: ширина значений меняется с перекрестием, а цели
          под курсором не сдвигаются (как в TradingView) */}
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
      {pane.values && !pane.collapsed && <PaneValue store={store} uid={pane.key} compact={pane.compactValues} />}
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
 * Граница панелей (ADR-0009): зона над линией — в нижней полосе верхней раскрытой панели (8 px, под пальцем 12), так
 * её не закрывает заголовок панели ниже; ручка — у правого края области графика, левее «A» (32 × 12, под пальцем
 * зона касания 44 × 44 и ручка видна всегда), поверх заголовков. Курсор — куда граница может пойти: row-resize,
 * n-resize (только вверх), s-resize (только вниз); стоит (основная на своей доле при сжатых окном панелях) — без
 * ручки и пропускает указатель к графику. Двойной клик (двойное касание) — высоты по умолчанию; стрелки — шаг 8 px.
 */
function Separator({ sep, range, coarse, width, plotW, onResize, onReset }: { sep: PaneSep; range: readonly [number, number]; coarse: boolean; width: number; plotW: number; onResize: Actions["onResize"]; onReset: () => void }) {
  const t = useT();
  const start = useRef<number | null>(null);
  const lastTap = useRef(0);
  const [active, setActive] = useState(false);
  const above = sepAbove(coarse);
  const grip = gripBox(plotW, coarse);
  const [up, down] = range;
  const dir = up < 0 && down > 0 ? "both" : up < 0 ? "up" : down > 0 ? "down" : "none";
  const locked = dir === "none";
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
      aria-disabled={locked || undefined}
      title={locked ? undefined : t("Потяните — высота панели. Двойной клик — высоты по умолчанию")}
      tabIndex={locked ? -1 : 0}
      className={c.sep}
      data-dir={dir}
      data-active={active || undefined}
      data-coarse={coarse || undefined}
      data-testid="pane-separator"
      style={{ top: sep.y - above, height: above + PANE_UI.sepBelow, width }}
      onPointerDown={(e) => {
        if (e.button !== 0 || locked) return;
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
      <span className={c.sepLine} style={{ top: above - 1 }} aria-hidden="true" />
      <span className={c.sepGrip} data-testid="pane-grip" style={{ left: grip.left, top: above - grip.h / 2, width: grip.w, height: grip.h }} aria-hidden="true" />
    </div>
  );
}

/**
 * Однократная подсказка (как уведомление о разметке): когда появляется первая панель под графиком — плашка поверх
 * графика над первой границей, справа над её ручкой (не строка раскладки, клики проходят на график, кроме «закрыть»).
 * Флаг в localStorage ставится при показе; плашка исчезает сама через 15 с. Текст называет, где кнопки: на десктопе
 * они появляются при наведении (и пока видна подсказка — у первой панели), под пальцем видны всегда, на телефоне —
 * в меню «⋯».
 */
function PanesHint({ y, right, coarse, compact, onShown }: { y: number; right: number; coarse: boolean; compact: boolean; onShown: (on: boolean) => void }) {
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
  useEffect(() => {
    onShown(shown);
    return () => onShown(false);
  }, [shown, onShown]);
  if (!shown) return null;
  const buttons = compact ? t("Кнопка «⋯» в заголовке панели — порядок, развернуть, убрать.") : coarse ? t("Кнопки в заголовке панели — порядок, развернуть, убрать.") : t("Наведите на панель — в её заголовке кнопки: порядок, развернуть, убрать.");
  return (
    <div role="note" aria-label={t("Как управлять панелями")} className={c.panesHint} data-testid="panes-hint" style={{ top: y, right }}>
      <p className={c.panesHintText}>{[t("Потяните границу — высота панели."), t("Потяните шкалу справа — растянуть по вертикали."), coarse ? t("«A» у шкалы — вернуть.") : t("Двойной клик по шкале — вернуть."), buttons].join(" ")}</p>
      <IconButton size="xs" className={c.panesHintClose} label={t("закрыть подсказку")} onClick={() => setShown(false)}>
        <IconClose />
      </IconButton>
    </div>
  );
}
