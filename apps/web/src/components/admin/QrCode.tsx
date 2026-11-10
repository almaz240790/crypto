/**
 * QR-код из пути SVG, который считает API (модуль = 1 единица, без рамки): рамка 4 модуля, тёмное на белом
 * в любой теме (токены --qr-dark / --qr-light). Пиксели не размываются (crispEdges).
 */
export function QrCode({ size, path, label, px = 200 }: { size: number; path: string; label: string; px?: number }) {
  const q = 4;
  const full = size + q * 2;
  return (
    <svg role="img" aria-label={label} width={px} height={px} viewBox={`${-q} ${-q} ${full} ${full}`} shapeRendering="crispEdges" style={{ display: "block", maxWidth: "100%", height: "auto" }}>
      <rect x={-q} y={-q} width={full} height={full} fill="var(--qr-light)" />
      <path d={path} fill="var(--qr-dark)" />
    </svg>
  );
}
