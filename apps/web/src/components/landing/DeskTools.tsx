import s from "./DeskTools.module.css";

/** Инструменты чертёжника вокруг планшета (идея «Стол картографа», docs/brand/higgsfield-prompts.md): временная графика до фото. */
export function DeskTools() {
  const ticks = Array.from({ length: 41 }, (_, i) => i);
  return (
    <svg className={s.svg} viewBox="0 0 720 600" aria-hidden="true">
      {/* калька с карандашными линиями тренда */}
      <g transform="rotate(5 360 300)">
        <rect x="70" y="40" width="560" height="420" className={s.paper} />
        <path d="M100 400 L250 300 L330 340 L600 120" className={s.pencil} />
        <path d="M100 330 L600 330 M100 210 L600 210" className={s.pencilFaint} />
        <path d="M150 420 A260 260 0 0 1 560 160" className={s.pencilFaint} />
      </g>
      {/* линейка */}
      <g transform="rotate(-9 330 530)">
        <rect x="40" y="505" width="580" height="48" rx="4" className={s.ruler} />
        {ticks.map((i) => (
          <line key={i} x1={54 + i * 13.8} x2={54 + i * 13.8} y1="505" y2={505 + (i % 5 === 0 ? 18 : 10)} className={s.tick} />
        ))}
      </g>
      {/* угольник */}
      <path d="M560 30 L700 30 L700 230 Z M592 52 L680 52 L680 178 Z" className={s.square} fillRule="evenodd" />
      {/* циркуль и проведённая им дуга */}
      <path d="M640 300 m-130 0 a130 130 0 0 1 60 -110" className={s.arc} />
      <path d="M640 300 L600 430 M640 300 L686 428" className={s.compass} />
      <circle cx="640" cy="296" r="9" className={s.pivot} />
      {/* карандаш с салатовым зажимом */}
      <g transform="rotate(62 520 470)">
        <rect x="430" y="462" width="200" height="12" rx="2" className={s.pencilBody} />
        <path d="M630 462 L652 468 L630 474 Z" className={s.pencilBody} />
        <rect x="446" y="456" width="44" height="6" rx="2" className={s.clip} />
      </g>
    </svg>
  );
}
