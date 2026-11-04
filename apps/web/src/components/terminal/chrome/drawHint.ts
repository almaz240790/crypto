import { pointsNeeded, type DrawingType } from "@platform/charts";

const POSITION_STEPS = ["Нажмите цену входа", "Нажмите стоп", "Нажмите цель"] as const;
const POINT_STEPS = ["Нажмите первую точку", "Нажмите вторую точку", "Нажмите третью точку"] as const;

/**
 * Подсказка шага в чипе режима рисования (ключ для t(), ADR-0009 «Рисование»): какую точку нажать следующей.
 * placed — сколько точек начатого рисунка уже поставлено (0 — рисунок не начат).
 */
export function drawHint(tool: DrawingType, placed: number): string {
  const steps = tool === "position-long" || tool === "position-short" ? POSITION_STEPS : pointsNeeded(tool) === 1 ? (["Нажмите на график"] as const) : POINT_STEPS;
  return steps[Math.min(Math.max(placed, 0), steps.length - 1)]!;
}

/** Все подсказки — для проверки словаря. */
export const DRAW_HINTS: readonly string[] = [...POSITION_STEPS, ...POINT_STEPS, "Нажмите на график"];
