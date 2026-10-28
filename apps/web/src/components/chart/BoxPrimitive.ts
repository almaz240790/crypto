/**
 * Прямоугольник «время × цена» для Lightweight Charts v5 (зона входа, план 5.6):
 * заливка 12 % акцентного цвета, граница 1px. Без градиентов и теней.
 */
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  SeriesAttachedParameter,
  PrimitivePaneViewZOrder,
  SeriesType,
  Time,
} from "lightweight-charts";

export type Box = {
  id: string;
  from: Time;
  to: Time | null; // null — до правого края
  top: number;
  bottom: number;
  fill: string;
  stroke: string;
  label?: string;
  /** Подпись у правого края на подложке (терминал) или у левого (карточка сигнала). */
  labelAlign?: "left" | "right";
  labelBg?: string;
  /** Цвет подписи; по умолчанию — цвет рамки. */
  labelColor?: string;
  /** Размер подписи, px (по умолчанию 11). */
  labelSize?: number;
  highlighted?: boolean;
};

class BoxRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly rects: { x1: number; x2: number; y1: number; y2: number; box: Box }[],
    private readonly part: "body" | "labels",
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const r = scope.horizontalPixelRatio;
      const v = scope.verticalPixelRatio;
      for (const { x1, x2, y1, y2, box } of this.rects) {
        const left = Math.round(Math.min(x1, x2) * r);
        const width = Math.max(1, Math.round(Math.abs(x2 - x1) * r));
        const top = Math.round(Math.min(y1, y2) * v);
        const height = Math.max(1, Math.round(Math.abs(y2 - y1) * v));
        if (this.part === "labels") {
          if (!box.label) continue;
          ctx.font = `${(box.labelSize ?? 11) * r}px ui-monospace, monospace`;
          ctx.textBaseline = "top";
          const tw = ctx.measureText(box.label).width;
          const pad = 4 * r;
          const x = box.labelAlign === "right" ? left + width - tw - pad * 2 : left + pad;
          if (box.labelBg) {
            ctx.fillStyle = box.labelBg;
            ctx.globalAlpha = 0.85;
            ctx.fillRect(x - pad / 2, top + 2 * v, tw + pad, 15 * v);
            ctx.globalAlpha = 1;
          }
          ctx.fillStyle = box.labelColor ?? box.stroke;
          ctx.fillText(box.label, x, top + 4 * v);
          continue;
        }
        ctx.fillStyle = box.fill;
        ctx.fillRect(left, top, width, height);
        ctx.strokeStyle = box.stroke;
        ctx.lineWidth = (box.highlighted ? 2 : 1) * r;
        ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
      }
    });
  }
}

class BoxPaneView implements IPrimitivePaneView {
  constructor(
    private readonly source: BoxPrimitive,
    private readonly part: "body" | "labels",
  ) {}

  /** Заливка под свечами, подписи поверх. */
  zOrder(): PrimitivePaneViewZOrder {
    return this.part === "labels" ? "top" : "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    const { chart, series } = this.source;
    if (!chart || !series) return null;
    const ts = chart.timeScale();
    const width = ts.width();
    const rects = [];
    for (const box of this.source.boxes) {
      const x1 = ts.timeToCoordinate(box.from);
      const x2 = box.to === null ? width : ts.timeToCoordinate(box.to);
      const y1 = series.priceToCoordinate(box.top);
      const y2 = series.priceToCoordinate(box.bottom);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      rects.push({ x1, x2, y1, y2, box });
    }
    return new BoxRenderer(rects, this.part);
  }
}

export class BoxPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  boxes: Box[] = [];
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new BoxPaneView(this, "body"), new BoxPaneView(this, "labels")];

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

  setBoxes(boxes: Box[]): void {
    this.boxes = boxes;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}
