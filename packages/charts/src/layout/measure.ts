import type { CanvasType } from "../theme";

/** Ширина текста для раскладки подписей. */
export interface TextMeasurer {
  measure(text: string, font: "sans" | "mono", px: number, weight?: number): { w: number; h: number };
  /** Сброс кэша — после document.fonts.ready, когда загрузился настоящий шрифт. */
  clear(): void;
}

type Ctx2D = { font: string; measureText(text: string): { width: number } };

function createContext(): Ctx2D | null {
  const g = globalThis as { OffscreenCanvas?: new (w: number, h: number) => { getContext(type: "2d"): Ctx2D | null }; document?: { createElement(tag: "canvas"): { getContext(type: "2d"): Ctx2D | null } } };
  if (g.OffscreenCanvas) return new g.OffscreenCanvas(1, 1).getContext("2d");
  if (g.document) return g.document.createElement("canvas").getContext("2d");
  return null;
}

/**
 * Измерение canvas-шрифтом темы, с кэшем по шрифту, размеру и тексту. Без canvas (сервер) — оценка
 * 0.6 em на символ, как у monoMeasurer.
 */
export function canvasMeasurer(type: Pick<CanvasType, "sans" | "mono" | "labelWeight">): TextMeasurer {
  let ctx: Ctx2D | null | undefined;
  const cache = new Map<string, { w: number; h: number }>();
  const fallback = monoMeasurer();
  return {
    measure(text, font, px, weight = font === "sans" ? type.labelWeight : 500) {
      const key = `${font}|${px}|${weight}|${text}`;
      const hit = cache.get(key);
      if (hit) return hit;
      if (ctx === undefined) ctx = createContext();
      let r: { w: number; h: number };
      if (ctx) {
        ctx.font = `${weight} ${px}px ${font === "sans" ? type.sans : type.mono}`;
        r = { w: ctx.measureText(text).width, h: px };
      } else r = fallback.measure(text, font, px, weight);
      cache.set(key, r);
      return r;
    },
    clear() {
      cache.clear();
    },
  };
}

/** Детерминированная ширина для тестов: charEm · px на символ (Manrope 600 11 px ≈ 0.6 em на кириллицу). */
export function monoMeasurer(charEm = 0.6): TextMeasurer {
  return {
    measure: (text, _font, px) => ({ w: [...text].length * px * charEm, h: px }),
    clear: () => {},
  };
}
