/** Мини-график 24 закрытий H4: одна линия цветом направления, без заливки. */
export function Sparkline({ values, up, width = 72, height = 20 }: { values: string[]; up: boolean; width?: number; height?: number }) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length < 2) return <span className="text-3">—</span>;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const pts = nums
    .map((v, i) => `${((i / (nums.length - 1)) * (width - 2) + 1).toFixed(1)},${((1 - (v - min) / span) * (height - 2) + 1).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
