import type { ChartOptions, DeepPartial } from "lightweight-charts";
import { ColorType, CrosshairMode, LineStyle } from "lightweight-charts";
import type { ThemeTokens } from "./types";

/** Прозрачность для hex-цвета #rrggbb → rgba(). Токены задаются в hex (план 5.3). */
/** Ширина ценовой шкалы не меньше этой: «81 118.0» моноширинным 12 px. */
const PRICE_SCALE_MIN_PX = 64;

export function alpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${a})`;
}

/** Настройки LWC из токенов: без градиентов и свечений, сетка — токен границы (план 5.6). */
export function chartOptions(t: ThemeTokens): DeepPartial<ChartOptions> {
  return {
    layout: {
      background: { type: ColorType.Solid, color: t.surface },
      textColor: t.text2,
      fontFamily: t.fontMono,
      fontSize: 11,
      panes: { separatorColor: t.border, separatorHoverColor: alpha(t.accent, 0.2), enableResize: true },
    },
    grid: { vertLines: { color: alpha(t.border, 0.6) }, horzLines: { color: alpha(t.border, 0.6) } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: t.text3, width: 1, style: LineStyle.Dashed, labelBackgroundColor: t.text },
      horzLine: { color: t.text3, width: 1, style: LineStyle.Dashed, labelBackgroundColor: t.text },
    },
    // минимальная ширина шкалы — страховка: если браузер неверно измерит текст, цены всё равно не обрежутся
    rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.08, bottom: 0.2 }, minimumWidth: PRICE_SCALE_MIN_PX },
    timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 7, minBarSpacing: 2 },
    // колесо и трекпад обрабатывает Terminal сам (см. onWheel): горизонтальный жест — прокрутка,
    // вертикальный и pinch — масштаб вокруг курсора; встроенная обработка слишком резкая на трекпаде
    handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: false },
    handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false, mouseWheel: false },
    localization: { locale: "ru-RU" },
  };
}

export function seriesColors(t: ThemeTokens) {
  return {
    candles: { upColor: t.up, downColor: t.down, borderVisible: false, wickUpColor: t.up, wickDownColor: t.down },
    bars: { upColor: t.up, downColor: t.down, thinBars: false },
    line: { color: t.accent, lineWidth: 2 as const },
    volumeUp: alpha(t.up, 0.35),
    volumeDown: alpha(t.down, 0.35),
  };
}

/** Чтение токенов из CSS-переменных элемента (в браузере). Имена — из apps/web/src/styles/tokens.css. */
export function tokensFromElement(el: HTMLElement): ThemeTokens {
  const cs = getComputedStyle(el);
  const v = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  return {
    bg: v("--bg", "#ffffff"),
    surface: v("--surface", "#ffffff"),
    border: v("--border", "#e4e2dd"),
    text: v("--text", "#1b1a17"),
    text2: v("--text-2", "#4e4b45"),
    text3: v("--text-3", "#726f68"),
    up: v("--up", "#1f8a5b"),
    down: v("--down", "#c93c3c"),
    accent: v("--accent", "#2d5bd7"),
    warn: v("--warn", "#b7791f"),
    fontSans: v("--font-sans", "system-ui"),
    fontMono: v("--font-mono", "ui-monospace"),
  };
}
