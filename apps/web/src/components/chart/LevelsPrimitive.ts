/**
 * Горизонтальные уровни и карта ликвидаций одним слоем (план 2A.4, 2A.6): вместо отдельной серии LWC
 * на каждую линию — один проход по canvas. Подписи у правого края, без наложений: при близких уровнях
 * остаётся подпись с бóльшим приоритетом.
 */
import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, IPrimitivePaneView, PrimitivePaneViewZOrder, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";

export type HLine = {
  /** null — от левого края. */
  from: Time | null;
  /** null — до правого края. */
  to: Time | null;
  price: number;
  color: string;
  /** 0 — сплошная, 1 — точки, 2 — штрих, 3 — длинный штрих. */
  style: 0 | 1 | 2 | 3;
  width?: 1 | 2;
  label?: string;
  /** Чем больше, тем важнее подпись при наложении. */
  priority?: number;
};
export type HeatBar = { price: number; weight: number };
export type Heat = { bars: HeatBar[]; step: number; fill: (weight: number) => string };
export type LevelsTokens = { surface: string; font: string };

/** Ширина карты ликвидаций — доля ширины панели; подписи не ближе этого расстояния по вертикали. */
const HEAT_WIDTH = 0.14;
const LABEL_GAP_PX = 15;
const LABEL_FONT_PX = 11;
const LABEL_PAD_PX = 4;
const DASH: Record<HLine["style"], number[]> = { 0: [], 1: [1, 3], 2: [4, 4], 3: [8, 6] };

type Drawn = { x1: number; x2: number; y: number; line: HLine };

class LevelsRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly lines: Drawn[],
    private readonly heat: { y1: number; y2: number; w: number; fill: string }[],
    private readonly width: number,
    private readonly tokens: LevelsTokens,
    private readonly part: "body" | "labels",
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const r = scope.horizontalPixelRatio;
      const v = scope.verticalPixelRatio;
      if (this.part === "labels") return this.drawLabels(ctx, r, v);
      for (const h of this.heat) {
        const top = Math.round(Math.min(h.y1, h.y2) * v);
        const height = Math.max(1, Math.round(Math.abs(h.y2 - h.y1) * v) - 1);
        const w = Math.max(1, Math.round(h.w * this.width * HEAT_WIDTH * r));
        ctx.fillStyle = h.fill;
        ctx.fillRect(Math.round(this.width * r) - w, top, w, height);
      }
      for (const { x1, x2, y, line } of this.lines) {
        ctx.strokeStyle = line.color;
        ctx.lineWidth = (line.width ?? 1) * r;
        ctx.setLineDash(DASH[line.style].map((d) => d * r));
        const yy = Math.round(y * v) + 0.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(x1 * r), yy);
        ctx.lineTo(Math.round(x2 * r), yy);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    });
  }

  /** Подписи поверх свечей: сначала важные, близкие к уже поставленным пропускаем. */
  private drawLabels(ctx: CanvasRenderingContext2D, r: number, v: number): void {
      const placed: number[] = [];
      const labeled = this.lines.filter((d) => d.line.label).sort((a, b) => (b.line.priority ?? 0) - (a.line.priority ?? 0));
      ctx.font = `${LABEL_FONT_PX * r}px ${this.tokens.font}`;
      ctx.textBaseline = "middle";
      for (const { y, line } of labeled) {
        if (placed.some((p) => Math.abs(p - y) < LABEL_GAP_PX)) continue;
        placed.push(y);
        const text = line.label!;
        const tw = ctx.measureText(text).width;
        const pad = LABEL_PAD_PX * r;
        const right = Math.round(this.width * r) - pad;
        const h = (LABEL_FONT_PX + 4) * v;
        ctx.fillStyle = this.tokens.surface;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(right - tw - pad * 2, Math.round(y * v - h / 2), tw + pad * 2, h);
        ctx.globalAlpha = 1;
        ctx.fillStyle = line.color;
        ctx.fillText(text, right - tw - pad, Math.round(y * v));
      }
  }
}

class LevelsPaneView implements IPrimitivePaneView {
  constructor(
    private readonly source: LevelsPrimitive,
    private readonly part: "body" | "labels",
  ) {}

  zOrder(): PrimitivePaneViewZOrder {
    return this.part === "labels" ? "top" : "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    const { chart, series } = this.source;
    if (!chart || !series) return null;
    const ts = chart.timeScale();
    const width = ts.width();
    const drawn: Drawn[] = [];
    for (const line of this.source.lines) {
      const y = series.priceToCoordinate(line.price);
      if (y === null) continue;
      const x1 = line.from === null ? 0 : (ts.timeToCoordinate(line.from) ?? 0);
      const x2 = line.to === null ? width : (ts.timeToCoordinate(line.to) ?? width);
      if (x2 < 0 || x1 > width) continue;
      drawn.push({ x1: Math.max(0, x1), x2: Math.min(width, x2), y, line });
    }
    const heat = [];
    const hm = this.source.heat;
    if (hm) {
      for (const b of hm.bars) {
        if (b.weight <= 0) continue;
        const y1 = series.priceToCoordinate(b.price - hm.step / 2);
        const y2 = series.priceToCoordinate(b.price + hm.step / 2);
        if (y1 === null || y2 === null) continue;
        heat.push({ y1, y2, w: b.weight, fill: hm.fill(b.weight) });
      }
    }
    return new LevelsRenderer(drawn, this.part === "body" ? heat : [], width, this.source.tokens, this.part);
  }
}

export class LevelsPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  lines: HLine[] = [];
  heat: Heat | null = null;
  tokens: LevelsTokens;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new LevelsPaneView(this, "body"), new LevelsPaneView(this, "labels")];

  constructor(tokens: LevelsTokens) {
    this.tokens = tokens;
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  set(lines: HLine[], heat: Heat | null, tokens?: LevelsTokens): void {
    this.lines = lines;
    this.heat = heat;
    if (tokens) this.tokens = tokens;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}
