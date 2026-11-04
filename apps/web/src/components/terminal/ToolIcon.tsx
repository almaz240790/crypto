import type { DrawingType } from "@platform/charts";

/** Значки инструментов рисования (план 2A.8): 18 px, линия currentColor — цвет берётся из темы. */
const PATHS: Record<DrawingType | "magnet" | "undo" | "redo" | "eye" | "eyeOff", string> = {
  hline: "M2 9h14",
  hray: "M3 9h11M12 6.5 14.5 9 12 11.5M3 7.5v3",
  vline: "M9 2v14",
  trend: "M3 15 15 3M3 15h0M15 3h0",
  ray: "M3 15 13 5M10.5 4.5 13.5 4.5 13.5 7.5",
  extended: "M2 16 16 2",
  channel: "M2 12 12 2M6 16 16 6",
  rect: "M3 5h12v8H3z",
  // уровни 0 / 0.382 / 0.618 / 1 с неравным шагом (диагональ пунктиром — отдельно), чтобы не читалось как «бургер»
  fib: "M2 3h14M2 7.6h14M2 10.4h14M2 15h14",
  "position-long": "M3 13h12M3 9h12M9 13V4M6.5 6.5 9 4l2.5 2.5",
  "position-short": "M3 5h12M3 9h12M9 5v9M6.5 11.5 9 14l2.5-2.5",
  note: "M4 4h10M9 4v11",
  ruler: "M2 9h14M4.5 6.5 2 9l2.5 2.5M13.5 6.5 16 9l-2.5 2.5",
  magnet: "M5 3v6a4 4 0 0 0 8 0V3M5 6h3M10 6h3",
  undo: "M6 4 3 7l3 3M3 7h7a5 5 0 0 1 0 10H8",
  redo: "M12 4l3 3-3 3M15 7H8a5 5 0 0 0 0 10h2",
  eye: "M1.5 9S4.5 4 9 4s7.5 5 7.5 5-3 5-7.5 5S1.5 9 1.5 9ZM9 11.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z",
  eyeOff: "M1.5 9S4.5 4 9 4s7.5 5 7.5 5-3 5-7.5 5S1.5 9 1.5 9ZM3 15 15 3",
};

export function ToolIcon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
      {(name === "trend" || name === "channel") && <circle cx={name === "trend" ? 3 : 2} cy={name === "trend" ? 15 : 12} r="1.4" fill="currentColor" />}
      {name === "fib" && <path d="M3 15 15 3" strokeWidth="1" strokeDasharray="1.5 2" />}
    </svg>
  );
}
