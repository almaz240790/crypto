import type { IChartApi } from "lightweight-charts";

/** Снимок графика PNG с водяным знаком и ссылкой (план 3.17). Без градиентов и свечений. */
export function snapshotPng(chart: IChartApi, title: string, link: string, tokens: { surface: string; text2: string; fontMono: string }): string {
  const src = chart.takeScreenshot();
  const pad = 28;
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height + pad * 2;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = tokens.surface;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, pad);
  ctx.fillStyle = tokens.text2;
  ctx.font = `13px ${tokens.fontMono}`;
  ctx.textBaseline = "middle";
  ctx.fillText(title, 10, pad / 2);
  const foot = `Platform · ${link} · не является инвестиционной рекомендацией`;
  ctx.fillText(foot, 10, out.height - pad / 2);
  return out.toDataURL("image/png");
}

export function download(dataUrl: string, name: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  a.click();
}
