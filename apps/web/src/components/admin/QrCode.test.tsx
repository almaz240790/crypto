import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QrCode } from "./QrCode";

describe("QrCode", () => {
  it("рамка 4 модуля, чёткие пиксели, цвета — токены QR (тёмное на белом в любой теме)", () => {
    const html = renderToStaticMarkup(<QrCode size={21} path="M0 0h7v1h-7z" label="QR-код" />);
    expect(html).toContain('viewBox="-4 -4 29 29"');
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).toContain('fill="var(--qr-light)"');
    expect(html).toContain('fill="var(--qr-dark)"');
    expect(html).toContain('d="M0 0h7v1h-7z"');
    expect(html).toContain('aria-label="QR-код"');
  });
});
