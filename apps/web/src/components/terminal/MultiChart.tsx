"use client";

/** Мультичарт (план 3.17, v2; только десктоп): 2 или 4 графика с независимыми инструментом и таймфреймом. */
import type { Timeframe } from "@platform/charts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { EmptyState } from "@/components/ui";
import { getAccessToken } from "@/lib/auth-client";
import { formatPrice } from "@/lib/format";
import { INTRADAY, TIMEFRAMES } from "@/lib/timeframes";
import { getInstruments, type Instrument } from "@/lib/user";
import s from "./terminal.module.css";
import { TerminalView, type CrosshairInfo, type LayerKey } from "./TerminalView";
import { useTerminalData } from "./useTerminalData";

type Cell = { symbol: string; tf: Timeframe };
type Saved = { count: 2 | 4; cells: Cell[] };
const STORAGE = "pl-multichart";
const DEFAULT: Saved = {
  count: 2,
  cells: [
    { symbol: "BTCUSDT", tf: "4h" },
    { symbol: "ETHUSDT", tf: "4h" },
    { symbol: "SOLUSDT", tf: "1d" },
    { symbol: "BNBUSDT", tf: "1d" },
  ],
};
const LAYERS: Record<LayerKey, boolean> = { structure: true, zones: true, levels: true, signals: true, patterns: false, figures: true };
const DESKTOP = "(min-width: 900px)";

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return DEFAULT;
    const v = JSON.parse(raw) as Partial<Saved>;
    const cells = Array.isArray(v.cells) ? v.cells.filter((c): c is Cell => typeof c?.symbol === "string" && (TIMEFRAMES as readonly string[]).includes(c?.tf)) : [];
    return { count: v.count === 4 ? 4 : 2, cells: [...cells, ...DEFAULT.cells.slice(cells.length)].slice(0, 4) };
  } catch {
    return DEFAULT;
  }
}

function ChartCell({ cell, instruments, authed, onChange }: { cell: Cell; instruments: Instrument[]; authed: boolean; onChange: (c: Cell) => void }) {
  const data = useTerminalData(cell.symbol, cell.tf, authed ? getAccessToken() : null);
  const [cross, setCross] = useState<CrosshairInfo | null>(null);
  const last = data.current ?? data.candles?.[data.candles.length - 1] ?? null;
  const price = data.price ? Number(data.price) : last?.close ?? null;
  const tfs = TIMEFRAMES.filter((t) => authed || !INTRADAY.includes(t));
  return (
    <section className={s.multiCell} aria-label={`график ${cell.symbol} ${cell.tf}`}>
      <div className={s.multiHead}>
        <select aria-label="инструмент" value={cell.symbol} onChange={(e) => onChange({ ...cell, symbol: e.target.value })}>
          {(instruments.length ? instruments : [{ symbol: cell.symbol } as Instrument]).map((i) => (
            <option key={i.symbol} value={i.symbol}>
              {i.symbol}
            </option>
          ))}
        </select>
        <select aria-label="таймфрейм" value={cell.tf} onChange={(e) => onChange({ ...cell, tf: e.target.value as Timeframe })}>
          {tfs.map((t) => (
            <option key={t} value={t}>
              {t === "4h" ? "H4" : t.toUpperCase()}
            </option>
          ))}
        </select>
        <span className="caption">
          {cross ? `O ${formatPrice(String(cross.candle.open))} C ${formatPrice(String(cross.candle.close))}` : price != null ? formatPrice(String(price)) : data.error ? "нет данных" : "…"}
        </span>
        <Link href={`/chart/${cell.symbol}/${cell.tf}`} className={s.multiOpen}>
          открыть в терминале
        </Link>
      </div>
      <div className={s.multiChart}>
        <TerminalView candles={data.candles ?? []} current={data.current} tf={cell.tf} type="candles" indicators={[]} layersOn={LAYERS} layers={data.layers} figures={data.figures?.items} derivatives={null} panels={[]} tick={data.tick} onNeedOlder={data.loadOlder} onCrosshair={setCross} />
      </div>
    </section>
  );
}

export function MultiChart() {
  const { user } = useAuth();
  const [saved, setSaved] = useState<Saved | null>(null);
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const on = () => setDesktop(mq.matches);
    queueMicrotask(() => {
      on();
      setSaved(load());
    });
    mq.addEventListener("change", on);
    getInstruments()
      .then(setInstruments)
      .catch(() => {});
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (!saved) return;
    try {
      localStorage.setItem(STORAGE, JSON.stringify(saved));
    } catch {
      /* приватный режим */
    }
  }, [saved]);
  const cells = useMemo(() => (saved ? saved.cells.slice(0, saved.count) : []), [saved]);
  if (desktop === null || !saved) return null;
  if (!desktop) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState text="Мультичарт доступен на десктопе (ширина экрана от 900 px). На телефоне откройте терминал одного инструмента." action={<Link href="/chart/BTCUSDT/4h">Открыть терминал</Link>} />
      </div>
    );
  }
  return (
    <div className={s.multi} data-count={saved.count}>
      <div className={s.multiBar}>
        <span className="text-2">Графиков:</span>
        {([2, 4] as const).map((n) => (
          <button key={n} type="button" className={s.chip} aria-pressed={saved.count === n} onClick={() => setSaved({ ...saved, count: n })}>
            {n}
          </button>
        ))}
        <span className="caption">Инструмент и таймфрейм у каждого графика свои; слои — структура, зоны, уровни, сигналы, фигуры. Рисунки и индикаторы — в терминале.</span>
      </div>
      <div className={s.multiGrid} data-count={saved.count}>
        {cells.map((c, i) => (
          <ChartCell key={i} cell={c} instruments={instruments} authed={!!user} onChange={(next) => setSaved({ ...saved, cells: saved.cells.map((x, j) => (j === i ? next : x)) })} />
        ))}
      </div>
    </div>
  );
}
