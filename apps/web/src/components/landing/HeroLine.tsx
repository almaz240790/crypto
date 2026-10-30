import s from "./HeroLine.module.css";

const W = 1440;
const H = 420;

/** Фон первого экрана: салатовая линия закрытий BTC по дневным свечам, рисуется при загрузке. Без данных — ничего. */
export function HeroLine({ closes }: { closes: number[] | null }) {
  if (!closes || closes.length < 2) return null;
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  const pts = closes.map((c, i) => [(i / (closes.length - 1)) * W, H - 30 - ((c - lo) / span) * (H - 90)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className={s.svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="hero-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className={s.stopTop} />
          <stop offset="1" className={s.stopBottom} />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className={s.grid} />
      ))}
      <path d={area} fill="url(#hero-area)" className={s.area} />
      <path d={line} className={s.line} pathLength={1} />
      <circle cx={lx} cy={ly} r="5" className={s.dot} />
    </svg>
  );
}
