import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";

/**
 * Линии наложенных индикаторов в процентной шкале (план 2A.3, 2A.4; ADR-0009, «Процентная шкала: индикаторы на
 * графике цены»).
 *
 * В процентном режиме LWC переводит каждую серию шкалы в проценты от её собственного первого видимого значения.
 * Наложенные индикаторы — отдельные серии на шкале цены, поэтому EMA, полосы Боллинджера и остальные линии сходились
 * в 0 % у левого края вида и дальше масштабировались каждая сама по себе: EMA рисовалась выше закрытий, когда она
 * ниже, верхняя полоса — под нижней. Общей базы у LWC нет.
 *
 * Поэтому в процентном режиме серии индикаторов LWC не рисует (Terminal выключает им lineVisible), а их линии рисует
 * этот примитив основной серии: x — по шкале времени, y — по цене через шкалу основной серии, то есть там же, где
 * стоят свечи, разметка и рисунки. В линейной и логарифмической шкале примитив ничего не рисует — линии рисуют серии.
 * Значения в легенде и под перекрестием — из тех же данных серий, цены, как и раньше.
 */

export type LineDatum = { time: number; value?: number };

/** Ломаная на экране (CSS px): null — разрыв (нет значения или координаты). */
export type LinePath = { color: string; width: number; dash: readonly number[]; points: readonly (readonly [number, number] | null)[] };

/**
 * Отрезок данных, попадающий в видимый диапазон времени [from; to], с одной точкой запаса с каждой стороны: линия
 * доходит до краёв панели, а не обрывается на первой и последней видимой свече. Данные — по возрастанию времени.
 */
export function visibleSlice<T extends { time: number }>(data: readonly T[], from: number, to: number): readonly T[] {
  let lo = 0, hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid]!.time < from) lo = mid + 1;
    else hi = mid;
  }
  const start = Math.max(0, lo - 1);
  hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid]!.time <= to) lo = mid + 1;
    else hi = mid;
  }
  return data.slice(start, Math.min(data.length, lo + 1));
}

/** Точки линии на экране: x по времени, y по цене; точка без значения или без координаты — разрыв. */
export function projectLine(data: readonly LineDatum[], x: (time: number) => number | null, y: (value: number) => number | null): (readonly [number, number] | null)[] {
  return data.map((d) => {
    if (d.value === undefined || !Number.isFinite(d.value)) return null;
    const px = x(d.time), py = y(d.value);
    return px === null || py === null ? null : ([px, py] as const);
  });
}

/** Штрих линии по LineStyle LWC (0 — сплошная, 1 — точки, 2 — штрих, 3 — длинный штрих, 4 — редкие точки). */
export function lineDash(style: number | undefined, width: number): readonly number[] {
  switch (style) {
    case 1:
      return [width, width];
    case 2:
      return [2 * width, 2 * width];
    case 3:
      return [6 * width, 6 * width];
    case 4:
      return [width, 4 * width];
    default:
      return [];
  }
}

type Ctx = CanvasRenderingContext2D;

/** Обводит ломаные: одна линия — один путь, разрыв начинает новый отрезок того же пути. */
export function strokePaths(ctx: Ctx, paths: readonly LinePath[]): void {
  for (const p of paths) {
    let open = false;
    let drawn = 0;
    ctx.beginPath();
    for (const pt of p.points) {
      if (pt === null) {
        open = false;
        continue;
      }
      if (open) ctx.lineTo(pt[0], pt[1]);
      else ctx.moveTo(pt[0], pt[1]);
      open = true;
      drawn++;
    }
    if (drawn < 2) continue;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = p.width;
    ctx.lineJoin = "round";
    ctx.setLineDash([...p.dash]);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

class Renderer implements IPrimitivePaneRenderer {
  constructor(private readonly paths: readonly LinePath[]) {}
  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useMediaCoordinateSpace(({ context }) => strokePaths(context, this.paths));
  }
}

class View implements IPrimitivePaneView {
  constructor(private readonly source: PercentLinesPrimitive) {}
  zOrder(): "normal" {
    return "normal";
  }
  renderer(): IPrimitivePaneRenderer | null {
    const paths = this.source.paths();
    return paths.length ? new Renderer(paths) : null;
  }
}

export class PercentLinesPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private main: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new View(this)];

  /**
   * lines — серии наложенных индикаторов (Terminal: линии на панели цены); active — процентная ли сейчас шкала.
   * Примитив читает данные, цвет, толщину и видимость серий в момент отрисовки: смена параметра, цвета темы, скрытие
   * экземпляра и новые свечи отдельного уведомления не требуют — LWC перерисовывает панель сам.
   */
  constructor(
    private readonly lines: () => Iterable<ISeriesApi<"Line">>,
    private readonly active: () => boolean,
  ) {}

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.main = p.series;
    this.requestUpdate = p.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.main = null;
    this.requestUpdate = null;
  }

  /** Перерисовать: сменился режим шкалы. */
  update(): void {
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Ломаные видимых линий в координатах панели; вне процентной шкалы и без основной серии — пусто. */
  paths(): LinePath[] {
    const chart = this.chart, main = this.main;
    if (!chart || !main || !this.active()) return [];
    const ts = chart.timeScale();
    const range = ts.getVisibleRange();
    if (!range) return [];
    const from = range.from as number, to = range.to as number;
    const x = (time: number) => ts.timeToCoordinate(time as Time);
    const y = (value: number) => main.priceToCoordinate(value);
    const out: LinePath[] = [];
    for (const s of this.lines()) {
      const o = s.options();
      if (!o.visible) continue;
      const points = projectLine(visibleSlice(s.data() as readonly LineDatum[], from, to), x, y);
      out.push({ color: o.color, width: o.lineWidth, dash: lineDash(o.lineStyle, o.lineWidth), points });
    }
    return out;
  }
}
