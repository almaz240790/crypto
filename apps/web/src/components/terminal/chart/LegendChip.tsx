"use client";

import type { ChartState, ChartStore, LegendEntry } from "@platform/charts";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useT } from "@/i18n/client";
import { MQ, useMediaQuery } from "@/lib/breakpoints";
import { useChartStore } from "./useChartStore";
import c from "./chart.module.css";

const selectLegend = (s: ChartState) => s.legend;
const selectLiqUnavailable = (s: ChartState) => s.sceneIndex?.liqUnavailable ?? false;
const selectDevice = (s: ChartState) => s.status.device;
/** Зазор от низа окна «?» до края экрана, px. */
const DIALOG_EDGE_PX = 8;

/**
 * Слой карты ликвидаций включён, а на этом таймфрейме её нет (покрытие OI ниже порога): короткая пометка рядом
 * с «?» — иначе пресет «Карта ликвидаций» выглядит как пустой (план 2B.2, M05). Причину называют «Найдено» и
 * строка пресета в «Слоях»; пометка короткая, чтобы на телефоне не заходить на шкалу цены.
 */
export function LiqUnavailableNote({ store, on, inline = false }: { store: ChartStore; on: boolean; inline?: boolean }) {
  const unavailable = useChartStore(selectLiqUnavailable, store);
  const t = useT();
  if (!on || !unavailable) return null;
  return (
    <p className={inline ? c.liqNoteInline : c.liqNote} data-testid="chart-liq-unavailable">
      {t("Карты ликвидаций на этом таймфрейме нет")}
    </p>
  );
}

/**
 * Легенда «?» (план 2B.2, §9): кнопка в левом верхнем углу панели цены (на десктопе — в строке легенды графика,
 * inline) и окно «Что на графике» — по строке
 * на каждый вид разметки, который сейчас на графике (scene.legend), и две постоянные: «Цена» и «Выделение».
 * Слово и пояснение — из chartText (t()), образец — цветом тона (--chart-*). Закрывается по Esc и клику снаружи.
 * Ниже — «Как управлять графиком» (ADR-0009, «Управление панелями»): масштаб, сдвиг, шкала цен, границы и кнопки панелей.
 */
export function LegendChip({ store, inline = false }: { store: ChartStore; inline?: boolean }) {
  const legend = useChartStore(selectLegend, store);
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  const [room, setRoom] = useState<number | null>(null);

  // окно «?» — не ниже экрана: высота — до низа окна браузера от его верха (на 932×430 последняя строка «Как управлять
  // графиком» уходила за край и не прокручивалась), дальше — прокрутка внутри окна
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = dialog.current;
      if (!el) return;
      const h = window.visualViewport?.height ?? window.innerHeight;
      setRoom(Math.max(120, Math.floor(h - el.getBoundingClientRect().top - DIALOG_EDGE_PX)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  return (
    <div ref={box} className={inline ? c.legendBoxInline : c.legendBox}>
      <button type="button" className={c.legendChip} aria-label={t("что на графике")} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        ?
      </button>
      {open && (
        <div ref={dialog} id={id} role="dialog" aria-label={t("Что на графике")} className={c.legendDialog} style={room === null ? undefined : ({ "--dialog-room": `${room}px` } as CSSProperties)}>
          <strong className={c.legendHead}>{t("Что на графике")}</strong>
          <ul className={c.legendList}>
            {legend.map((e) => (
              <li key={e.key} className={c.legendItem} data-key={e.key}>
                <Sample entry={e} />
                <span className={c.legendWord}>{e.text}</span>
                <span className={c.legendExplain}>{e.explain}</span>
              </li>
            ))}
          </ul>
          <ChartHelp store={store} />
        </div>
      )}
    </div>
  );
}

/**
 * «Как управлять графиком»: жест — что делает; под пальцем — касания вместо колеса и двойного клика. Кнопки панели
 * названы там, где их видно: на десктопе — при наведении на панель, под пальцем — всегда, на телефоне — в «⋯».
 */
function ChartHelp({ store }: { store: ChartStore }) {
  const t = useT();
  const coarse = useMediaQuery(MQ.coarse);
  const compact = useChartStore(selectDevice, store) !== "desktop";
  const rows: [string, string][] = [
    [coarse ? t("Щипок") : t("Колесо мыши или щипок"), t("масштаб по времени")],
    [t("Перетаскивание графика"), t("сдвиг; если шкалу цен растянули — и по вертикали")],
    [t("Шкала цен справа"), t("потяните вверх или вниз — вертикальный масштаб")],
    [coarse ? t("«A» или двойное касание шкалы") : t("«A» или двойной клик по шкале"), t("вернуть автомасштаб")],
    [t("Граница между панелями"), coarse ? t("потяните — высота панели; двойное касание — высоты по умолчанию") : t("потяните — высота панели; двойной клик — высоты по умолчанию")],
    [compact ? t("Кнопка «⋯» в заголовке панели") : coarse ? t("Кнопки в заголовке панели") : t("Кнопки в заголовке панели (при наведении)"), t("выше, ниже, развернуть на весь график, настройки, убрать")],
  ];
  if (!coarse) rows.push([t("Горячие клавиши"), t("в меню «⋯» на панели инструментов")]);
  return (
    <section className={c.legendSection} aria-label={t("Как управлять графиком")}>
      <strong className={c.legendHead}>{t("Как управлять графиком")}</strong>
      <dl className={c.helpList}>
        {rows.map(([word, explain]) => (
          <div key={word} className={c.helpRow}>
            <dt className={c.helpWord}>{word}</dt>
            <dd className={c.helpExplain}>{explain}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Образец вида: линия, пунктир, коробка, значок, тепловая полоса — цветом тона через currentColor. */
function Sample({ entry }: { entry: LegendEntry }) {
  const color = { color: `var(--chart-${entry.tone})` };
  const svg = (children: ReactNode) => (
    <svg className={c.legendSample} style={color} width="24" height="14" viewBox="0 0 24 14" aria-hidden="true">
      {children}
    </svg>
  );
  switch (entry.mark) {
    case "price":
      return svg(<rect x="2" y="2" width="20" height="10" rx="2" fill="currentColor" />);
    case "line":
      return svg(<line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" strokeWidth="1.5" />);
    case "dashed":
      return svg(<line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />);
    case "dotted":
      return svg(<line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1 3" />);
    case "box":
      return svg(<rect x="2" y="2" width="20" height="10" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1" />);
    case "heat":
      return svg(
        <>
          <rect x="10" y="1" width="13" height="3" fill="currentColor" fillOpacity="0.35" />
          <rect x="4" y="5.5" width="19" height="3" fill="currentColor" fillOpacity="0.8" />
          <rect x="14" y="10" width="9" height="3" fill="currentColor" fillOpacity="0.2" />
        </>,
      );
    case "glyph":
      return svg(entry.key === "sweep" ? <circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" /> : <path d="M12 2 L17 11 L7 11 Z" fill="currentColor" />);
    default:
      // выделение: ореол и линия толщиной 2
      return svg(
        <>
          <line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" strokeWidth="6" strokeOpacity="0.25" />
          <line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" strokeWidth="2" />
        </>,
      );
  }
}
