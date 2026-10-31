import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SceneFigure, ScenePattern, SceneSignal, SceneStructure } from "../../../scene/wire";
import type { Candle, Timeframe } from "../../../types";

/** Фикстуры сцены: реальные ответы API (BTCUSDT 4h и 1w, 1000PEPEUSDT 4h, 31.10.2026), сжатые до нужных полей. */
export type SceneFixture = {
  symbol: string;
  tf: Timeframe;
  tick: string;
  candles: Candle[];
  oi: { t: number; v: number }[];
  structure: SceneStructure;
  patterns: ScenePattern[];
  figures: SceneFigure[];
  signals: SceneSignal[];
};

type Raw = Omit<SceneFixture, "candles" | "oi"> & { candles: [number, number, number, number, number, number][]; oi: [number, number][] };

export const FIXTURES = ["btc-4h-rich", "btc-1w", "pepe-4h"] as const;
export type FixtureName = (typeof FIXTURES)[number];

const cache = new Map<FixtureName, SceneFixture>();

export function loadFixture(name: FixtureName): SceneFixture {
  const hit = cache.get(name);
  if (hit) return hit;
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}.json`, import.meta.url)), "utf8")) as Raw;
  const fx: SceneFixture = {
    ...raw,
    candles: raw.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume, open_: false })),
    oi: raw.oi.map(([t, v]) => ({ t, v })),
  };
  cache.set(name, fx);
  return fx;
}
