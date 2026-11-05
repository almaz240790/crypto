"use client";

import { INDICATORS, TOOL_TITLES, createChartStore, positionStats, type Candle, type ChartType, type Drawing, type DrawingType, type ScaleMode, type Timeframe } from "@platform/charts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { usePopover } from "@/components/ui";
import { getAccessToken } from "@/lib/auth-client";
import { MQ, useMediaQuery } from "@/lib/breakpoints";
import { TF_LABEL, TIMEFRAMES, INTRADAY } from "@/lib/timeframes";
import s from "./terminal.module.css";
import { BottomSheet } from "./BottomSheet";
import { DrawToolbar } from "./DrawToolbar";
import { DrawingLimitCard, SelectedDrawingCard } from "./SelectedDrawingCard";
import { download } from "./snapshot";
import { ChartSurface, IND_COLOR_VAR, PANELS, indicatorColor, type TerminalControls } from "./chart/ChartSurface";
import { ChartStoreContext, useChartStore } from "./chart/useChartStore";
import { CrosshairCard } from "./chart/CrosshairCard";
import { FoundCounter } from "./chart/FoundCounter";
import { OhlcLegend } from "./chart/OhlcLegend";
import { MarkupPicker } from "./MarkupPicker";
import { SidePanel } from "./panels/SidePanel";
import { LAYER_LABEL, layerKeysFor } from "./panels/LayersTab";
import { AskBox } from "./panels/found/AskBox";
import { FoundTab, type FoundData } from "./panels/found/FoundTab";
import { useTerminalSettings } from "./state/useTerminalSettings";
import { useTopdown } from "./state/useTopdown";
import { useChartAlerts } from "./state/useChartAlerts";
import { alertPriceText } from "./state/alertPrice";
import { useLayouts } from "./state/useLayouts";
import { useTerminalUi } from "./state/useTerminalUi";
import { useInstruments } from "./state/useInstruments";
import { usePlan } from "./state/usePlan";
import { useTrend } from "./state/useTrend";
import { useDrawings } from "./useDrawings";
import { getCandles, toCandle, type FigureOnChart, type PatternOnChart } from "@/lib/chart";
import { useTerminalData } from "./useTerminalData";
import { useT } from "@/i18n/client";
import { TerminalHeader, type HeaderFacts } from "./chrome/TerminalHeader";
import { TerminalToolbar } from "./chrome/TerminalToolbar";
import type { TimeframeBarHandle } from "./chrome/TimeframeBar";
import { ChartCorner, DrawModeChip } from "./chrome/ChartCorner";
import { drawHint } from "./chrome/drawHint";
import { PhoneBottom, PhoneStrip, PhoneTop } from "./chrome/PhoneBars";

const NO_FIGURES: readonly FigureOnChart[] = [];
const NO_PATTERNS: readonly PatternOnChart[] = [];
const NO_STATS = {};

const TOOLS: DrawingType[] = ["hline", "hray", "vline", "trend", "ray", "extended", "channel", "rect", "fib", "position-long", "position-short", "note", "ruler"];

/** Однократное уведомление о новой разметке после миграции сохранения v4 и раньше (ADR-0008). */
const MARKUP_NOTICE_KEY = "pl-markup-notice";
const NOTICE_MS = 8000;

/**
 * Терминал одного инструмента (план 2B.9): сетка страницы. Создаёт хранилище графика (ChartStore) и держит
 * handle графика; состояние — в хуках state/* (настройки, алерты, раскладки, интерфейс, инструменты, тариф).
 *
 * Раскладка — только по ширине окна, как CSS рейки AppShell и колонки рисования: десктоп (≥ 900) — шапка 44 px,
 * тулбар 40 px, левая панель рисования, график и правая панель (встроена от 1280, уже — поверх графика); телефон
 * (< 900) — прежние строки. Ландшафт телефона по высоте (useLayout, MQ.phoneLandscape) не учитывается: 932×430 —
 * десктоп целиком, а не смесь; свою раскладку ландшафта вводит C2 вместе с CSS AppShell и терминала.
 * Дети .page всегда в одном порядке, отсутствующие в раскладке — null: колонка графика и ChartSurface
 * не перемонтируются при переходе через 900 px.
 */
export function TerminalShell({ symbol, tf }: { symbol: string; tf: Timeframe }) {
  const t = useT();
  const router = useRouter();
  const { user } = useAuth();
  const authed = !!user;
  const desktop = useMediaQuery(MQ.desktop, true);
  const wide = useMediaQuery(MQ.wide, true);
  /** Состояние графика (сцена, выбор, видимая часть) — для листовых компонентов и «Найдено». */
  const [store] = useState(createChartStore);
  const instruments = useInstruments();
  const { sheet, setSheet, closeSheet, ohlcMore, setOhlcMore, bars, setBars, objects, setObjects, panelOverlay, panelTab, setPanelTab, showPanel, objWidth, objResize, toast, say, notifyOnce } = useTerminalUi(wide);
  // вопросы о графике — Premium (админы и владелец — всегда); минутные ТФ закрыты гостю и на Free
  const { askAccess, intradayLocked } = usePlan();
  const { st, resolved, legacyFound, patch, toggleIndicator, addIndicator, removeInstance, setInstanceParams, toggleInstanceHidden, togglePanel, toggleLayer, selectMarkup, applyTemplate, applyLayout, setPaneLayout, removePane } = useTerminalSettings(authed);
  // «Разбор» (резерв): вкладка и пункт тулбара — владельцу и админам, если ресурс topdown ответил 200
  const topdown = useTopdown(symbol, tf, user);
  const role = user?.role ?? null;
  const alertPop = usePopover();
  const closeAlertPop = alertPop.close;
  const onAlertCreated = useCallback(() => {
    closeSheet();
    closeAlertPop();
  }, [closeSheet, closeAlertPop]);
  const { alerts, alertLines, draft: alertDraft, setDraft: setAlertDraft, resetDraft, addPriceAlert } = useChartAlerts({ symbol, authed, say, onCreated: onAlertCreated });
  const { layouts, saveLayout, loadLayout, removeLayout } = useLayouts({ authed, symbol, tf, current: st, applyLayout, say });
  const controls = useRef<TerminalControls | null>(null);
  const tfBar = useRef<TimeframeBarHandle>(null);
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
  // фигура или паттерн в «Найдено»: выбрать и прокрутить к его времени, если он за кадром
  const focusObject = useCallback(
    (objectId: string | null, time?: number) => {
      if (objectId === null) store.select(null);
      else if (controls.current) controls.current.focus(time === undefined ? { objectId } : { objectId, time });
      else store.select(objectId);
    },
    [store],
  );
  // пояснение «нет данных OI» у слоя и пресета — флаг каталога сцены (лист «Найдено» читает каталог сам)
  const liqUnavailable = useChartStore((x) => x.sceneIndex?.liqUnavailable ?? false, store);
  const dr = useDrawings(symbol, authed);
  const data = useTerminalData(symbol, tf, user ? getAccessToken() : null);
  const trend = useTrend(data.layers);
  const figures = data.figures?.items ?? NO_FIGURES;
  const patterns = data.patterns?.items ?? NO_PATTERNS;
  const panelShown = desktop && objects === "shown";
  const overlayPanelOpen = panelShown && panelOverlay;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") {
        // панель поверх графика (900–1279) закрывается после попапов и режима рисования
        if (overlayPanelOpen && !dr.tool) {
          setObjects("hidden");
          return;
        }
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
        // клавиши 1–7 — по TIMEFRAMES; закрытый минутный ТФ открывает то же окно, что и клик по нему
        const x = TIMEFRAMES[Number(e.key) - 1];
        if (!x) return;
        if (desktop && intradayLocked && INTRADAY.includes(x)) tfBar.current?.openLocked(x);
        else router.push(`/chart/${symbol}/${x}`);
      } else if ((e.key === "Delete" || e.key === "Backspace") && dr.selected && !dr.selected.locked) dr.actions.remove(dr.selected.id);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) dr.actions.undo();
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) dr.actions.redo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dr, router, symbol, store, desktop, intradayLocked, overlayPanelOpen, setObjects]);
  // сохранение старше v5 сброшено на «Чистый»: один раз объясняем, где прежний вид
  useEffect(() => {
    if (legacyFound) notifyOnce(MARKUP_NOTICE_KEY, t("Разметка графика обновлена: по умолчанию «Чистый». Прежний вид — «Подробный» в «Разметке»."), NOTICE_MS);
  }, [legacyFound, t, notifyOnce]);

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
  // цена шапки — живая (data.prices: шапка подписана сама, терминал на тиках не перерисовывается), без неё — закрытие
  // последней свечи; обработчики берут самую свежую на момент действия
  const fallback = last?.close ?? null;
  const fallbackRef = useRef(fallback);
  useLayoutEffect(() => {
    fallbackRef.current = fallback;
  });
  const livePrices = data.prices;
  const priceNow = useCallback(() => {
    const p = livePrices.now();
    return p != null ? Number(p) : fallbackRef.current;
  }, [livePrices]);
  const tick = data.tick;
  // черновик алерта — с ценой на момент открытия; обработчик стабилен (тулбар в memo не перерисовывается на тиках)
  const openAlert = useCallback(() => resetDraft(priceNow(), tick), [resetDraft, priceNow, tick]);
  const openAlertSheet = () => {
    openAlert();
    setSheet("alert");
  };
  const snapshot = useCallback(() => {
    const c = controls.current;
    if (!c) return say(t("график ещё не готов"));
    // снимок собирает график (handle.snapshot): кадр LWC с разметкой, подпись сверху и водяной знак снизу
    const url = c.snapshot(`${symbol} · ${t(TF_LABEL[tf])} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, `PlatformSol · ${window.location.href} · ${t("не является инвестиционной рекомендацией")}`);
    if (url) download(url, `platform-${symbol}-${tf}-${Date.now()}.png`);
  }, [say, symbol, t, tf]);
  const deselectDrawing = () => dr.actions.select(null);
  // алерт на цене уровня: направление — от текущей цены к уровню, цена — по шагу инструмента
  const alertOnLevel = (d: Drawing) => {
    const p = d.points[0]!.price;
    const price = priceNow();
    addPriceAlert(alertPriceText(p, data.tick), price != null && price < p ? "cross_up" : "cross_down", undefined, d.id);
  };
  // копия рисунка на другой инструмент (план 2A.5): цены пропорционально последней цене цели
  const copyDrawing = async (id: string, target: string) => {
    let ratio = 1;
    const price = priceNow();
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
  // минутный ТФ без тарифа: сервер отвечает ошибкой — вместо графика объяснение со ссылкой на подписку
  const intradayDenied = !user || (data.error ?? "").includes(t("тарифе"));
  const goSymbol = useCallback((x: string) => router.push(`/chart/${x}/${tf}`), [router, tf]);
  const clearDrawings = () => {
    if (confirm(t("Удалить все рисунки по {symbol} ({n})?", { symbol, n: dr.items.length }))) dr.actions.clear();
  };
  // «Отменить» и «Готово» чипа режима рисования (то же — Esc): начатый рисунок брошен, курсор
  const finishTool = useCallback(() => {
    dr.setTool(null);
    dr.setDraft(null);
  }, [dr]);

  const indicatorIds = useMemo(() => new Set(st.indicators.map((i) => i.id)), [st.indicators]);
  const lastClose = data.candles?.length ? data.candles[data.candles.length - 1]!.close : null;
  const signalsLinkN = authed ? (data.layers?.signals.length ?? 0) : 0;
  const foundData: FoundData = useMemo(
    () => ({
      symbol,
      tf,
      tick: data.tick,
      lastClose,
      figures,
      figureStats: data.figures?.stats ?? NO_STATS,
      patterns,
      patternStats: data.patterns?.stats ?? NO_STATS,
      canExplain: authed,
      askAccess,
      signals: signalsLinkN > 0 ? { symbol, n: signalsLinkN } : null,
      onLevel: pickLevel,
      onFocus: focusObject,
    }),
    [symbol, tf, data.tick, lastClose, figures, data.figures?.stats, patterns, data.patterns?.stats, authed, askAccess, signalsLinkN, pickLevel, focusObject],
  );
  const sel = dr.selected;
  /** Стопка карточек поверх графика (выбранный рисунок, лимит): её прямоугольник — препятствие для подписей на графике. */
  const [cardsEl, setCardsEl] = useState<HTMLDivElement | null>(null);
  /** Высота шкалы времени: карточка выбранного рисунка на десктопе — над ней, даты и метка перекрестия видны (D7). */
  const [axisH, setAxisH] = useState<number | null>(null);
  /** Депозит и доля риска из настроек: риск в $ и объём позиции — в карточке и на плашке входа на графике. */
  const riskDeposit = user?.risk?.deposit ?? null;
  const riskPct = user?.risk?.risk_pct ?? null;
  const riskProfile = useMemo(() => (riskDeposit && Number(riskDeposit) > 0 ? { deposit: Number(riskDeposit), riskPct: Number(riskPct) } : null), [riskDeposit, riskPct]);
  const pos = useMemo(() => {
    if (!sel || !sel.type.startsWith("position") || sel.points.length < 3) return null;
    return positionStats(sel.type === "position-long" ? "long" : "short", sel.points[0]!.price, sel.points[1]!.price, sel.points[2]!.price, riskProfile);
  }, [sel, riskProfile]);
  const setDrawTool = dr.setTool;
  const drawingsProps = useMemo(
    () => ({
      state: dr.state,
      tool: dr.tool,
      magnet: dr.magnet,
      series: dr.series,
      draft: dr.draft,
      onCreate: dr.actions.create,
      onMove: dr.actions.move,
      onSelect: dr.actions.select,
      onDraft: dr.setDraft,
      onStep: dr.setStep,
      // один рисунок на выбор инструмента (ADR-0009, «Рисование»): без «серии» контроллер снял инструмент — курсор
      onToolDone: (ended: boolean) => {
        if (ended) setDrawTool(null);
      },
      profile: riskProfile,
    }),
    [dr.state, dr.tool, dr.magnet, dr.series, dr.draft, dr.actions, dr.setDraft, dr.setStep, setDrawTool, riskProfile],
  );
  const fundingRate = data.derivatives?.funding_current ?? null;
  const fundingNext = data.derivatives?.next_funding_t ?? null;
  const funding = useMemo(() => (fundingRate ? { rate: fundingRate, next: fundingNext } : null), [fundingRate, fundingNext]);
  const facts: HeaderFacts = { prices: data.prices, fallback, prevClose, tick: data.tick, lastClose, trend, atr: data.layers?.structure?.atr ?? null, funding, heikin: st.type === "heikin", online: data.online, source: data.source, lastTime: last?.time ?? null };
  const zoom = useCallback((f: number) => controls.current?.zoom(f), []);
  const reset = useCallback(() => controls.current?.reset(), []);
  const syncText = user && dr.sync !== "off" ? (dr.sync === "ok" ? t("синхронизировано") : dr.sync === "queued" ? t("в очереди") : t("ошибка синхронизации")) : null;
  const signalsLink = data.layers?.signals.length ? { symbol, n: data.layers.signals.length } : null;
  const clearCrosshair = useCallback(() => controls.current?.clearCrosshair(), []);
  const liqLayerOn = resolved.layers.liq_map;
  // наложенный инструмент — строкой легенды: на графике его линия без подписи (D4)
  const overlayTick = overlaySymbol ? (instruments.find((i) => i.symbol === overlaySymbol)?.tick_size ?? null) : null;
  const legendOverlay = useMemo(() => (overlaySymbol && overlayCandles?.length ? { symbol: overlaySymbol, candles: overlayCandles, tick: overlayTick } : null), [overlaySymbol, overlayCandles, overlayTick]);
  const removeOverlay = useCallback(() => patch({ overlay: null }), [patch]);
  const legend = useMemo(
    () => (desktop ? <OhlcLegend store={store} symbol={symbol} tfLabel={t(TF_LABEL[tf])} exchange="Binance" tick={data.tick} instances={st.indicators} liqLayerOn={liqLayerOn} onHide={toggleInstanceHidden} onRemove={removeInstance} onParams={setInstanceParams} overlay={legendOverlay} onOverlayRemove={removeOverlay} /> : null),
    [desktop, store, symbol, t, tf, data.tick, st.indicators, liqLayerOn, toggleInstanceHidden, removeInstance, setInstanceParams, legendOverlay, removeOverlay],
  );
  // правая панель: стабильные пропсы (memo), «Найдено» и счётчики читают хранилище графика сами
  const panelDrawings = useMemo(
    () => ({ items: dr.items, selectedId: dr.state.selectedId, sync: syncText, onSelect: dr.actions.select, onLock: dr.actions.lock, onRemove: dr.actions.remove, onClearAll: clearDrawings }),
    // clearDrawings читает dr.items через замыкание: пересоздаётся вместе со списком
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dr.items, dr.state.selectedId, syncText, dr.actions],
  );
  const panelLayers = useMemo(() => ({ markup: st.markup, custom: resolved.custom, onMarkup: selectMarkup, layers: resolved.layers, onLayer: toggleLayer, authed, liqUnavailable }), [st.markup, resolved, selectMarkup, toggleLayer, authed, liqUnavailable]);
  const panelLayouts = useMemo(() => ({ layouts, onTemplate: applyTemplate, onSave: saveLayout, onLoad: loadLayout, onDelete: removeLayout, authed, limit: user ? null : 0 }), [layouts, applyTemplate, saveLayout, loadLayout, removeLayout, authed, user]);
  const closePanel = useCallback(() => setObjects("hidden"), [setObjects]);
  // обработчики тулбара (memo): стабильны между тиками цены
  const onType = useCallback((type: ChartType) => patch({ type }), [patch]);
  const onScale = useCallback((scale: ScaleMode) => patch({ scale }), [patch]);
  const curScale = st.scale;
  const onOverlay = useCallback((overlay: string | null) => patch({ overlay, scale: overlay && curScale === "linear" ? "percent" : curScale }), [patch, curScale]);
  const onLayers = useCallback(() => showPanel("layers"), [showPanel]);
  const onTopdown = useCallback(() => showPanel("topdown"), [showPanel]);
  const onAlertSubmit = useCallback(() => addPriceAlert(alertDraft.price, alertDraft.op, alertDraft.op === "enter_range" ? alertDraft.price2 : undefined, undefined, alertDraft.frequency), [addPriceAlert, alertDraft]);
  const onObjects = useCallback(() => setObjects(objects === "shown" ? "hidden" : "shown"), [objects, setObjects]);
  return (
    <ChartStoreContext.Provider value={store}>
      <div className={s.page} data-layout={desktop ? "desktop" : "phone"} data-bars={bars} data-fullscreen-root>
        {!desktop && (
          <button type="button" className={`${s.chip} ${s.fsBtn}`} onClick={() => setBars(bars === "shown" ? "hidden" : "shown")} aria-label={bars === "shown" ? t("скрыть панели") : t("показать панели")}>
            {bars === "shown" ? "⤢" : "⤡"}
          </button>
        )}
        {desktop && <TerminalHeader {...facts} symbol={symbol} tf={tf} instruments={instruments} onSymbol={goSymbol} guest={!authed} />}
        {desktop && (
          <TerminalToolbar
            symbol={symbol}
            tf={tf}
            intradayLocked={intradayLocked}
            guest={!authed}
            tfRef={tfBar}
            instruments={instruments}
            type={st.type}
            scale={st.scale}
            overlay={st.overlay}
            onType={onType}
            onScale={onScale}
            onOverlay={onOverlay}
            instances={st.indicators}
            panels={st.panels}
            onIndicator={toggleIndicator}
            onAddIndicator={addIndicator}
            onRemoveInstance={removeInstance}
            onInstanceParams={setInstanceParams}
            onPanel={togglePanel}
            markup={st.markup}
            custom={resolved.custom}
            onMarkup={selectMarkup}
            onLayers={onLayers}
            topdown={topdown}
            onTopdown={onTopdown}
            authed={authed}
            alertsCount={alerts.length}
            alert={alertPop}
            alertDraft={alertDraft}
            onAlertDraft={setAlertDraft}
            onAlertOpen={openAlert}
            onAlertSubmit={onAlertSubmit}
            onSnapshot={snapshot}
            objectsShown={objects === "shown"}
            onObjects={onObjects}
            store={store}
            figures={figures}
            patterns={patterns}
          />
        )}
        {!desktop && <PhoneTop symbol={symbol} tf={tf} instruments={instruments} onSymbol={goSymbol} guest={!authed} type={st.type} scale={st.scale} onType={(type) => patch({ type })} onScale={(scale) => patch({ scale })} onZoom={zoom} onReset={reset} onSnapshot={snapshot} />}
        {!desktop && <PhoneStrip {...facts} tf={tf} />}
        <div className={s.area} data-objects={panelShown ? "shown" : "hidden"} data-panel={panelOverlay ? "overlay" : "inline"} style={{ "--objects-w": objWidth } as React.CSSProperties}>
          <DrawToolbar tool={dr.tool} onTool={dr.setTool} magnet={dr.magnet} onMagnet={dr.setMagnet} series={dr.series} onSeries={dr.setSeries} hidden={dr.state.hidden} onHidden={dr.actions.hide} canUndo={dr.canUndo} canRedo={dr.canRedo} onUndo={dr.actions.undo} onRedo={dr.actions.redo} />
          <div className={s.chartCol} style={axisH ? ({ "--time-scale-h": `${axisH}px` } as React.CSSProperties) : undefined}>
            {/* карточка перекрестия телефона (вид прежний до C2); на десктопе — легенда в углу графика. С инструментом
                рисования её нет: на её месте чип шага с «Отменить» (ADR-0009, «Рисование») */}
            {!desktop && !dr.tool && <CrosshairCard store={store} tick={data.tick} more={ohlcMore} onMore={setOhlcMore} onClose={clearCrosshair} />}
            {data.error && !intradayDenied ? (
              <div className={s.empty} role="alert">
                {data.error}
              </div>
            ) : intradayDenied && data.error ? (
              <div className={s.empty}>
                {t("Таймфреймы 1m–15m доступны после входа с подпиской Pro.")} <Link href="/pricing">{t("Подписка")}</Link>
              </div>
            ) : (
              <ChartSurface
                store={store}
                markup={st.markup}
                authed={authed}
                candles={data.candles ?? []}
                current={data.current}
                tf={tf}
                type={st.type}
                indicators={st.indicators}
                layers={data.layers}
                patterns={data.patterns?.items}
                figures={data.figures?.items}
                alerts={alertLines}
                derivatives={data.derivatives}
                panels={st.panels}
                tick={data.tick}
                dataKey={symbol}
                onNeedOlder={data.loadOlder}
                live={data.live}
                drawings={drawingsProps}
                onReady={onReady}
                legend={legend}
                scale={st.scale}
                overlay={overlayCandles}
                paneLayout={st.paneLayout}
                onPaneLayout={setPaneLayout}
                onRemovePane={removePane}
                onInstanceParams={setInstanceParams}
                paneHint
                corner={desktop && !sel && !dr.limitHit ? <ChartCorner onZoom={zoom} onReset={reset} /> : null}
                topRight={dr.tool ? <DrawModeChip tool={t(TOOL_TITLES[dr.tool])} hint={t(drawHint(dr.tool, dr.step))} finish={dr.series && dr.step === 0} onExit={finishTool} /> : null}
                onAxisHeight={setAxisH}
                cards={cardsEl}
              />
            )}
            {(sel || dr.limitHit) && (
              <div ref={setCardsEl} className={s.cards}>
                {dr.limitHit && <DrawingLimitCard limit={dr.limit} guest={!user} onDismiss={dr.dismissLimit} />}
                {sel && <SelectedDrawingCard drawing={sel} symbol={symbol} tf={tf} instruments={instruments} pos={pos} tick={data.tick} compact={!desktop} onPatch={dr.actions.patch} onEdit={dr.actions.move} onLock={dr.actions.lock} onRemove={dr.actions.remove} onDeselect={deselectDrawing} onAlert={alertOnLevel} onCopy={copyDrawing} />}
              </div>
            )}
            {/* тост: единственный role=status на странице; поверх колонки графика, раскладку не сдвигает */}
            {toast && (
              <p role="status" className={s.toast}>
                {toast}
              </p>
            )}
            {sheet && !desktop && (
              <BottomSheet title={sheet === "indicators" ? t("Индикаторы") : sheet === "layers" ? t("Слои") : sheet === "found" ? t("Найдено на графике") : sheet === "ask" ? t("Вопрос о графике") : sheet === "alert" ? t("Алерт по цене") : t("Рисование")} onClose={closeSheet}>
                {sheet === "alert" && (
                  <form
                    aria-label={t("новый алерт по цене")}
                    onSubmit={(e) => {
                      e.preventDefault();
                      addPriceAlert(alertDraft.price, alertDraft.op, alertDraft.op === "enter_range" ? alertDraft.price2 : undefined, undefined, alertDraft.frequency);
                    }}
                  >
                    <label>
                      {t("условие")}
                      <select aria-label={t("условие цены")} value={alertDraft.op} onChange={(e) => setAlertDraft({ ...alertDraft, op: e.target.value as typeof alertDraft.op })}>
                        <option value="cross_up">{t("пересечение вверх")}</option>
                        <option value="cross_down">{t("пересечение вниз")}</option>
                        <option value="enter_range">{t("вход в диапазон")}</option>
                      </select>
                    </label>
                    <label>
                      {t("цена")}
                      <input aria-label={t("цена алерта")} inputMode="decimal" required value={alertDraft.price} onChange={(e) => setAlertDraft({ ...alertDraft, price: e.target.value })} />
                    </label>
                    {alertDraft.op === "enter_range" && (
                      <label>
                        {t("вторая граница")}
                        <input aria-label={t("вторая граница")} inputMode="decimal" required value={alertDraft.price2} onChange={(e) => setAlertDraft({ ...alertDraft, price2: e.target.value })} />
                      </label>
                    )}
                    <label>
                      {t("срабатывание")}
                      <select aria-label={t("частота")} value={alertDraft.frequency} onChange={(e) => setAlertDraft({ ...alertDraft, frequency: e.target.value as typeof alertDraft.frequency })}>
                        <option value="once">{t("один раз")}</option>
                        <option value="every">{t("каждый раз")}</option>
                        <option value="once_per_bar">{t("раз в свечу")}</option>
                      </select>
                    </label>
                    <button type="submit" className={s.chip}>
                      {t("Создать алерт")}
                    </button>
                    <p className="caption">
                      {t("Проверка по минутным свечам, до 60 с. Активных по инструменту: {n}.", { n: alerts.length })} <Link href="/alerts">{t("Все алерты")}</Link>
                    </p>
                  </form>
                )}
                {sheet === "ask" && <AskBox symbol={symbol} tf={tf} access={askAccess} heading={false} />}
                {sheet === "found" && <FoundTab store={store} data={foundData} ask={false} />}
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
                      <input type="checkbox" checked={dr.magnet} onChange={(e) => dr.setMagnet(e.target.checked)} /> {t("магнит к OHLC")}
                    </label>
                    <label>
                      <input type="checkbox" checked={dr.series} onChange={(e) => dr.setSeries(e.target.checked)} /> {t("рисовать серию")}
                      <span className="caption">{t("инструмент не снимается после рисунка")}</span>
                    </label>
                    <label>
                      <input type="checkbox" checked={dr.state.hidden} onChange={(e) => dr.actions.hide(e.target.checked)} /> {t("скрыть все рисунки")}
                    </label>
                    <button
                      type="button"
                      className={s.chip}
                      disabled={dr.items.length === 0}
                      onClick={() => {
                        if (confirm(t("Удалить все рисунки по {symbol} ({n})?", { symbol, n: dr.items.length }))) dr.actions.clear();
                      }}
                    >
                      {t("удалить все")}
                    </button>
                  </>
                )}
                {sheet === "found" || sheet === "alert" || sheet === "ask"
                  ? null
                  : sheet === "indicators"
                    ? [
                        ...INDICATORS.map((i) => (
                          <label key={i.id}>
                            <input type="checkbox" checked={indicatorIds.has(i.id)} onChange={() => toggleIndicator(i.id)} />
                            <span className={s.indDot} style={{ background: `var(${IND_COLOR_VAR[indicatorColor(i.id)]})` }} aria-hidden="true" /> {t(i.title)}
                            <span className="caption">{i.pane === "overlay" ? t("на графике") : t("панель")}</span>
                          </label>
                        )),
                        ...PANELS.map((pn) => (
                          <label key={pn.id}>
                            <input type="checkbox" checked={st.panels.includes(pn.id)} onChange={() => togglePanel(pn.id)} /> {t(pn.title)}
                            <span className="caption">{pn.id === "liq" ? t("панель · данные публичного потока, не полный объём") : t("панель · деривативы")}</span>
                          </label>
                        )),
                      ]
                    : sheet === "layers"
                      ? [
                          <MarkupPicker key="markup" markup={st.markup} custom={resolved.custom} onSelect={selectMarkup} liqUnavailable={liqUnavailable} />,
                          ...layerKeysFor(authed).map((k) => (
                            <label key={k}>
                              <input type="checkbox" checked={resolved.layers[k]} onChange={() => toggleLayer(k)} /> {t(LAYER_LABEL[k])}
                              {k === "liq_map" && liqUnavailable && <span className="caption">{t("нет данных открытого интереса на этом таймфрейме")}</span>}
                            </label>
                          )),
                        ]
                      : null}
              </BottomSheet>
            )}
          </div>
          {desktop && <SidePanel store={store} tab={panelTab} onTab={setPanelTab} onClose={closePanel} overlay={panelOverlay} resize={objResize} topdown={topdown} role={role} found={foundData} drawings={panelDrawings} layers={panelLayers} layouts={panelLayouts} />}
        </div>
        {!desktop && (
          <PhoneBottom
            sheet={sheet}
            onSheet={setSheet}
            onAlert={openAlertSheet}
            indicatorsCount={st.indicators.length + st.panels.length}
            found={
              <FoundCounter store={store} figures={figures} patterns={patterns}>
                {(n) => t("Найдено ({n})", { n })}
              </FoundCounter>
            }
            alertsCount={alerts.length}
            tool={dr.tool ? t(TOOL_TITLES[dr.tool]) : null}
            canUndo={dr.canUndo}
            canRedo={dr.canRedo}
            onUndo={dr.actions.undo}
            onRedo={dr.actions.redo}
            drawingsCount={dr.items.length}
            sync={syncText}
            signalsLink={signalsLink}
          />
        )}
        {/* счётчик рисунков и синхронизация: всегда в DOM для чтения с экрана и e2e (drawings-count, drawings-sync);
            видимые — вкладка «Рисунки (n)» на десктопе и нижняя строка телефона. Без role=status: он один — тост */}
        <div className="sr-only" aria-live="polite">
          <span data-testid="drawings-count">{t("рисунков: {n}", { n: dr.items.length })}</span>
          {syncText && <span data-testid="drawings-sync">{syncText}</span>}
        </div>
      </div>
    </ChartStoreContext.Provider>
  );
}
