/**
 * Горизонтальные уровни и карта ликвидаций одним слоем (план 2A.4, 2A.6). На самом графике — только тонкие
 * линии и крошечные коды (R, S, PDH, SL, TP1, BOS…), цена уровня — меткой на ценовой шкале, как в профессиональных
 * терминалах. Карта ликвидаций — полосы у правого края, суммы мелко внутри крупнейших полос.
 */
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

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
  /** Короткий код у правого края над линией: R, S, PDH, SL, TP1, BOS… */
  tag?: string;
  /** Метка с ценой на ценовой шкале: непрозрачная, чтобы деления шкалы под ней не просвечивали. */
  axis?: { text: string; textColor: string; backColor: string };
  /** Чем больше, тем важнее код при наложении. */
  priority?: number;
};
export type HeatBar = { price: number; weight: number; text?: string };
export type Heat = { bars: HeatBar[]; step: number; fill: (weight: number) => string; textColor: string };
export type LevelsTokens = { font: string };

/** Ширина карты ликвидаций — доля ширины панели. */
const HEAT_WIDTH = 0.14;
const TAG_FONT_PX = 9;
const TAG_GAP_PX = 11;
const TAG_ALPHA = 0.85;
const DASH: Record<HLine["style"], number[]> = { 0: [], 1: [1, 3], 2: [4, 4], 3: [8, 6] };

type Drawn = { x1: number; x2: number; y: number; line: HLine };
type HeatRect = { y1: number; y2: number; w: number; fill: string; text?: string };

class LevelsRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly lines: Drawn[],
    private readonly heat: HeatRect[],
    private readonly width: number,
    private readonly heatText: string,
    private readonly tokens: LevelsTokens,
    private readonly part: "body" | "tags",
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const r = scope.horizontalPixelRatio;
      const v = scope.verticalPixelRatio;
      if (this.part === "tags") return this.drawTags(ctx, r, v);
      const right = Math.round(this.width * r);
      for (const h of this.heat) {
        const top = Math.round(Math.min(h.y1, h.y2) * v);
        const height = Math.max(1, Math.round(Math.abs(h.y2 - h.y1) * v) - 1);
        const w = Math.max(1, Math.round(h.w * this.width * HEAT_WIDTH * r));
        ctx.fillStyle = h.fill;
        ctx.fillRect(right - w, top, w, height);
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

  /** Коды уровней и суммы ликвидаций: мелко, без подложек, близкие к уже поставленным пропускаем. */
  private drawTags(ctx: CanvasRenderingContext2D, r: number, v: number): void {
    ctx.font = `${TAG_FONT_PX * r}px ${this.tokens.font}`;
    ctx.textBaseline = "bottom";
    const right = Math.round(this.width * r) - 3 * r;
    const placed: number[] = [];
    const tagged = this.lines.filter((d) => d.line.tag).sort((a, b) => (b.line.priority ?? 0) - (a.line.priority ?? 0));
    ctx.globalAlpha = TAG_ALPHA;
    for (const { x2, y, line } of tagged) {
      if (placed.some((p) => Math.abs(p - y) < TAG_GAP_PX)) continue;
      placed.push(y);
      const tw = ctx.measureText(line.tag!).width;
      ctx.fillStyle = line.color;
      ctx.fillText(line.tag!, Math.min(right, Math.round(x2 * r) - 3 * r) - tw, Math.round(y * v) - 1 * v);
    }
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.heatText;
    for (const h of this.heat) {
      if (!h.text) continue;
      const tw = ctx.measureText(h.text).width;
      const w = Math.max(1, Math.round(h.w * this.width * HEAT_WIDTH * r));
      ctx.fillText(h.text, Math.round(this.width * r) - Math.max(w, tw + 6 * r) - tw - 4 * r, Math.round(((h.y1 + h.y2) / 2) * v));
    }
    ctx.globalAlpha = 1;
  }
}

class LevelsPaneView implements IPrimitivePaneView {
  constructor(
    private readonly source: LevelsPrimitive,
    private readonly part: "body" | "tags",
  ) {}

  zOrder(): PrimitivePaneViewZOrder {
    return this.part === "tags" ? "top" : "bottom";
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
    const heat: HeatRect[] = [];
    const hm = this.source.heat;
    if (hm) {
      for (const b of hm.bars) {
        if (b.weight <= 0) continue;
        const y1 = series.priceToCoordinate(b.price - hm.step / 2);
        const y2 = series.priceToCoordinate(b.price + hm.step / 2);
        if (y1 === null || y2 === null) continue;
        heat.push({ y1, y2, w: b.weight, fill: hm.fill(b.weight), text: b.text });
      }
    }
    return new LevelsRenderer(drawn, heat, width, hm?.textColor ?? "", this.source.tokens, this.part);
  }
}

class LevelAxisView implements ISeriesPrimitiveAxisView {
  constructor(
    private readonly y: number,
    private readonly line: HLine,
  ) {}
  coordinate(): number {
    return this.y;
  }
  text(): string {
    return this.line.axis!.text;
  }
  textColor(): string {
    return this.line.axis!.textColor;
  }
  backColor(): string {
    return this.line.axis!.backColor;
  }
}

export class LevelsPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  lines: HLine[] = [];
  heat: Heat | null = null;
  tokens: LevelsTokens;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new LevelsPaneView(this, "body"), new LevelsPaneView(this, "tags")];

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

  /** Цены уровней — метками на шкале; LWC сам раздвигает их, чтобы не налезали. */
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    const s = this.series;
    if (!s) return [];
    const out: ISeriesPrimitiveAxisView[] = [];
    for (const line of this.lines) {
      if (!line.axis) continue;
      const y = s.priceToCoordinate(line.price);
      if (y !== null) out.push(new LevelAxisView(y, line));
    }
    return out;
  }
}
