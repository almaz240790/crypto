import type { ISeriesPrimitiveAxisView } from "lightweight-charts";

/**
 * Метки на ценовой шкале (M04): постоянный пул видов. LWC кэширует обёртки видов по ссылке на массив из
 * priceAxisViews(), и новый массив на каждый вызов выбрасывал его смещения — метки прыгали и налезали друг на
 * друга. Здесь массив создаётся один раз на устройство, а виды получают итоговый y из layoutAxis через
 * fixedCoordinate(): такие метки LWC не двигает и рисует поверх своих (development.mjs, alignLabels).
 */

/** Что показать одним видом: итоговый центр, цена, цвета (контурная метка — фон поверхности, текст и засечка тоном). */
export interface AxisViewSpec {
  y: number;
  text: string;
  textColor: string;
  backColor: string;
  tick: boolean;
}

/** Нефиксированная координата: вне шкалы, чтобы LWC нигде не нарисовал метку по ней. */
const OFFSCREEN = -10000;

export class AxisLabelView implements ISeriesPrimitiveAxisView {
  spec: AxisViewSpec | null = null;
  coordinate(): number {
    return OFFSCREEN;
  }
  fixedCoordinate(): number | undefined {
    return this.spec ? this.spec.y : undefined;
  }
  text(): string {
    return this.spec?.text ?? "";
  }
  textColor(): string {
    return this.spec?.textColor ?? "transparent";
  }
  backColor(): string {
    return this.spec?.backColor ?? "transparent";
  }
  visible(): boolean {
    return this.spec !== null;
  }
  tickVisible(): boolean {
    return this.spec?.tick ?? false;
  }
}

/** Пул видов фиксированного размера: лишние метки отбрасывает бюджет шкалы ещё в раскладке. */
export class AxisViewPool {
  readonly views: readonly AxisLabelView[];

  constructor(size: number) {
    this.views = Array.from({ length: Math.max(0, size) }, () => new AxisLabelView());
  }

  get size(): number {
    return this.views.length;
  }

  /** Раздать метки видам по порядку; неиспользованные — невидимы. */
  set(specs: readonly AxisViewSpec[]): void {
    this.views.forEach((v, i) => {
      v.spec = specs[i] ?? null;
    });
  }

  /** Сколько видов сейчас показывают метку. */
  used(): number {
    return this.views.reduce((n, v) => n + (v.spec ? 1 : 0), 0);
  }
}
