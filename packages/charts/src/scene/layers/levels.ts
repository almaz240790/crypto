import type { LevelKey } from "../../presets";
import type { TextKey } from "../text";
import type { Built, LayerBuilder } from "./common";
import { emphasize, hline } from "./common";

const LEVEL_TEXT: Readonly<Record<LevelKey, { label: TextKey; hover: TextKey; high: boolean }>> = {
  pdh: { label: "level.pdh", hover: "hover.pdh", high: true },
  pdl: { label: "level.pdl", hover: "hover.pdl", high: false },
  pwh: { label: "level.pwh", hover: "hover.pwh", high: true },
  pwl: { label: "level.pwl", hover: "hover.pwl", high: false },
};
export const LEVEL_KEYS: readonly LevelKey[] = ["pdh", "pdl", "pwh", "pwl"];

/** Максимумы и минимумы вчера и прошлой недели: точками на всю ширину, тон приглушённый. */
export const buildLevels: LayerBuilder = (ctx) => {
  const st = ctx.input.structure;
  if (!st) return [];
  const out: Built[] = [];
  for (const k of LEVEL_KEYS) {
    const id = `lvl:${k}`;
    const selected = ctx.isSelected(id);
    if (!ctx.preset.limits.levelKeys.includes(k) && !selected) continue;
    const raw = st.levels[k];
    const price = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(price)) continue;
    const d = LEVEL_TEXT[k];
    const obj = hline({
      id,
      layer: "levels",
      tone: "muted",
      priority: 40,
      price,
      from: null,
      to: null,
      style: "dotted",
      label: { text: ctx.text[d.label], tone: "muted", priority: 40, slots: d.high ? ["free-above", "line-end-above"] : ["free-below", "line-end-below"], font: "sans", show: "always" },
      hover: { title: ctx.text[d.hover], price },
    });
    out.push({ obj: emphasize(obj, selected), legend: "level" });
  }
  return out;
};
