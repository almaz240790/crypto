import s from "./EquityChart.module.css";

/** Кривая капитала в R: без заливки под линией, сетка из токенов (план 5.6). */
export function EquityChart({
  points,
  width = 720,
  height = 200,
}: {
  points: { t: string; r: number }[];
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const padL = 44;
  const padR = 8;
  const padT = 8;
  const padB = 20;
  const xs = points.map((p) => new Date(p.t).getTime());
  const ys = points.map((p) => p.r);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(0, ...ys);
  const span = yMax - yMin || 1;
  const X = (t: number) => padL + ((t - x0) / (x1 - x0 || 1)) * (width - padL - padR);
  const Y = (r: number) => padT + ((yMax - r) / span) * (height - padT - padB);
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(p.r).toFixed(1)}`).join(" ");
  const ticks = [yMin, (yMin + yMax) / 2, yMax].map((v) => Math.round(v * 10) / 10);
  const first = new Date(x0);
  const last = new Date(x1);
  const fmt = (dt: Date) =>
    `${String(dt.getUTCDate()).padStart(2, "0")}.${String(dt.getUTCMonth() + 1).padStart(2, "0")}.${String(dt.getUTCFullYear()).slice(2)}`;
  return (
    <div className={s.wrap}>
      <svg
        className={s.svg}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Накопленный результат в R: от ${ys[0]} до ${ys[ys.length - 1]}`}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line className={s.grid} x1={padL} x2={width - padR} y1={Y(v)} y2={Y(v)} />
            <text className={s.label} x={padL - 6} y={Y(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {yMin < 0 && yMax > 0 && (
          <line className={s.zero} x1={padL} x2={width - padR} y1={Y(0)} y2={Y(0)} />
        )}
        <path className={s.line} d={d} />
        <text className={s.label} x={padL} y={height - 5}>
          {fmt(first)}
        </text>
        <text className={s.label} x={width - padR} y={height - 5} textAnchor="end">
          {fmt(last)}
        </text>
      </svg>
    </div>
  );
}
