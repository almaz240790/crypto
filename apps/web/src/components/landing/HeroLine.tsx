import s from "./HeroLine.module.css";

const W = 1440;
const H = 420;
/** Отступ конца линии от правого края (в единицах viewBox), чтобы точка не обрезалась. */
const PAD = 36;

/**
 * Фон первого экрана: салатовая линия закрытий BTC по дневным свечам, проявляется слева направо (clip-path,
 * не зависит от длины линии и масштаба). Точка на конце — HTML-элементом: SVG растянут без сохранения пропорций.
 */
export function HeroLine({ closes }: { closes: number[] | null }) {
  if (!closes || closes.length < 2) return null;
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  const pts = closes.map((c, i) => [(i / (closes.length - 1)) * (W - PAD), H - 30 - ((c - lo) / span) * (H - 90)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  const area = `${line} L${lx.toFixed(1)},${H} L0,${H} Z`;
  return (
    <div className={s.box} aria-hidden="true">
      <svg className={s.svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
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
        <path d={line} className={s.line} />
      </svg>
      <span className={s.dot} style={{ left: `${((lx / W) * 100).toFixed(2)}%`, top: `${((ly / H) * 100).toFixed(2)}%` }} />
    </div>
  );
}
