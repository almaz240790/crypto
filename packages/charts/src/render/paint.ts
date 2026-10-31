import type { PlacedLabel } from "../layout/types";
import type { ScreenObject, ScreenScene } from "../layout/project";
import { LINE_DASH } from "../scene/types";
import type { SceneObject } from "../scene/types";
import { alpha, toneColor, type ChartTheme } from "../theme";

/**
 * Отрисовка кадра сцены на холсте панели цены (план 2B.2). Три слоя, как zOrder видов примитива:
 * bottom — заливки зон, тепловая карта, профиль объёма и ореол выделения; normal — линии, ломаные, значки;
 * top — плашки и текст подписей. Координаты из ScreenScene — CSS px; рисуем в пикселях холста (bitmap),
 * чтобы линии в 1 px были чёткими. Цвета — только через toneColor из токенов --chart-*.
 */

/** То, что нужно от контекста холста (подмножество CanvasRenderingContext2D; в vitest — запись вызовов). */
export type PaintContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "arc"
  | "rect"
  | "fill"
  | "stroke"
  | "fillRect"
  | "fillText"
  | "setLineDash"
  | "quadraticCurveTo"
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "globalAlpha"
  | "font"
  | "textAlign"
  | "textBaseline"
  | "lineCap"
>;

export interface PaintScope {
  ctx: PaintContext;
  /** Пикселей холста на CSS px по горизонтали и вертикали. */
  hpr: number;
  vpr: number;
}

/** Ширина ореола выделения, CSS px; у наведения — та же, прозрачнее. */
const HALO_PX = 6;
const HOVER_HALO = 0.6;
/** Точки выбранной фигуры. */
const DOT_R = 3;
/** Зазор между полосами тепловой карты и профиля, px холста. */
const ROW_GAP = 1;

const isHalo = (obj: SceneObject, hovered: string | null): "selected" | "hover" | null => (obj.emphasis === "selected" ? "selected" : hovered !== null && (obj.id === hovered || (obj.groupId !== undefined && obj.groupId === hovered)) ? "hover" : null);

/** Чёткая горизонталь: y по сетке пикселей холста (у нечётной толщины — середина пикселя). */
function crispY(y: number, vpr: number, lw: number): number {
  const yb = Math.round(y * vpr);
  return lw % 2 === 1 ? yb + 0.5 : yb;
}

function strokePath(s: PaintScope, pts: readonly (readonly [number, number])[]): void {
  const { ctx, hpr, vpr } = s;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * hpr, y * vpr) : ctx.lineTo(x * hpr, y * vpr)));
  ctx.stroke();
}

/** Заливки, тепловая карта, профиль и ореол выделения — под свечами нет ничего, кроме заливок. */
export function paintBottom(s: PaintScope, screen: ScreenScene, theme: ChartTheme, hovered: string | null): void {
  const { ctx, hpr, vpr } = s;
  const a = theme.alphas;
  ctx.save();
  for (const { obj, geom } of screen.objects) {
    if (geom.kind === "box") {
      const k = obj.emphasis === "dimmed" ? a.dimmed : 1;
      ctx.fillStyle = alpha(toneColor(theme, obj.tone), a.zoneFill * k);
      ctx.fillRect(geom.x1 * hpr, geom.y1 * vpr, (geom.x2 - geom.x1) * hpr, (geom.y2 - geom.y1) * vpr);
    } else if (geom.kind === "heat") {
      const color = toneColor(theme, obj.tone);
      for (const r of geom.rows) {
        if (!(r.w > 0)) continue;
        ctx.fillStyle = alpha(color, r.alpha);
        const top = Math.round(r.y1 * vpr);
        ctx.fillRect(Math.round((geom.x1 - r.w) * hpr), top, Math.max(1, Math.round(r.w * hpr)), Math.max(1, Math.round((r.y2 - r.y1) * vpr) - ROW_GAP));
      }
    } else if (geom.kind === "profile") {
      const color = toneColor(theme, obj.tone);
      const k = geom.dimmed ? a.dimmed : 1;
      for (const r of geom.rows) {
        if (!(r.w > 0)) continue;
        ctx.fillStyle = alpha(color, (r.value || r.poc ? a.vpValue : a.vp) * k);
        ctx.fillRect(Math.round((geom.x1 - r.w) * hpr), Math.round(r.y1 * vpr), Math.max(1, Math.round(r.w * hpr)), Math.max(1, Math.round((r.y2 - r.y1) * vpr) - ROW_GAP));
      }
    }
  }
  // ореол: под линией выбранного или наведённого объекта, цвет самой линии не меняется
  for (const so of screen.objects) {
    const h = isHalo(so.obj, hovered);
    if (h) paintHalo(s, so, theme, h === "hover" ? a.halo * HOVER_HALO : a.halo);
  }
  ctx.restore();
}

function paintHalo(s: PaintScope, { geom }: ScreenObject, theme: ChartTheme, opacity: number): void {
  const { ctx, hpr, vpr } = s;
  const color = alpha(toneColor(theme, "selection"), opacity);
  ctx.setLineDash([]);
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = HALO_PX * hpr;
  switch (geom.kind) {
    case "hline":
      strokePath(s, [
        [geom.x1, geom.y],
        [geom.x2, geom.y],
      ]);
      break;
    case "polyline":
      for (const p of geom.paths) strokePath(s, p);
      break;
    case "box":
      ctx.lineWidth = 2 * hpr;
      ctx.beginPath();
      ctx.rect(geom.x1 * hpr, geom.y1 * vpr, (geom.x2 - geom.x1) * hpr, (geom.y2 - geom.y1) * vpr);
      ctx.stroke();
      break;
    case "glyph":
      ctx.beginPath();
      ctx.arc(geom.x * hpr, geom.y * vpr, (geom.r + HALO_PX / 2) * hpr, 0, Math.PI * 2);
      ctx.fill();
      break;
    default:
      break;
  }
}

/** Линии, ломаные и значки. Линия выбранного — толщиной 2 и непрозрачная. */
export function paintNormal(s: PaintScope, screen: ScreenScene, theme: ChartTheme): void {
  const { ctx, hpr, vpr } = s;
  ctx.save();
  ctx.lineCap = "butt";
  for (const { obj, geom } of screen.objects) {
    const color = toneColor(theme, obj.tone);
    const selected = obj.emphasis === "selected";
    ctx.globalAlpha = selected ? 1 : theme.alphas.line;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (geom.kind === "hline" && obj.kind === "hline") {
      const lw = Math.max(1, Math.round(obj.width * hpr));
      ctx.lineWidth = lw;
      ctx.setLineDash(LINE_DASH[obj.style].map((d) => d * hpr));
      const y = crispY(geom.y, vpr, lw);
      ctx.beginPath();
      ctx.moveTo(Math.round(geom.x1 * hpr), y);
      ctx.lineTo(Math.round(geom.x2 * hpr), y);
      ctx.stroke();
    } else if (geom.kind === "polyline" && obj.kind === "polyline") {
      ctx.lineWidth = Math.max(1, Math.round(obj.width * hpr));
      ctx.setLineDash(LINE_DASH[obj.style].map((d) => d * hpr));
      for (const p of geom.paths) strokePath(s, p);
      ctx.setLineDash([]);
      for (const [x, y] of geom.dots) {
        ctx.beginPath();
        ctx.arc(x * hpr, y * vpr, DOT_R * hpr, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (geom.kind === "glyph" && obj.kind === "glyph") {
      ctx.setLineDash([]);
      paintGlyph(s, obj.shape, geom.x, geom.y, geom.r);
    } else if (geom.kind === "profile") {
      // POC — линия тоном muted по строке с наибольшим объёмом
      const poc = geom.rows.find((r) => r.poc);
      if (!poc || geom.dimmed) continue;
      const lw = Math.max(1, Math.round(hpr));
      ctx.lineWidth = lw;
      ctx.setLineDash([]);
      const y = crispY((poc.y1 + poc.y2) / 2, vpr, lw);
      ctx.beginPath();
      ctx.moveTo(Math.round((geom.x1 - poc.w) * hpr), y);
      ctx.lineTo(Math.round(geom.x1 * hpr), y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Значки: треугольник — направление паттерна, ромб — без направления, кольцо — снятие ликвидности. */
export function paintGlyph(s: PaintScope, shape: "dot" | "triangle-up" | "triangle-down" | "diamond" | "ring", x: number, y: number, r: number): void {
  const { ctx, hpr, vpr } = s;
  const X = x * hpr;
  const Y = y * vpr;
  const R = r * hpr;
  ctx.beginPath();
  switch (shape) {
    case "dot":
      ctx.arc(X, Y, R, 0, Math.PI * 2);
      ctx.fill();
      return;
    case "ring":
      ctx.lineWidth = Math.max(1, 1.5 * hpr);
      ctx.arc(X, Y, R, 0, Math.PI * 2);
      ctx.stroke();
      return;
    case "triangle-up":
      ctx.moveTo(X, Y - R);
      ctx.lineTo(X + R, Y + R);
      ctx.lineTo(X - R, Y + R);
      break;
    case "triangle-down":
      ctx.moveTo(X, Y + R);
      ctx.lineTo(X + R, Y - R);
      ctx.lineTo(X - R, Y - R);
      break;
    case "diamond":
      ctx.moveTo(X, Y - R);
      ctx.lineTo(X + R, Y);
      ctx.lineTo(X, Y + R);
      ctx.lineTo(X - R, Y);
      break;
  }
  ctx.closePath();
  ctx.fill();
}

function roundRect(ctx: PaintContext, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Монохромный колокольчик алерта (план 2A.6) в квадрате size × size с левым верхним углом (x, y), px холста. */
function bell(ctx: PaintContext, x: number, y: number, size: number): void {
  const cx = x + size / 2;
  const top = y + size * 0.12;
  const base = y + size * 0.72;
  const half = size * 0.34;
  ctx.beginPath();
  ctx.moveTo(cx - half, base);
  ctx.quadraticCurveTo(cx - half * 0.8, top, cx, top);
  ctx.quadraticCurveTo(cx + half * 0.8, top, cx + half, base);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(cx - half - size * 0.06, base, (half + size * 0.06) * 2, Math.max(1, size * 0.08));
  ctx.beginPath();
  ctx.arc(cx, base + size * 0.16, size * 0.09, 0, Math.PI * 2);
  ctx.fill();
}

/** Ширина колокольчика с зазором в долях кегля (та же, что в layout/project.ts). */
const ICON_EM = 1;

/** Цвет текста подписи: сплошной цвет тона, без прозрачности. */
export function labelColor(theme: ChartTheme, label: Pick<PlacedLabel, "tone">): string {
  return toneColor(theme, label.tone);
}

/** Плашки и текст подписей: шрифт не меньше 11 px, текст сплошным цветом, у выбранного — рамка выделения. */
export function paintTop(s: PaintScope, screen: ScreenScene, theme: ChartTheme): void {
  const { ctx, hpr, vpr } = s;
  const t = theme.type;
  ctx.save();
  ctx.setLineDash([]);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const p of screen.labels.placed) {
    const x = p.rect.x * hpr;
    const y = p.rect.y * vpr;
    const w = p.rect.w * hpr;
    const h = p.rect.h * vpr;
    ctx.globalAlpha = 1;
    ctx.fillStyle = alpha(theme.palette.plaque, theme.alphas.plaque);
    roundRect(ctx, x, y, w, h, t.plaqueRadius * hpr);
    ctx.fill();
    if (p.selected) {
      ctx.strokeStyle = toneColor(theme, "selection");
      ctx.lineWidth = Math.max(1, Math.round(hpr));
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, t.plaqueRadius * hpr);
      ctx.stroke();
    }
    const color = labelColor(theme, p);
    ctx.fillStyle = color;
    let tx = x + t.plaquePadX * hpr;
    if (p.icon === "bell") {
      const size = p.px * vpr;
      bell(ctx, tx, y + (h - size) / 2, size);
      tx += p.px * ICON_EM * hpr;
    }
    const family = p.font === "mono" ? t.mono : t.sans;
    const weight = p.font === "mono" ? 500 : t.labelWeight;
    // кегль не округляем: при DPR 2.75 округление давало 10.9 CSS px
    ctx.font = `${weight} ${p.px * vpr}px ${family}`;
    ctx.fillText(p.text, tx, y + h / 2);
  }
  ctx.restore();
}
