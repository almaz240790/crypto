import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";
import type { ThemeTokens } from "../types";
import { alpha } from "../theme";
import { channelOffset, extend, fibLevels, lineAt, type Projector } from "./geometry";
import { HANDLE_PX, type Drawing, type Point } from "./types";

/**
 * Примитив LWC, рисующий все рисунки поверх основной серии (план 2A.5): линии, каналы, зоны,
 * Фибоначчи, позиции, заметки, измеритель; хэндлы у выбранного рисунка. Координаты считает
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

  x(time: number): number | null {
    return this.chart.timeScale().logicalToCoordinate(this.timeToLogical(time) as never);
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

type Ctx = CanvasRenderingContext2D;

class Renderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly drawings: Drawing[],
    private readonly draft: Drawing | null,
    private readonly selectedId: string | null,
    private readonly proj: Projector,
    private readonly tokens: ThemeTokens,
    private readonly touch: boolean,
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const width = mediaSize.width;
      for (const d of this.drawings) this.drawOne(ctx, d, width, d.id === this.selectedId);
      if (this.draft) this.drawOne(ctx, this.draft, width, true);
    });
  }

  private color(d: Drawing): string {
    const t = this.tokens;
    const map: Record<string, string> = { accent: t.accent, up: t.up, down: t.down, warn: t.warn, text2: t.text2, text3: t.text3 };
    return map[d.style.color] ?? t.accent;
  }

  private setStroke(ctx: Ctx, d: Drawing, color = this.color(d)): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = d.style.width;
    ctx.setLineDash(d.style.dashed ? [6, 4] : []);
  }

  private label(ctx: Ctx, text: string, x: number, y: number, color: string): void {
    ctx.font = `11px ${this.tokens.fontMono}`;
    ctx.fillStyle = color;
    ctx.textBaseline = "bottom";
    ctx.fillText(text, x + 4, y - 3);
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

  private drawOne(ctx: Ctx, d: Drawing, width: number, selected: boolean): void {
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
        this.label(ctx, fmt(d.points[0]!.price), x0, a!.y, color);
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
        if (d.type === "trend" || d.type === "ruler") {
          const p1 = d.points[0]!, p2 = d.points[1]!;
          const pct = p1.price ? ((p2.price - p1.price) / p1.price) * 100 : 0;
          this.label(ctx, `${pct >= 0 ? "+" : ""}${pct.toFixed(2)} %${d.text ? " · " + d.text : ""}`, b.x, b.y, color);
          if (d.type === "ruler") {
            ctx.fillStyle = alpha(color, 0.08);
            ctx.fillRect(Math.min(a!.x, b.x), Math.min(a!.y, b.y), Math.abs(b.x - a!.x), Math.abs(b.y - a!.y));
          }
        }
        break;
      }
      case "channel": {
        if (!b) break;
        line(ctx, a!.x, a!.y, b.x, b.y);
        if (c) {
          const off = channelOffset(d.points[0]!, d.points[1]!, d.points[2]!);
          const yA = this.proj.y(d.points[0]!.price + off), yB = this.proj.y(d.points[1]!.price + off);
          if (yA !== null && yB !== null) {
            line(ctx, a!.x, yA, b.x, yB);
            ctx.setLineDash([3, 3]);
            line(ctx, a!.x, (a!.y + yA) / 2, b.x, (b.y + yB) / 2);
            ctx.fillStyle = alpha(color, 0.06);
            ctx.beginPath();
            ctx.moveTo(a!.x, a!.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x, yB); ctx.lineTo(a!.x, yA); ctx.closePath();
            ctx.fill();
          }
        }
        break;
      }
      case "rect": {
        if (!b) break;
        const x = Math.min(a!.x, b.x), y = Math.min(a!.y, b.y), w = Math.abs(b.x - a!.x), h = Math.abs(b.y - a!.y);
        ctx.fillStyle = alpha(color, 0.12);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        if (d.text) this.label(ctx, d.text, x, y + 14, color);
        break;
      }
      case "fib": {
        if (!b) break;
        const left = Math.min(a!.x, b.x), right = Math.max(a!.x, b.x);
        for (const { level, price } of fibLevels(d.points[0]!, d.points[1]!, d.levels)) {
          const y = this.proj.y(price);
          if (y === null) continue;
          ctx.setLineDash(level === 0 || level === 1 ? [] : [4, 3]);
          line(ctx, left, y, right, y);
          this.label(ctx, `${level} · ${fmt(price)}`, right, y, color);
        }
        break;
      }
      case "position-long":
      case "position-short": {
        if (!b) break;
        const entry = d.points[0]!, stop = d.points[1]!, target = d.points[2] ?? null;
        const x = Math.min(a!.x, b.x), w = Math.max(Math.abs(b.x - a!.x), 40);
        const yE = a!.y, yS = b.y;
        ctx.fillStyle = alpha(this.tokens.down, 0.15);
        ctx.fillRect(x, Math.min(yE, yS), w, Math.abs(yS - yE));
        if (c) {
          ctx.fillStyle = alpha(this.tokens.up, 0.15);
          ctx.fillRect(x, Math.min(yE, c.y), w, Math.abs(c.y - yE));
        }
        ctx.setLineDash([]);
        ctx.strokeStyle = this.tokens.text2;
        line(ctx, x, yE, x + w, yE);
        this.label(ctx, `вход ${fmt(entry.price)}`, x, yE, this.tokens.text2);
        ctx.strokeStyle = this.tokens.down;
        line(ctx, x, yS, x + w, yS);
        this.label(ctx, `стоп ${fmt(stop.price)}`, x, yS, this.tokens.down);
        if (c && target) {
          ctx.strokeStyle = this.tokens.up;
          line(ctx, x, c.y, x + w, c.y);
          const risk = Math.abs(entry.price - stop.price);
          const rr = risk ? Math.abs(target.price - entry.price) / risk : 0;
          this.label(ctx, `цель ${fmt(target.price)} · R:R ${rr.toFixed(2)}`, x, c.y, this.tokens.up);
        }
        break;
      }
      case "note": {
        ctx.font = `12px ${this.tokens.fontSans}`;
        const text = d.text ?? "";
        const w = ctx.measureText(text).width + 12;
        ctx.fillStyle = alpha(color, 0.1);
        ctx.fillRect(a!.x + 6, a!.y - 20, w, 18);
        ctx.strokeRect(a!.x + 6.5, a!.y - 19.5, w, 18);
        ctx.fillStyle = color;
        ctx.textBaseline = "middle";
        ctx.fillText(text, a!.x + 12, a!.y - 11);
        ctx.beginPath();
        ctx.arc(a!.x, a!.y, 3, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
    if (selected && !d.locked) {
      const r = this.touch ? 10 : HANDLE_PX / 2;
      for (const p of pts) {
        ctx.setLineDash([]);
        ctx.fillStyle = this.tokens.surface;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
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

function fmt(p: number): string {
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toPrecision(4);
}

class View implements IPrimitivePaneView {
  constructor(private readonly source: DrawingsPrimitive) {}
  zOrder(): "top" {
    return "top";
  }
  renderer(): IPrimitivePaneRenderer | null {
    const s = this.source;
    if (!s.projector) return null;
    return new Renderer(s.drawings, s.draft, s.selectedId, s.projector.projector(), s.tokens, s.touch);
  }
}

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  drawings: Drawing[] = [];
  draft: Drawing | null = null;
  selectedId: string | null = null;
  projector: TimeProjector | null = null;
  touch = false;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new View(this)];

  constructor(public tokens: ThemeTokens) {}

  attached(p: SeriesAttachedParameter<Time>): void {
    this.projector = new TimeProjector(p.chart, p.series);
    this.requestUpdate = p.requestUpdate;
  }

  detached(): void {
    this.projector = null;
    this.requestUpdate = null;
  }

  update(patch: Partial<Pick<DrawingsPrimitive, "drawings" | "draft" | "selectedId" | "tokens" | "touch">>): void {
    Object.assign(this, patch);
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}

export { lineAt, type Point };
