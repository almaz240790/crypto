import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";
import { layoutLabels } from "../layout/labels";
import type { TextMeasurer } from "../layout/measure";
import type { LabelCandidate, PlacedLabel, Rect } from "../layout/types";
import { logicalX } from "../render/projector";
import { alpha } from "../theme";
import type { Candle, ThemeTokens } from "../types";
import { channelShift, extend, fibLevels, lineAt, positionKnobs, positionScreen, rulerInfo, type Projector, type RulerInfo } from "./geometry";
import { DRAWING_TEXT, drawingColor, drawingLabels, formatDrawingPrice, handleCandidate, handleRects, toCandidate, type DrawingLabel, type DrawingText, type MeasureText, type RiskProfile } from "./labels";
import type { DrawProjector } from "./controller";
import { atrAt } from "./position";
import { FIB_KEY_LEVELS, FIB_MINOR_ALPHA, HANDLE_PX, POSITION_FILL_ALPHA, POSITION_KNOB_R, POSITION_KNOB_TOUCH_R, isPosition, type Drawing, type Point } from "./types";

/**
 * Примитив LWC, рисующий все рисунки поверх основной серии (план 2A.5): линии, каналы, зоны,
 * Фибоначчи, позиции, заметки, временный измеритель; хэндлы у выбранного рисунка. Координаты считает
 * ``TimeProjector`` — по индексам баров с экстраполяцией за правый край.
 */
export class TimeProjector {
  private times: number[] = [];
  private step = 14400;
  constructor(private readonly chart: IChartApi, private readonly series: ISeriesApi<SeriesType>) {}

  setBars(times: number[], step: number): void {
    this.times = times;
    this.step = step;
  }

  /** Бары, по которым идёт проекция: новый проектор (серию пересоздали) продолжает с тех же. */
  bars(): { times: number[]; step: number } {
    return { times: this.times, step: this.step };
  }

  timeToLogical(time: number): number {
    const t = this.times;
    if (t.length === 0) return 0;
    const first = t[0]!, last = t[t.length - 1]!;
    if (time <= first) return (time - first) / this.step;
    if (time >= last) return t.length - 1 + (time - last) / this.step;
    let lo = 0, hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid]! < time) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    if (t[i] === time) return i;
    const a = t[i - 1]!, b = t[i]!;
    return i - 1 + (time - a) / (b - a);
  }

  logicalToTime(logical: number): number {
    const t = this.times;
    if (t.length === 0) return 0;
    const i = Math.floor(logical);
    if (i < 0) return t[0]! + logical * this.step;
    if (i >= t.length - 1) return t[t.length - 1]! + (logical - (t.length - 1)) * this.step;
    return t[i]! + (logical - i) * (t[i + 1]! - t[i]!);
  }

  /** x времени: между свечами и за краями — по доле интервала (logicalX: LWC дробному индексу даёт 0). */
  x(time: number): number | null {
    const ts = this.chart.timeScale();
    return logicalX((l) => ts.logicalToCoordinate(l as never), this.timeToLogical(time));
  }

  y(price: number): number | null {
    return this.series.priceToCoordinate(price);
  }

  timeAt(x: number): number | null {
    const l = this.chart.timeScale().coordinateToLogical(x);
    return l === null ? null : this.logicalToTime(l as number);
  }

  priceAt(y: number): number | null {
    return this.series.coordinateToPrice(y);
  }

  projector(): Projector {
    return { x: (t) => this.x(t), y: (p) => this.y(p), width: this.chart.timeScale().width(), height: this.chart.paneSize(0).height };
  }
}

/** Проекция отсоединённого примитива: координат нет, под указателем ничего. */
const DETACHED: Projector = { x: () => null, y: () => null, width: 0, height: 0 };

type Ctx = CanvasRenderingContext2D;

/** Плашка под подписью уровня: непрозрачность фона (читается поверх свечей в обеих темах). */
const LABEL_PLAQUE_ALPHA = 0.85;
/** Плашка позиции: фон — та же непрозрачность, что у плашек разметки (--chart-plaque-alpha). */
const POSITION_PLAQUE_ALPHA = 0.88;
/** Отступ текста в плашке позиции. */
const POSITION_TEXT_DX = 4;
/** Пустая полоса свечей: подписи рисунков свечи не обходят. */
const NO_CANDLES = { x0: 0, spacing: 0, halfWidth: 0, top: new Float32Array(0), bottom: new Float32Array(0) };
const NO_BUDGET = { canvas: 0, perLayer: {} };

class Renderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly src: DrawingsPrimitive,
    private readonly proj: Projector,
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const width = mediaSize.width;
      const src = this.src;
      const all = src.draft ? [...src.drawings, src.draft] : src.drawings;
      for (const d of src.ruler ? [...all, src.ruler] : all) this.drawOne(ctx, d, width);
      // подписи — поверх всех рисунков, на местах из общей раскладки с разметкой
      const { labels, placed } = src.paintLabels(ctx, this.proj);
      for (const l of labels) {
        const r = placed.get(l.id);
        if (r) this.drawLabel(ctx, l, r);
      }
      // ручки выбранного и начатого — поверх подписей; у временного измерителя ручек нет (его не правят)
      for (const d of all) if ((d === src.draft || d.id === src.selectedId) && !d.locked) this.drawHandles(ctx, d);
    });
  }

  private color(d: Drawing): string {
    return drawingColor(this.src.tokens, d.style.color);
  }

  private setStroke(ctx: Ctx, d: Drawing, color = this.color(d)): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = d.style.width;
    ctx.setLineDash(d.style.dashed ? [6, 4] : []);
  }

  private pts(d: Drawing): { x: number; y: number }[] | null {
    const out: { x: number; y: number }[] = [];
    for (const p of d.points) {
      const x = this.proj.x(p.time), y = this.proj.y(p.price);
      if (x === null || y === null) return null;
      out.push({ x, y });
    }
    return out;
  }

  /** Подпись на месте r из раскладки: текст, плашка Фибоначчи, плашка позиции или рамка заметки. */
  private drawLabel(ctx: Ctx, l: DrawingLabel, r: Rect): void {
    const t = this.src.tokens;
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = `${l.weight === 600 ? "600 " : ""}${l.px}px ${l.font === "sans" ? t.fontSans : t.fontMono}`;
    switch (l.style) {
      case "note":
        ctx.fillStyle = alpha(l.color, 0.1);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = l.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
        ctx.fillStyle = l.color;
        ctx.textBaseline = "middle";
        ctx.fillText(l.lines[0] ?? "", r.x + 6, r.y + r.h / 2);
        break;
      case "outline": {
        // плашка позиции: фон цвета области, рамка и текст — цвета зоны (цель, стоп) или нейтральные (вход)
        ctx.fillStyle = alpha(t.surface, POSITION_PLAQUE_ALPHA);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = l.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        ctx.fillStyle = l.color;
        ctx.textBaseline = "middle";
        const lh = (r.h - 2) / Math.max(1, l.lines.length);
        l.lines.forEach((line, i) => ctx.fillText(line, r.x + POSITION_TEXT_DX, r.y + 1 + lh * (i + 0.5)));
        break;
      }
      default: {
        if (l.style === "plaque") {
          ctx.fillStyle = alpha(t.surface, LABEL_PLAQUE_ALPHA);
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        ctx.fillStyle = l.color;
        ctx.textBaseline = "bottom";
        // строка за строкой (измеритель — две), низ последней — у низа плашки
        const lh = r.h / Math.max(1, l.lines.length);
        l.lines.forEach((line, i) => ctx.fillText(line, r.x + 2, r.y + lh * (i + 1)));
      }
    }
    ctx.restore();
  }

  private drawHandles(ctx: Ctx, d: Drawing): void {
    const color = this.color(d);
    const touch = this.src.touch;
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5;
    if (isPosition(d.type)) {
      // ручки позиции: вход, стоп, цель, правый край — крупнее точек (под пальцем — цель 44 px)
      const s = positionScreen(d, this.proj);
      if (s) {
        const r = touch ? POSITION_KNOB_TOUCH_R : POSITION_KNOB_R;
        const k = positionKnobs(s);
        const tones: Record<keyof typeof k, string> = { entry: this.src.tokens.text2, stop: this.src.tokens.down, target: this.src.tokens.up, end: this.src.tokens.text2 };
        for (const part of ["entry", "stop", "target", "end"] as const) {
          ctx.fillStyle = this.src.tokens.surface;
          ctx.strokeStyle = tones[part];
          ctx.beginPath();
          if (part === "end") ctx.rect(k[part].x - r * 0.6, k[part].y - r, r * 1.2, r * 2);
          else ctx.arc(k[part].x, k[part].y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
      ctx.restore();
      return;
    }
    const pts = this.pts(d);
    const r = touch ? 10 : HANDLE_PX / 2;
    for (const p of pts ?? []) {
      ctx.fillStyle = this.src.tokens.surface;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawOne(ctx: Ctx, d: Drawing, width: number): void {
    const pts = this.pts(d);
    if (!pts || pts.length === 0) return;
    const color = this.color(d);
    const [a, b, c] = pts;
    ctx.save();
    this.setStroke(ctx, d);
    switch (d.type) {
      case "hline":
      case "hray": {
        const x0 = d.type === "hline" ? 0 : a!.x;
        line(ctx, x0, a!.y, width, a!.y);
        break;
      }
      case "vline":
        line(ctx, a!.x, 0, a!.x, this.proj.height);
        break;
      case "trend":
      case "ray":
      case "extended":
      case "ruler": {
        if (!b) break;
        let { x: x1, y: y1 } = a!;
        let { x: x2, y: y2 } = b;
        if (d.type === "ray" || d.type === "extended") ({ x1, y1, x2, y2 } = extend(x1, y1, x2, y2, width, d.type === "extended"));
        line(ctx, x1, y1, x2, y2);
        if (d.type === "ruler") {
          ctx.fillStyle = alpha(color, 0.08);
          ctx.fillRect(Math.min(a!.x, b.x), Math.min(a!.y, b.y), Math.abs(b.x - a!.x), Math.abs(b.y - a!.y));
        }
        break;
      }
      case "channel": {
        if (!b) break;
        line(ctx, a!.x, a!.y, b.x, b.y);
        if (c) {
          // сдвиг — на экране (channelShift): параллельна на любой шкале цены и проходит через третью точку
          const off = channelShift(a!, b, c);
          const yA = a!.y + off, yB = b.y + off;
          line(ctx, a!.x, yA, b.x, yB);
          ctx.setLineDash([3, 3]);
          line(ctx, a!.x, (a!.y + yA) / 2, b.x, (b.y + yB) / 2);
          ctx.fillStyle = alpha(color, 0.06);
          ctx.beginPath();
          ctx.moveTo(a!.x, a!.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x, yB); ctx.lineTo(a!.x, yA); ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case "rect": {
        if (!b) break;
        const x = Math.min(a!.x, b.x), y = Math.min(a!.y, b.y), w = Math.abs(b.x - a!.x), h = Math.abs(b.y - a!.y);
        ctx.fillStyle = alpha(color, 0.12);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        break;
      }
      case "fib": {
        if (!b) break;
        // нейтральные уровни одного цвета, без заливки: 0 и 1 — сплошные, 0.5 и 0.618 — сплошные и толще,
        // остальные — пунктир полупрозрачный; подписи — на плашке, ключевые — полужирные (drawLabel)
        const left = Math.min(a!.x, b.x), right = Math.max(a!.x, b.x);
        for (const { level, price } of fibLevels(d.points[0]!, d.points[1]!, d.levels)) {
          const y = this.proj.y(price);
          if (y === null) continue;
          const key = FIB_KEY_LEVELS.includes(level);
          const solid = key || level === 0 || level === 1;
          ctx.globalAlpha = solid ? 1 : FIB_MINOR_ALPHA;
          ctx.lineWidth = key ? d.style.width + 0.5 : d.style.width;
          ctx.setLineDash(solid ? [] : [4, 3]);
          line(ctx, left, y, right, y);
          ctx.globalAlpha = 1;
        }
        break;
      }
      case "position-long":
      case "position-short": {
        // как в TradingView: зона прибыли (вход — цель) зелёная, зона риска (вход — стоп) красная, полупрозрачные —
        // свечи под ними видны; линия входа нейтральная, края зон — цветом зоны
        const s = positionScreen(d, this.proj);
        if (!s) break;
        const t = this.src.tokens;
        const w = s.xR - s.xL;
        ctx.fillStyle = alpha(t.up, POSITION_FILL_ALPHA);
        ctx.fillRect(s.xL, Math.min(s.yE, s.yT), w, Math.abs(s.yT - s.yE));
        ctx.fillStyle = alpha(t.down, POSITION_FILL_ALPHA);
        ctx.fillRect(s.xL, Math.min(s.yE, s.yS), w, Math.abs(s.yS - s.yE));
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = t.up;
        line(ctx, s.xL, s.yT, s.xR, s.yT);
        ctx.strokeStyle = t.down;
        line(ctx, s.xL, s.yS, s.xR, s.yS);
        ctx.strokeStyle = t.text2;
        line(ctx, s.xL, s.yE, s.xR, s.yE);
        break;
      }
      case "note": {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(a!.x, a!.y, 3, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
    ctx.restore();
  }
}

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

class View implements IPrimitivePaneView {
  constructor(private readonly source: DrawingsPrimitive) {}
  zOrder(): "top" {
    return "top";
  }
  renderer(): IPrimitivePaneRenderer | null {
    const s = this.source;
    if (!s.projector) return null;
    return new Renderer(s, s.projector.projector());
  }
}

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  drawings: Drawing[] = [];
  draft: Drawing | null = null;
  /**
   * Временный измеритель (план 2A.5; DrawingController.onRuler): не рисунок — не выбирается, без ручек; подпись — как у
   * начатого рисунка.
   */
  ruler: Drawing | null = null;
  selectedId: string | null = null;
  projector: TimeProjector | null = null;
  touch = false;
  /** Знаков после запятой у цен в подписях — по шагу цены инструмента; null — шаг ещё неизвестен. */
  precision: number | null = null;
  /** Депозит и доля риска из настроек: у позиции — риск в $ и объём (вторая строка плашки входа). */
  profile: RiskProfile | null = null;
  /** Тексты плашек позиции (перевод — из web). */
  text: DrawingText = DRAWING_TEXT;
  /**
   * Места подписей из общей раскладки с разметкой (ChartController.drawingLabels); без неё — своя раскладка только
   * среди подписей рисунков (график без разметки, тесты).
   */
  linked: (() => readonly PlacedLabel[] | null) | null = null;
  /** Свечи графика: у измерителя — ход в ATR(14) по закрытым свечам; без них — подпись без хода в ATR. */
  candles: (() => readonly Candle[]) | null = null;
  /**
   * Проекция для контроллера рисования. Смена типа графика пересоздаёт основную серию: примитив отсоединяется и
   * присоединяется к новой, проектор — новый. Контроллер живёт дольше, поэтому получает не сам проектор, а этот
   * объект: он каждый раз обращается к текущему. Между отсоединением и присоединением — «нет координат».
   */
  readonly live: DrawProjector = {
    timeAt: (x) => this.projector?.timeAt(x) ?? null,
    priceAt: (y) => this.projector?.priceAt(y) ?? null,
    projector: () => this.projector?.projector() ?? DETACHED,
  };
  private lastBars: { times: number[]; step: number } | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new View(this)];
  /** Растёт при каждом update(): подписи раскладки разметки — того же состояния, что и кадр. */
  private rev = 0;
  private sent: { rev: number; labels: DrawingLabel[] } | null = null;
  /** ATR(14) измерителя — кэш на тот же буфер свечей и время. */
  private atrMemo: { candles: readonly Candle[]; n: number; last: number; time: number; atr: number | null } | null = null;

  constructor(public tokens: ThemeTokens) {}

  attached(p: SeriesAttachedParameter<Time>): void {
    this.projector = new TimeProjector(p.chart, p.series);
    if (this.lastBars) this.projector.setBars(this.lastBars.times, this.lastBars.step);
    this.requestUpdate = p.requestUpdate;
  }

  detached(): void {
    this.lastBars = this.projector?.bars() ?? this.lastBars;
    this.projector = null;
    this.requestUpdate = null;
  }

  update(patch: Partial<Pick<DrawingsPrimitive, "drawings" | "draft" | "ruler" | "selectedId" | "tokens" | "touch" | "precision" | "profile" | "text">>): void {
    Object.assign(this, patch);
    this.rev++;
    this.requestUpdate?.();
  }

  private labels(proj: Projector, measure: MeasureText): DrawingLabel[] {
    return drawingLabels({ drawings: this.drawings, draft: this.draft, ruler: this.ruler, rulerStats: (p1, p2) => this.rulerStats(p1, p2), selectedId: this.selectedId, proj, tokens: this.tokens, precision: this.precision, profile: this.profile, text: this.text, measure, touch: this.touch });
  }

  /**
   * Измеритель: свечи — по свечам графика (номер свечи у проектора: пропуск в данных — не свеча), ход — в ATR(14) на
   * левой точке по закрытым свечам (незакрытая текущая его не раздувает).
   */
  private rulerStats(p1: Point, p2: Point): RulerInfo {
    const pr = this.projector;
    return rulerInfo(p1, p2, (t) => (pr ? pr.timeToLogical(t) : 0), this.closedAtr(Math.min(p1.time, p2.time)));
  }

  private closedAtr(time: number): number | null {
    const all = this.candles?.() ?? [];
    const n = all.length;
    const last = n > 0 ? all[n - 1]!.time : -1;
    const m = this.atrMemo;
    if (m && m.candles === all && m.n === n && m.last === last && m.time === time) return m.atr;
    const atr = atrAt(n > 0 && all[n - 1]!.open_ ? all.slice(0, -1) : all, time);
    this.atrMemo = { candles: all, n, last, time, atr };
    return atr;
  }

  /**
   * Кандидаты подписей рисунков для раскладки разметки (OverlayPrimitive зовёт в каждом кадре до отрисовки): ширины —
   * измерителем темы, как у подписей разметки.
   */
  labelCandidates(measure: TextMeasurer): LabelCandidate[] {
    if (!this.projector) return [];
    const proj = this.projector.projector();
    const labels = this.labels(proj, (t, f, px, w) => measure.measure(t, f, px, w).w);
    this.sent = { rev: this.rev, labels };
    return [...this.handles(proj), ...labels.map(toCandidate)];
  }

  /** Ручки выбранного и начатого рисунка — занятые места раскладки (подписи под ними не прячутся). */
  private handles(proj: Projector): LabelCandidate[] {
    return handleRects({ drawings: this.drawings, draft: this.draft, selectedId: this.selectedId, proj }, this.touch).map(handleCandidate);
  }

  /** Подписи кадра и их места: из общей раскладки, если она посчитана для этого состояния, иначе — своя раскладка. */
  paintLabels(ctx: CanvasRenderingContext2D, proj: Projector): { labels: readonly DrawingLabel[]; placed: ReadonlyMap<string, Rect> } {
    const linked = this.linked?.() ?? null;
    if (linked && this.sent && this.sent.rev === this.rev) return { labels: this.sent.labels, placed: new Map(linked.map((p) => [p.id, p.rect])) };
    const t = this.tokens;
    const labels = this.labels(proj, (text, font, px, weight) => {
      ctx.font = `${weight === 600 ? "600 " : ""}${px}px ${font === "sans" ? t.fontSans : t.fontMono}`;
      return ctx.measureText(text).width;
    });
    const vp = { width: proj.width, height: proj.height, insetTop: 0, volumeTopY: proj.height, free: null, gutter: null };
    const res = layoutLabels([...this.handles(proj), ...labels.map(toCandidate)], { candles: NO_CANDLES, rects: [] }, vp, NO_BUDGET);
    return { labels, placed: new Map((res.external ?? []).map((p) => [p.id, p.rect])) };
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}

export { formatDrawingPrice, lineAt, type Point };
