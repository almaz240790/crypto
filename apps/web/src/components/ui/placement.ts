/**
 * Положение всплывающего окна (Popover, Menu) у якоря — чистая функция, position: fixed.
 * Под якорем; если снизу не помещается, а сверху места больше — над ним. По горизонтали — прижать
 * к окну с отступом margin. Высота ограничивается доступным местом (maxHeight → прокрутка внутри).
 */

export type Box = { left: number; top: number; width: number; height: number };
export type Align = "start" | "end" | "center";
export type Placed = { left: number; top: number; side: "bottom" | "top"; maxHeight: number };

export function placePopup(anchor: Box, popup: { width: number; height: number }, viewport: { width: number; height: number }, opts: { align?: Align; offset?: number; margin?: number } = {}): Placed {
  const align = opts.align ?? "start";
  const offset = opts.offset ?? 4;
  const margin = opts.margin ?? 8;
  const below = viewport.height - (anchor.top + anchor.height) - offset - margin;
  const above = anchor.top - offset - margin;
  const side: Placed["side"] = popup.height <= below || below >= above ? "bottom" : "top";
  const room = Math.max(0, side === "bottom" ? below : above);
  const h = Math.min(popup.height, room);
  const top = side === "bottom" ? anchor.top + anchor.height + offset : anchor.top - offset - h;
  const x = align === "end" ? anchor.left + anchor.width - popup.width : align === "center" ? anchor.left + (anchor.width - popup.width) / 2 : anchor.left;
  const maxLeft = viewport.width - margin - popup.width;
  const left = Math.max(margin, Math.min(x, maxLeft));
  return { left: Math.round(left), top: Math.round(top), side, maxHeight: Math.floor(room) };
}
