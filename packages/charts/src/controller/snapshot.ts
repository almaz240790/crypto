/**
 * Снимок графика PNG (план 3.17): кадр LWC (takeScreenshot — все панели и шкалы вместе с разметкой примитивов),
 * сверху подпись (инструмент, таймфрейм, время), снизу строка с водяным знаком и ссылкой. Без градиентов и свечений.
 * Слова подписи и нижней строки — из web (t()), пакет их не знает.
 */
export interface SnapshotStyle {
  surface: string;
  text: string;
  fontMono: string;
}

/** Поле сверху и снизу под подпись, CSS px. */
const SNAPSHOT_PAD_PX = 28;
const SNAPSHOT_FONT_PX = 13;

export function composeSnapshot(src: HTMLCanvasElement, caption: string, footer: string, style: SnapshotStyle, doc: Pick<Document, "createElement"> = document): string {
  const out = doc.createElement("canvas");
  out.width = src.width;
  out.height = src.height + SNAPSHOT_PAD_PX * 2;
  const ctx = out.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = style.surface;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, SNAPSHOT_PAD_PX);
  ctx.fillStyle = style.text;
  ctx.font = `${SNAPSHOT_FONT_PX}px ${style.fontMono}`;
  ctx.textBaseline = "middle";
  ctx.fillText(caption, 10, SNAPSHOT_PAD_PX / 2);
  ctx.fillText(footer, 10, out.height - SNAPSHOT_PAD_PX / 2);
  return out.toDataURL("image/png");
}
