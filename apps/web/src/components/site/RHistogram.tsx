import s from "./EquityChart.module.css";

/** Гистограмма распределения результата в R по закрытым сделкам (план 3.10). Столбики без градиентов. */
export function RHistogram({ bins, width = 720, height = 160 }: { bins: { from: number | null; to: number | null; n: number }[]; width?: number; height?: number }) {
  const total = bins.reduce((a, b) => a + b.n, 0);
  if (!total) return null;
  const padL = 28;
  const padB = 22;
  const padT = 8;
  const max = Math.max(...bins.map((b) => b.n));
  const w = (width - padL - 8) / bins.length;
  const label = (b: { from: number | null; to: number | null }) =>
    b.from === null ? `< ${b.to}` : b.to === null ? `≥ ${b.from}` : `${b.from}…${b.to}`;
  return (
    <svg className={s.svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Распределение результата в R по ${total} сделкам`}>
      {bins.map((b, i) => {
        const h = (b.n / max) * (height - padT - padB);
        const x = padL + i * w;
        const y = height - padB - h;
        const neg = b.to !== null && b.to <= 0;
        return (
          <g key={i}>
            <rect x={x + 2} y={y} width={w - 4} height={h} fill={neg ? "var(--down)" : "var(--up)"} opacity={b.n ? 0.85 : 0} />
            {b.n > 0 && (
              <text className={s.label} x={x + w / 2} y={y - 3} textAnchor="middle">
                {b.n}
              </text>
            )}
            <text className={s.label} x={x + w / 2} y={height - 6} textAnchor="middle">
              {label(b)}
            </text>
          </g>
        );
      })}
      <line className={s.grid} x1={padL} x2={width - 8} y1={height - padB} y2={height - padB} />
    </svg>
  );
}
