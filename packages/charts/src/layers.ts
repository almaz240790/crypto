import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";

/**
 * Слоистая модель (план 2A.2): каждый слой знает, как себя нарисовать поверх основной серии
 * (примитивы, маркеры, линии цен) и как убраться. Менеджер хранит порядок и видимость.
 */
export type LayerContext = { chart: IChartApi; main: ISeriesApi<SeriesType> };

export interface Layer {
  readonly id: string;
  attach(ctx: LayerContext): void;
  detach(): void;
  setVisible(visible: boolean): void;
}

export class LayerManager {
  private readonly layers = new Map<string, { layer: Layer; visible: boolean; order: number }>();
  private ctx: LayerContext | null = null;
  private seq = 0;

  attach(ctx: LayerContext): void {
    this.ctx = ctx;
    for (const { layer, visible } of this.sorted()) {
      layer.attach(ctx);
      layer.setVisible(visible);
    }
  }

  add(layer: Layer, visible = true): void {
    if (this.layers.has(layer.id)) this.remove(layer.id);
    this.layers.set(layer.id, { layer, visible, order: this.seq++ });
    if (this.ctx) {
      layer.attach(this.ctx);
      layer.setVisible(visible);
    }
  }

  remove(id: string): void {
    const entry = this.layers.get(id);
    if (!entry) return;
    if (this.ctx) entry.layer.detach();
    this.layers.delete(id);
  }

  setVisible(id: string, visible: boolean): void {
    const entry = this.layers.get(id);
    if (!entry) return;
    entry.visible = visible;
    if (this.ctx) entry.layer.setVisible(visible);
  }

  isVisible(id: string): boolean {
    return this.layers.get(id)?.visible ?? false;
  }

  /** Поднять слой наверх (последний рисуется поверх). */
  bringToFront(id: string): void {
    const entry = this.layers.get(id);
    if (entry) entry.order = this.seq++;
  }

  ids(): string[] {
    return this.sorted().map((e) => e.layer.id);
  }

  detachAll(): void {
    if (this.ctx) for (const { layer } of this.sorted()) layer.detach();
    this.ctx = null;
  }

  private sorted() {
    return [...this.layers.values()].sort((a, b) => a.order - b.order);
  }
}
