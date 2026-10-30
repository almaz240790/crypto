import s from "./LineArt.module.css";

/** Изометрический брусок: передняя грань, верх и бок — линиями. x, y — нижний левый угол передней грани. */
function prism(x: number, y: number, w: number, h: number, d = 10): string {
  const dx = d;
  const dy = -d * 0.58;
  return [
    `M${x},${y} h${w} v${-h} h${-w} Z`,
    `M${x},${y - h} l${dx},${dy} h${w} l${-dx},${-dy}`,
    `M${x + w},${y} l${dx},${dy} v${-h}`,
  ].join(" ");
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
}

const ART: Record<string, string> = {
  // свечи разной высоты с фитилями
  candles: [
    prism(38, 150, 22, 46),
    "M49,104 v-22 M49,150 v14",
    prism(78, 132, 22, 70),
    "M89,62 v-18 M89,132 v20",
    prism(118, 158, 22, 38),
    "M129,120 v-14 M129,158 v10",
    prism(158, 124, 22, 82),
    "M169,42 v-16 M169,124 v18",
    "M24,176 h160",
  ].join(" "),
  // стопка дисков — данные биржи
  data: [0, 1, 2]
    .map((i) => {
      const y = 70 + i * 34;
      return `M40,${y} a60,18 0 1,0 120,0 a60,18 0 1,0 -120,0 M40,${y} v18 M160,${y} v18 M40,${y + 18} a60,18 0 0,0 120,0`;
    })
    .join(" ") + " M100,40 v-18 M92,30 l8,-8 l8,8 M176,96 h16 M184,88 l8,8 l-8,8",
  // кольца с разрывами — защита
  rings: [arc(100, 100, 82, 200, 520), arc(100, 100, 64, 20, 320), arc(100, 100, 46, 140, 440), arc(100, 100, 28, -40, 250), "M100,92 v16 M92,100 h16"].join(" "),
  // лупа над линией цены
  loupe: "M92,92 m-52,0 a52,52 0 1,0 104,0 a52,52 0 1,0 -104,0 M129,129 l44,44 M138,124 l40,40 l-6,6 l-40,-40 M54,108 l14,-12 l12,8 l16,-22 l12,10 l18,-24 M54,72 h76 M54,92 h76 M54,112 h76",
};

export function LineArt({ name }: { name: keyof typeof ART }) {
  return (
    <svg className={s.art} viewBox="0 0 200 200" width="200" height="200" aria-hidden="true">
      <path d={ART[name]} />
    </svg>
  );
}

/** Миниатюры для карточки «Основы разметки»: ордер-блок, разрыв цены, смена характера. */
const THUMB: Record<string, string> = {
  ob: "M14,52 h10 v-22 h-10 Z M19,30 v-8 M19,52 v8 M34,44 h10 v-30 h-10 Z M39,14 v-6 M39,44 v6 M54,36 h10 v-26 h-10 Z M8,30 h70 M8,52 h70",
  fvg: "M12,58 h10 v-20 h-10 Z M17,38 v-6 M30,40 h10 v-28 h-10 Z M35,12 v-6 M35,40 v6 M48,28 h10 v-18 h-10 Z M53,10 v-4 M53,28 v6 M8,32 h62 M8,40 h62",
  choch: "M6,22 l14,18 l12,-12 l14,22 l10,-8 l16,20 M8,34 h50",
};

export function Thumb({ name }: { name: keyof typeof THUMB }) {
  return (
    <svg className={s.thumb} viewBox="0 0 80 64" width="92" height="74" aria-hidden="true">
      <path d={THUMB[name]} />
    </svg>
  );
}
