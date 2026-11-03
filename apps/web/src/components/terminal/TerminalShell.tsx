"use client";

import { CHART_TYPES, INDICATORS, TOOL_TITLES, createChartStore, formatCountdown, positionStats, secondsToClose, type Candle, type ChartType, type DrawingType, type ScaleMode, type Timeframe } from "@platform/charts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getAccessToken } from "@/lib/auth-client";
import { INTRADAY, TIMEFRAMES } from "@/lib/timeframes";
import { formatPct, formatPrice } from "@/lib/format";
import type { Instrument } from "@/lib/user";
import s from "./terminal.module.css";
import { BottomSheet } from "./BottomSheet";
import { DrawToolbar, ObjectsPanel } from "./DesktopPanels";
import { AskBox, FiguresList, FoundList, LevelsList } from "./FoundPanel";
import { download } from "./snapshot";
import { ChartSurface, IND_COLOR_VAR, PANELS, indicatorColor, type CrosshairInfo, type TerminalControls } from "./chart/ChartSurface";
import { ChartStoreContext, useChartStore } from "./chart/useChartStore";
import { MarkupPicker } from "./MarkupPicker";
import { LAYER_LABEL, layerKeysFor } from "./DesktopPanels";
import { useTerminalSettings } from "./state/useTerminalSettings";
import { useChartAlerts } from "./state/useChartAlerts";
import { useLayouts } from "./state/useLayouts";
import { useTerminalUi } from "./state/useTerminalUi";
import { useInstruments } from "./state/useInstruments";
import { usePlan } from "./state/usePlan";
import { useDrawings } from "./useDrawings";
import { getCandles, toCandle } from "@/lib/chart";
import { useTerminalData } from "./useTerminalData";
import { useT } from "@/i18n/client";
import { formatCompactValue, formatIndicatorValue } from "@platform/charts";

const TYPE_LABEL: Record<ChartType, string> = { candles: "Свечи", bars: "Бары", line: "Линия", heikin: "Heikin Ashi" };
const TOOLS: DrawingType[] = ["hline", "hray", "vline", "trend", "ray", "extended", "channel", "rect", "fib", "position-long", "position-short", "note", "ruler"];

/** Однократное уведомление о новой разметке после миграции сохранения v4 и раньше (ADR-0008). */
const MARKUP_NOTICE_KEY = "pl-markup-notice";
const NOTICE_MS = 8000;
const SCALE_LABEL: Record<ScaleMode, string> = { linear: "линейная", log: "логарифмическая", percent: "проценты" };

/** Тренд старшего таймфрейма простыми словами. */
const TREND_WORD: Record<string, string> = { up: "вверх", down: "вниз", flat: "боковик" };
const TREND_TONE: Record<string, string> = { up: "up", down: "down" };

/**
 * Терминал одного инструмента (план 2B.9): сетка страницы. Создаёт хранилище графика (ChartStore) и держит
 * handle графика; состояние — в хуках state/* (настройки, алерты, раскладки, интерфейс, инструменты, тариф).
 */
export function TerminalShell({ symbol, tf }: { symbol: string; tf: Timeframe }) {
  const t = useT();
  const router = useRouter();
  const { user } = useAuth();
  const authed = !!user;
  /** Состояние графика (сцена, выбор, видимая часть) — для листовых компонентов и «Найдено». */
  const [store] = useState(createChartStore);
  const instruments = useInstruments();
  const { sheet, setSheet, closeSheet, ohlcMore, setOhlcMore, bars, setBars, objects, setObjects, objW, objResize, toast, say, notifyOnce } = useTerminalUi();
  // вопросы о графике — Premium (админы и владелец — всегда); тариф узнаём один раз после входа
  const { askAccess } = usePlan();
  const { st, resolved, legacyFound, patch, toggleIndicator, togglePanel, toggleLayer, selectMarkup, applyTemplate, applyLayout } = useTerminalSettings(authed);
  const { alerts, alertLines, draft: alertDraft, setDraft: setAlertDraft, resetDraft, addPriceAlert } = useChartAlerts({ symbol, authed, say, onCreated: closeSheet });
  const { layouts, saveLayout, loadLayout, removeLayout } = useLayouts({ authed, symbol, tf, current: st, applyLayout, say });
  // выбор паттерна и фигуры — общий с графиком: id объекта сцены в хранилище («pat:<id>», «fig:<id>»)
  const selection = useChartStore((x) => x.selection, store);
  const foundSel = selection?.startsWith("pat:") ? Number(selection.slice(4)) : null;
  const figureSel = selection?.startsWith("fig:") ? Number(selection.slice(4)) : null;
  const setFoundSel = useCallback((id: number | null) => store.select(id === null ? null : `pat:${id}`), [store]);
  const setFigureSel = useCallback((id: number | null) => store.select(id === null ? null : `fig:${id}`), [store]);
  const [cross, setCross] = useState<CrosshairInfo | null>(null);
  const controls = useRef<TerminalControls | null>(null);
  const onReady = useCallback((c: TerminalControls | null) => {
    controls.current = c;
  }, []);
  // строка «Найдено → Уровни»: выбрать объект на графике и показать его, если он за кадром; повторно — снять
  const pickLevel = useCallback(
    (id: string | null) => {
      if (id === null) store.select(null);
      else controls.current?.focus({ objectId: id });
    },
    [store],
  );
  const visibleFrom = useChartStore((x) => x.visible.fromTime, store);
  // каталог сцены: «Найдено → Уровни» и пояснение «нет данных OI» — независимо от слоёв
  const sceneIndex = useChartStore((x) => x.sceneIndex, store);
  const areaRef = useRef<HTMLDivElement>(null);
  const dr = useDrawings(symbol, authed);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const data = useTerminalData(symbol, tf, user ? getAccessToken() : null);
  // «Найдено»: значимые паттерны и неотменённые фигуры на видимом участке
  const foundCount = (data.patterns?.items ?? []).filter((p) => p.significant && (visibleFrom === null || p.t >= visibleFrom)).length + (data.figures?.items ?? []).filter((f) => f.status !== "invalidated" && (visibleFrom === null || f.end_t >= visibleFrom)).length;

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") {
        store.select(null);
        dr.setTool(null);
        dr.setDraft(null);
        dr.actions.select(null);
      } else if (e.altKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        dr.setTool("hline");
      } else if (e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        dr.setTool("trend");
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "+" || e.key === "=")) {
        controls.current?.zoom(1.25);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === "-") {
        controls.current?.zoom(0.8);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-7]$/.test(e.key)) {
        const t = TIMEFRAMES[Number(e.key) - 1];
        if (t) router.push(`/chart/${symbol}/${t}`);
      } else if ((e.key === "Delete" || e.key === "Backspace") && dr.selected && !dr.selected.locked) dr.actions.remove(dr.selected.id);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) dr.actions.undo();
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) dr.actions.redo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dr, router, symbol, store]);
  // сохранение старше v5 сброшено на «Чистый»: один раз объясняем, где прежний вид
  useEffect(() => {
    if (legacyFound) notifyOnce(MARKUP_NOTICE_KEY, t("Разметка графика обновлена: по умолчанию «Чистый». Прежний вид — «Подробный» в «Разметке»."), NOTICE_MS);
  }, [legacyFound, t, notifyOnce]);
  const openAlertSheet = () => {
    resetDraft(price);
    setSheet("alert");
  };
  const snapshot = () => {
    const c = controls.current;
    if (!c) return say(t("график ещё не готов"));
    // снимок собирает график (handle.snapshot): кадр LWC с разметкой, подпись сверху и водяной знак снизу
    const url = c.snapshot(`${symbol} · ${tf === "4h" ? "H4" : tf.toUpperCase()} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, `PlatformSol · ${window.location.href} · ${t("не является инвестиционной рекомендацией")}`);
    if (url) download(url, `platform-${symbol}-${tf}-${Date.now()}.png`);
  };

  // наложенный инструмент (план 2A.3 v2): закрытые свечи цели на том же таймфрейме
  const [overlayCandles, setOverlayCandles] = useState<Candle[] | null>(null);
  const overlaySymbol = st.overlay && st.overlay !== symbol ? st.overlay : null;
  useEffect(() => {
    if (!overlaySymbol) {
      queueMicrotask(() => setOverlayCandles(null));
      return;
    }
    let dead = false;
    getCandles(overlaySymbol, tf)
      .then((r) => !dead && setOverlayCandles(r.candles.filter((c) => !c.open).map(toCandle)))
      .catch(() => !dead && setOverlayCandles(null));
    return () => {
      dead = true;
    };
  }, [overlaySymbol, tf]);
  const last = data.current ?? data.candles?.[data.candles.length - 1] ?? null;
  const prevClose = data.candles && data.candles.length > 1 ? data.candles[data.candles.length - (data.current ? 1 : 2)]!.close : null;
  const price = data.price ? Number(data.price) : last?.close ?? null;
  const change = price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;
  // копия рисунка на другой инструмент (план 2A.5): цены пропорционально последней цене цели
  const copyDrawing = async (id: string, target: string) => {
    let ratio = 1;
    try {
      const r = await getCandles(target, tf);
      const lastClose = Number((r.current ?? r.candles[r.candles.length - 1])?.c);
      if (price && lastClose > 0) ratio = lastClose / price;
    } catch {
      say(t("Не удалось получить цену {symbol}", { symbol: target }));
      return;
    }
    const copy = dr.actions.copyTo(id, target, ratio);
    if (copy) say(`${t("Рисунок скопирован на {symbol}", { symbol: target })}${ratio !== 1 ? t(" (цены пропорционально)") : ""}`);
  };
  const countdown = last ? secondsToClose(tf, last.time, now) : null;
  const intradayLocked = !user || (data.error ?? "").includes(t("тарифе"));
  const bias = data.layers?.structure?.bias;

  const indicatorIds = useMemo(() => new Set(st.indicators.map((i) => i.id)), [st.indicators]);
  const sel = dr.selected;
  const pos = useMemo(() => {
    if (!sel || !sel.type.startsWith("position") || sel.points.length < 3) return null;
    const risk = user?.risk;
    const profile = risk?.deposit ? { deposit: Number(risk.deposit), riskPct: Number(risk.risk_pct) } : null;
    return positionStats(sel.type === "position-long" ? "long" : "short", sel.points[0]!.price, sel.points[1]!.price, sel.points[2]!.price, profile);
  }, [sel, user]);
  const drawingsProps = useMemo(
    () => ({
      state: dr.state,
      tool: dr.tool,
      magnet: dr.magnet,
      draft: dr.draft,
      onCreate: dr.actions.create,
      onMove: dr.actions.move,
      onSelect: dr.actions.select,
      onDraft: dr.setDraft,
      onToolDone: () => {
        /* инструмент остаётся выбранным для серии рисунков; Esc — выход */
      },
    }),
    [dr.state, dr.tool, dr.magnet, dr.draft, dr.actions, dr.setDraft],
  );


  // карточка перекрестия: цены — по шагу цены инструмента (как шкала), объём — компактно, индикаторы панелей — значениями
  const fmtP = (v: number | null) => (v == null ? "—" : formatPrice(v, data.tick));
  const fmtV = (v: { value: number | null; price: boolean }) => (v.value == null ? "—" : v.price ? formatPrice(v.value, data.tick) : formatIndicatorValue(v.value));
  return (
    <ChartStoreContext.Provider value={store}>
    <div className={s.page} data-bars={bars}>
      <button type="button" className={`${s.chip} ${s.fsBtn}`} onClick={() => setBars(bars === "shown" ? "hidden" : "shown")} aria-label={bars === "shown" ? t("скрыть панели") : t("показать панели")}>
        {bars === "shown" ? "⤢" : "⤡"}
      </button>
      <div className={s.top}>
        <select aria-label={t("инструмент")} value={symbol} onChange={(e) => router.push(`/chart/${e.target.value}/${tf}`)}>
          {(instruments.length ? instruments : [{ symbol } as Instrument]).map((i) => (
            <option key={i.symbol} value={i.symbol}>
              {i.symbol}
            </option>
          ))}
        </select>
        <nav className={s.tfs} aria-label={t("таймфрейм")}>
          {TIMEFRAMES.map((x) => (
            <Link key={x} href={`/chart/${symbol}/${x}`} aria-current={x === tf ? "page" : undefined} data-primary={x === "4h"} aria-disabled={INTRADAY.includes(x) && !user ? "true" : undefined} title={INTRADAY.includes(x) && !user ? t("после входа, подписка Pro") : undefined}>
              {x === "4h" ? "H4" : x.toUpperCase()}
            </Link>
          ))}
        </nav>
        <button type="button" className={s.chip} onClick={() => controls.current?.zoom(1.25)} aria-label={t("приблизить")} title={t("Приблизить (клавиша +, колесо мыши)")}>
          +
        </button>
        <button type="button" className={s.chip} onClick={() => controls.current?.zoom(0.8)} aria-label={t("отдалить")} title={t("Отдалить (клавиша −)")}>
          −
        </button>
        <button type="button" className={s.chip} onClick={() => controls.current?.reset()} aria-label={t("показать последние свечи")} title={t("Последние свечи (двойной клик по графику)")}>
          ⟲
        </button>
        <select aria-label={t("тип графика")} value={st.type} onChange={(e) => patch({ type: e.target.value as ChartType })}>
          {CHART_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(TYPE_LABEL[x])}
            </option>
          ))}
        </select>
        <select aria-label={t("шкала")} value={st.scale} onChange={(e) => patch({ scale: e.target.value as ScaleMode })} title={t("Ценовая шкала")}>
          {(Object.keys(SCALE_LABEL) as ScaleMode[]).map((m) => (
            <option key={m} value={m}>
              {t(SCALE_LABEL[m])}
            </option>
          ))}
        </select>
        <select aria-label={t("наложение")} className={s.desktopOnly} value={st.overlay ?? ""} onChange={(e) => patch({ overlay: e.target.value || null, scale: e.target.value && st.scale === "linear" ? "percent" : st.scale })} title={t("Наложить второй инструмент (линия закрытий)")}>
          <option value="">{t("без наложения")}</option>
          {instruments
            .filter((i) => i.symbol !== symbol)
            .map((i) => (
              <option key={i.symbol} value={i.symbol}>
                + {i.symbol}
              </option>
            ))}
        </select>
        <span className={s.topSpacer} />
        <button type="button" className={s.chip} onClick={snapshot} title={t("Снимок PNG с водяным знаком")}>{t("Снимок")}</button>
        <Link href="/multichart" className={`${s.chip} ${s.desktopOnly}`} style={{ display: "inline-flex", alignItems: "center" }}>{t("Мультичарт")}</Link>
        <button type="button" className={`${s.chip} ${s.desktopOnly}`} aria-pressed={objects === "shown"} onClick={() => setObjects(objects === "shown" ? "hidden" : "shown")}>{t("Объекты")}</button>
      </div>
      <div className={s.strip} aria-label={t("состояние")}>
        <span>{t("цена")}{" "}<strong>{formatPrice(price == null ? null : String(price), data.tick)}</strong>
        </span>
        <span className={change == null ? "" : change >= 0 ? "up" : "down"}>{formatPct(change)}</span>
        <span>{t("до закрытия")}{" "}<strong>{countdown == null ? "—" : formatCountdown(countdown, t("{d}д {hm}"))}</strong>
        </span>
        {bias && (
          <span title={t("Направление старших таймфреймов, с которым система ищет входы: день (D1) и неделя (W1).")}>
            {t("Тренд")}: {t("день")} <strong className={TREND_TONE[bias.d1_trend] ?? ""}>{t(TREND_WORD[bias.d1_trend] ?? bias.d1_trend)}</strong> · {t("неделя")} <strong className={TREND_TONE[bias.w1_trend] ?? ""}>{t(TREND_WORD[bias.w1_trend] ?? bias.w1_trend)}</strong>
          </span>
        )}
        {data.layers?.structure?.atr && <span className={s.desktopOnly} title={t("Средний размах одной свечи (ATR 14): насколько обычно ходит цена за свечу.")}>{t("Ход за свечу")} <strong>{formatPrice(data.layers.structure.atr, data.tick)}</strong></span>}
        {data.derivatives?.funding_current && (
          <span className={s.desktopOnly} title={t("Ставка финансирования фьючерса: плюс — лонги платят шортам, минус — наоборот.")}>
            {t("Фандинг")} <strong>{(Number(data.derivatives.funding_current) * 100).toFixed(4)} %</strong>
            {data.derivatives.next_funding_t && <> · {t("через")} {formatCountdown(Math.max(0, data.derivatives.next_funding_t - now))}</>}
          </span>
        )}
        <span className={`caption ${s.live}`} data-on={data.connected || undefined}>{data.connected ? t("онлайн") : t("без связи")}</span>
        {st.type === "heikin" && <span className="caption">{t("Heikin Ashi: паттерны и сигналы считаются по обычным свечам")}</span>}
      </div>
      {toast && (
        <p role="status" className="caption" style={{ margin: 0, padding: "2px 12px" }}>
          {toast}
        </p>
      )}
      <div className={s.area} ref={areaRef} data-objects={objects} style={{ "--objects-w": `${objW}px` } as React.CSSProperties}>
        <DrawToolbar tool={dr.tool} onTool={(t) => dr.setTool(t)} magnet={dr.magnet} onMagnet={dr.setMagnet} canUndo={dr.canUndo} canRedo={dr.canRedo} onUndo={dr.actions.undo} onRedo={dr.actions.redo} />
        <div className={s.chartCol}>
      {cross && (
        <div className={s.ohlc} data-testid="ohlc" aria-live="polite" data-more={ohlcMore || undefined}>
          <button type="button" className={s.ohlcClose} aria-label={t("закрыть карточку")} onClick={() => { controls.current?.clearCrosshair(); setCross(null); }}>
            ×
          </button>
          <span>{new Date(cross.candle.time * 1000).toLocaleString("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} UTC</span>
          <span>
            O <strong>{fmtP(cross.candle.open)}</strong>
          </span>
          <span>
            H <strong>{fmtP(cross.candle.high)}</strong>
          </span>
          <span>
            L <strong>{fmtP(cross.candle.low)}</strong>
          </span>
          <span className={cross.candle.close >= cross.candle.open ? "up" : "down"}>
            C <strong>{fmtP(cross.candle.close)}</strong> {(((cross.candle.close - cross.candle.open) / cross.candle.open) * 100).toFixed(2)} %
          </span>
          <span>
            V <strong>{formatCompactValue(cross.candle.volume)}</strong>
          </span>
          {cross.values.length > 0 && (
            <button type="button" className={`${s.ohlcMore} ${s.mobileOnly}`} aria-expanded={ohlcMore} onClick={() => setOhlcMore(!ohlcMore)}>
              {ohlcMore ? t("скрыть индикаторы") : t("индикаторы ({n})", { n: cross.values.length })}
            </button>
          )}
          {cross.values.map((v) => (
            <span key={v.label} className={s.ohlcVal}>
              <span style={{ color: v.color }}>{v.label}</span> <strong>{fmtV(v)}</strong>
            </span>
          ))}
          {cross.candle.open_ && <span className="caption">{t("свеча не закрыта")}</span>}
        </div>
      )}
        {data.error && !intradayLocked ? (
          <div className={s.empty} role="alert">
            {data.error}
          </div>
        ) : intradayLocked && data.error ? (
          <div className={s.empty}>{t("Таймфреймы 1m–15m доступны после входа с подпиской Pro.")}{" "}<Link href="/pricing">{t("Подписка")}</Link>
          </div>
        ) : (
          <ChartSurface store={store} markup={st.markup} authed={authed} candles={data.candles ?? []} current={data.current} tf={tf} type={st.type} indicators={st.indicators} layers={data.layers} patterns={data.patterns?.items} figures={data.figures?.items} alerts={alertLines} derivatives={data.derivatives} panels={st.panels} tick={data.tick} dataKey={symbol} onNeedOlder={data.loadOlder} drawings={drawingsProps} onCrosshair={setCross} onReady={onReady} scale={st.scale} overlay={overlayCandles} />
        )}
        {sel && (
          <div className={s.card} role="region" aria-label={t("выбранный рисунок")}>
            <strong>{t(TOOL_TITLES[sel.type])}</strong>
            {(sel.type === "note" || sel.type === "rect" || sel.type === "trend") && (
              <input aria-label={t("текст рисунка")} placeholder={t("подпись (до 140 символов)")} maxLength={140} value={sel.text ?? ""} onChange={(e) => dr.actions.patch(sel.id, { text: e.target.value })} />
            )}
            {pos && (
              <span className={s.posStats}>
                R:R <strong>{pos.rr.toFixed(2)}</strong> {t("· риск")} {pos.riskPct.toFixed(2)} %
                {pos.riskUsd != null && pos.size != null && (
                  <>
                    {" "}{t("· риск")} <strong>{pos.riskUsd.toFixed(0)} USDT</strong>{" "}{t("· размер")}{" "}<strong>{pos.size.toPrecision(4)}</strong>
                  </>
                )}
                {pos.riskUsd == null && <span className="caption">{" "}{t("· задайте депозит и риск в настройках")}</span>}
                <Link href={`/journal?symbol=${symbol}&direction=${pos.direction}&entry=${pos.entry}&stop=${pos.stop}&tp=${pos.target}`}>{t("в журнал")}</Link>
                <Link href={`/calculator?symbol=${symbol}&direction=${pos.direction}&entry=${pos.entry}&stop=${pos.stop}&tp=${pos.target}`}>{t("в калькулятор")}</Link>
              </span>
            )}
            <label className={s.inline}>
              <input type="checkbox" checked={sel.timeframe === null} onChange={(e) => dr.actions.patch(sel.id, { timeframe: e.target.checked ? null : tf })} />{" "}{t("на всех таймфреймах")}</label>
            {(sel.type === "hline" || sel.type === "hray") && sel.points[0] && (
              <button
                type="button"
                className={s.chip}
                onClick={() => {
                  const p = sel.points[0]!.price;
                  addPriceAlert(String(p), price != null && price < p ? "cross_up" : "cross_down", undefined, sel.id);
                }}
              >{t("алерт на уровне")}</button>
            )}
            {instruments.length > 1 && (
              <select
                className={s.chip}
                aria-label={t("скопировать на инструмент")}
                value=""
                onChange={(e) => {
                  const target = e.target.value;
                  if (target) void copyDrawing(sel.id, target);
                }}
              >
                <option value="">{t("скопировать на…")}</option>
                {instruments
                  .filter((i) => i.symbol !== symbol)
                  .map((i) => (
                    <option key={i.symbol} value={i.symbol}>
                      {i.symbol}
                    </option>
                  ))}
              </select>
            )}
            <button type="button" className={s.chip} onClick={() => dr.actions.lock(sel.id)} aria-pressed={sel.locked}>
              {sel.locked ? t("разблокировать") : t("заблокировать")}
            </button>
            <button type="button" className={s.chip} onClick={() => dr.actions.remove(sel.id)} disabled={sel.locked}>{t("удалить")}</button>
            <button type="button" className={s.chip} onClick={() => dr.actions.select(null)} aria-label={t("снять выделение")}>
              ✕
            </button>
          </div>
        )}
        {dr.limitHit && (
          <p className={s.card} role="alert">
            {t("Лимит рисунков на инструмент: {n}. Удалите лишние", { n: dr.limit ?? "—" })}{!user ? t(" или войдите") : t(" или оформите подписку уровнем выше")}.{" "}
            <button type="button" className={s.chip} onClick={dr.dismissLimit}>{t("понятно")}</button>
          </p>
        )}
        {sheet && (
          <BottomSheet title={sheet === "indicators" ? t("Индикаторы") : sheet === "layers" ? t("Слои") : sheet === "found" ? t("Найдено на графике") : sheet === "ask" ? t("Вопрос о графике") : sheet === "alert" ? t("Алерт по цене") : t("Рисование")} onClose={closeSheet}>
            {sheet === "alert" && (
              <form
                aria-label={t("новый алерт по цене")}
                onSubmit={(e) => {
                  e.preventDefault();
                  addPriceAlert(alertDraft.price, alertDraft.op, alertDraft.op === "enter_range" ? alertDraft.price2 : undefined, undefined, alertDraft.frequency);
                }}
              >
                <label>{t("условие")}<select aria-label={t("условие цены")} value={alertDraft.op} onChange={(e) => setAlertDraft({ ...alertDraft, op: e.target.value as typeof alertDraft.op })}>
                    <option value="cross_up">{t("пересечение вверх")}</option>
                    <option value="cross_down">{t("пересечение вниз")}</option>
                    <option value="enter_range">{t("вход в диапазон")}</option>
                  </select>
                </label>
                <label>{t("цена")}<input aria-label={t("цена алерта")} inputMode="decimal" required value={alertDraft.price} onChange={(e) => setAlertDraft({ ...alertDraft, price: e.target.value })} />
                </label>
                {alertDraft.op === "enter_range" && (
                  <label>{t("вторая граница")}<input aria-label={t("вторая граница")} inputMode="decimal" required value={alertDraft.price2} onChange={(e) => setAlertDraft({ ...alertDraft, price2: e.target.value })} />
                  </label>
                )}
                <label>{t("срабатывание")}<select aria-label={t("частота")} value={alertDraft.frequency} onChange={(e) => setAlertDraft({ ...alertDraft, frequency: e.target.value as typeof alertDraft.frequency })}>
                    <option value="once">{t("один раз")}</option>
                    <option value="every">{t("каждый раз")}</option>
                    <option value="once_per_bar">{t("раз в свечу")}</option>
                  </select>
                </label>
                <button type="submit" className={s.chip}>{t("Создать алерт")}</button>
                <p className="caption">
                  {t("Проверка по минутным свечам, до 60 с. Активных по инструменту: {n}.", { n: alerts.length })} <Link href="/alerts">{t("Все алерты")}</Link>
                </p>
              </form>
            )}
            {sheet === "ask" && <AskBox symbol={symbol} tf={tf} access={askAccess} heading={false} />}
            {sheet === "found" && (
              <>
                <LevelsList index={sceneIndex} tick={data.tick} selected={selection} onPick={pickLevel} />
                <strong className={s.objHead}>{t("Фигуры")}</strong>
                <FiguresList items={data.figures?.items ?? []} stats={data.figures?.stats ?? {}} selected={figureSel} onSelect={setFigureSel} tick={data.tick} />
                <strong className={s.objHead}>{t("Свечные паттерны")}</strong>
                <FoundList items={data.patterns?.items ?? []} stats={data.patterns?.stats ?? {}} selected={foundSel} onSelect={setFoundSel} tf={tf} symbol={symbol} canExplain={!!user} />
              </>
            )}
            {sheet === "draw" &&
              TOOLS.map((tool) => (
                <button
                  key={tool}
                  type="button"
                  className={s.chip}
                  aria-pressed={dr.tool === tool}
                  onClick={() => {
                    dr.setTool(dr.tool === tool ? null : tool);
                    setSheet(null);
                  }}
                >
                  {t(TOOL_TITLES[tool])}
                </button>
              ))}
            {sheet === "draw" && (
              <>
                <label>
                  <input type="checkbox" checked={dr.magnet} onChange={(e) => dr.setMagnet(e.target.checked)} />{" "}{t("магнит к OHLC")}</label>
                <label>
                  <input type="checkbox" checked={dr.state.hidden} onChange={(e) => dr.actions.hide(e.target.checked)} />{" "}{t("скрыть все рисунки")}</label>
                <button
                  type="button"
                  className={s.chip}
                  disabled={dr.items.length === 0}
                  onClick={() => {
                    if (confirm(t("Удалить все рисунки по {symbol} ({n})?", { symbol, n: dr.items.length }))) dr.actions.clear();
                  }}
                >{t("удалить все")}</button>
              </>
            )}
            {sheet === "found" || sheet === "alert" || sheet === "ask"
              ? null
              : sheet === "indicators"
              ? [
                  ...INDICATORS.map((i) => {
                    return (
                      <label key={i.id}>
                        <input type="checkbox" checked={indicatorIds.has(i.id)} onChange={() => toggleIndicator(i.id)} />
                        <span className={s.indDot} style={{ background: `var(${IND_COLOR_VAR[indicatorColor(i.id)]})` }} aria-hidden="true" /> {t(i.title)}
                        <span className="caption">{i.pane === "overlay" ? t("на графике") : t("панель")}</span>
                      </label>
                    );
                  }),
                  ...PANELS.map((pn) => (
                    <label key={pn.id}>
                      <input type="checkbox" checked={st.panels.includes(pn.id)} onChange={() => togglePanel(pn.id)} /> {t(pn.title)}
                      <span className="caption">{pn.id === "liq" ? t("панель · данные публичного потока, не полный объём") : t("панель · деривативы")}</span>
                    </label>
                  )),
                ]
              : [
                  <MarkupPicker key="markup" markup={st.markup} custom={resolved.custom} onSelect={selectMarkup} liqUnavailable={sceneIndex?.liqUnavailable ?? false} />,
                  ...layerKeysFor(authed).map((k) => (
                    <label key={k}>
                      <input type="checkbox" checked={resolved.layers[k]} onChange={() => toggleLayer(k)} /> {t(LAYER_LABEL[k])}
                      {k === "liq_map" && sceneIndex?.liqUnavailable && <span className="caption">{t("нет данных открытого интереса на этом таймфрейме")}</span>}
                    </label>
                  )),
                ]}
          </BottomSheet>
        )}
        </div>
        <ObjectsPanel
          onResize={objResize}
          drawings={dr.items}
          selectedId={dr.state.selectedId}
          onSelect={dr.actions.select}
          onLock={dr.actions.lock}
          onRemove={dr.actions.remove}
          markup={st.markup}
          custom={resolved.custom}
          onMarkup={selectMarkup}
          layers={resolved.layers}
          onLayer={toggleLayer}
          panels={st.panels}
          onPanel={togglePanel}
          onTemplate={applyTemplate}
          layouts={layouts}
          onSaveLayout={saveLayout}
          onLoadLayout={loadLayout}
          onDeleteLayout={removeLayout}
          authed={authed}
          layoutsLimit={user ? null : 0}
          found={{ count: foundCount, items: data.patterns?.items ?? [], stats: data.patterns?.stats ?? {}, selected: foundSel, onSelect: setFoundSel, tf, symbol, canExplain: !!user, askAccess, index: sceneIndex, tick: data.tick, levelSelected: selection, onLevel: pickLevel, figures: data.figures?.items ?? [], figureStats: data.figures?.stats ?? {}, selectedFigure: figureSel, onSelectFigure: setFigureSel }}
        />
      </div>
      <div className={s.bottom}>
        <button type="button" className={s.chip} aria-pressed={sheet === "indicators"} onClick={() => setSheet(sheet === "indicators" ? null : "indicators")}>
          {t("Индикаторы ({n})", { n: st.indicators.length + st.panels.length })}
        </button>
        <button type="button" className={s.chip} aria-pressed={sheet === "layers"} onClick={() => setSheet(sheet === "layers" ? null : "layers")}>{t("Слои")}</button>
        <button type="button" className={`${s.chip} ${s.mobileOnly}`} aria-pressed={sheet === "ask"} onClick={() => setSheet(sheet === "ask" ? null : "ask")}>
          {t("Спросить")}
        </button>
        <button type="button" className={`${s.chip} ${s.mobileOnly}`} aria-pressed={sheet === "found"} onClick={() => setSheet(sheet === "found" ? null : "found")}>
          {t("Найдено ({n})", { n: foundCount })}
        </button>
        <button type="button" className={s.chip} aria-pressed={sheet === "alert"} onClick={() => (sheet === "alert" ? setSheet(null) : openAlertSheet())}>
          {t("Алерт")}{alerts.length ? ` (${alerts.length})` : ""}
        </button>
        <button type="button" className={s.chip} aria-pressed={sheet === "draw" || dr.tool !== null} onClick={() => setSheet(sheet === "draw" ? null : "draw")}>
          {dr.tool ? t("Рисую: {tool}", { tool: t(TOOL_TITLES[dr.tool]) }) : t("Рисовать")}
        </button>
        {dr.tool && (
          <button type="button" className={s.chip} onClick={() => { dr.setTool(null); dr.setDraft(null); }} aria-label={t("закончить рисование")}>{t("Готово")}</button>
        )}
        <button type="button" className={`${s.chip} ${s.mobileOnly}`} onClick={dr.actions.undo} disabled={!dr.canUndo} aria-label={t("отменить")}>
          ↶
        </button>
        <button type="button" className={`${s.chip} ${s.mobileOnly}`} onClick={dr.actions.redo} disabled={!dr.canRedo} aria-label={t("повторить")}>
          ↷
        </button>
        <span className="caption" data-testid="drawings-count">
          {t("рисунков: {n}", { n: dr.items.length })}
        </span>
        {user && dr.sync !== "off" && (
          <span className="caption" data-testid="drawings-sync">
            {dr.sync === "ok" ? t("синхронизировано") : dr.sync === "queued" ? t("в очереди") : t("ошибка синхронизации")}
          </span>
        )}
        {data.layers?.signals.length ? (
          <Link className="caption" href={`/signals?symbol=${symbol}&tab=all`}>
            {t("сигналов по инструменту: {n}", { n: data.layers.signals.length })}
          </Link>
        ) : null}
      </div>
    </div>
    </ChartStoreContext.Provider>
  );
}
