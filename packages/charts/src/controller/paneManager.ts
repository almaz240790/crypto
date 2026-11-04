import { VIEW } from "../presets";
import type { Device } from "../types";

/**
 * Раскладка панелей под графиком (план 2A.7, PaneManager; M19): желаемые высоты дополнительных панелей
 * в пикселях, основной панели — остаток, но не меньше mainMinShare общей высоты (десктоп 0.55, телефон 0.6).
 * Если панели не помещаются, они сжимаются пропорционально. Чистая функция: terminal.layoutPanes задаёт по ней
 * stretch-факторы в пикселях — так панели не «плывут» после сворачивания и добавления.
 */
export interface PanePlan {
  main: number;
  others: number[];
}

export function planPanes(total: number, wants: readonly number[], mainMinShare: number): PanePlan {
  if (total <= 0 || wants.length === 0) return { main: Math.max(0, total), others: [] };
  const want = wants.map((h) => Math.max(1, h));
  const sum = want.reduce((a, b) => a + b, 0);
  const room = total * (1 - Math.min(1, Math.max(0, mainMinShare)));
  const k = sum > room ? room / sum : 1;
  const others = want.map((h) => h * k);
  return { main: total - others.reduce((a, b) => a + b, 0), others };
}

/** Доля основной панели по классу устройства (VIEW). */
export const mainMinShareFor = (device: Device): number => VIEW[device].mainMinShare;
