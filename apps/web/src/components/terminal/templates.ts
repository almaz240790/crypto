import type { PanelKey } from "@platform/charts";

/**
 * Системные шаблоны индикаторов (план 2A.4): набор индикаторов и панелей. Индикаторы — в виде {id, params}:
 * при применении они проходят ту же миграцию в экземпляры (normalizeInstances), что и старые сохранения.
 */
export type Template = { id: string; title: string; indicators: readonly { id: string; params: Record<string, number> }[]; panels: readonly PanelKey[] };

export const TEMPLATES: Template[] = [
  // «Без индикаторов», а не «Чистый»: так называется пресет разметки (план 2B.2)
  { id: "clean", title: "Без индикаторов", indicators: [], panels: [] },
  { id: "platform", title: "Система PlatformSol", indicators: [{ id: "ema", params: { period: 50 } }], panels: ["funding", "oi"] },
  {
    id: "osc",
    title: "Осцилляторы",
    indicators: [
      { id: "rsi", params: { period: 14 } },
      { id: "macd", params: { fast: 12, slow: 26, signal: 9 } },
      { id: "stoch", params: { k: 14, d: 3, smooth: 3 } },
    ],
    panels: [],
  },
  { id: "deriv", title: "Деривативы", indicators: [{ id: "ema", params: { period: 50 } }], panels: ["funding", "oi", "liq"] },
];
