"use client";

import { NOTE_MAX, TOOL_TITLES, type Drawing, type PositionStats } from "@platform/charts";
import Link from "next/link";
import { Button, IconButton, Input, Select } from "@/components/ui";
import { IconClose } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import type { Timeframe } from "@/lib/timeframes";
import type { Instrument } from "@/lib/user";
import s from "./terminal.module.css";

/** Типы рисунков с подписью (план 2A.5): заметка, прямоугольник, трендовая. */
const WITH_TEXT: ReadonlySet<Drawing["type"]> = new Set(["note", "rect", "trend"]);
/** Уровни, на которые ставится алерт «алерт на уровне». */
const LEVEL_TYPES: ReadonlySet<Drawing["type"]> = new Set(["hline", "hray"]);

type Props = {
  drawing: Drawing;
  symbol: string;
  tf: Timeframe;
  instruments: readonly Instrument[];
  /** Позиция Long/Short: R:R, риск и размер по профилю (positionStats). */
  pos: PositionStats | null;
  onPatch: (id: string, patch: Partial<Drawing>) => void;
  onLock: (id: string) => void;
  onRemove: (id: string) => void;
  onDeselect: () => void;
  /** Алерт на цене уровня (hline, hray). */
  onAlert: (drawing: Drawing) => void;
  onCopy: (id: string, target: string) => void;
};

/**
 * Карточка выбранного рисунка (план 2A.5, 2B.9 §3.7): регион «выбранный рисунок» из компонентов ui — Button,
 * Input, Select, IconButton. На десктопе — слева снизу над шкалой времени, не шире 720 px; на телефоне — во всю
 * ширину колонки графика (до C2). Имена полей и кнопок — прежние (контракт e2e).
 */
export function SelectedDrawingCard({ drawing: d, symbol, tf, instruments, pos, onPatch, onLock, onRemove, onDeselect, onAlert, onCopy }: Props) {
  const t = useT();
  const targets = instruments.filter((i) => i.symbol !== symbol);
  const posQuery = pos ? `symbol=${symbol}&direction=${pos.direction}&entry=${pos.entry}&stop=${pos.stop}&tp=${pos.target}` : "";
  return (
    <div className={s.card} role="region" aria-label={t("выбранный рисунок")}>
      <strong className={s.cardTitle}>{t(TOOL_TITLES[d.type])}</strong>
      {WITH_TEXT.has(d.type) && (
        <span className={s.cardText}>
          <Input aria-label={t("текст рисунка")} placeholder={t("подпись (до 140 символов)")} maxLength={NOTE_MAX} value={d.text ?? ""} onChange={(e) => onPatch(d.id, { text: e.target.value })} />
        </span>
      )}
      {pos && (
        <span className={s.posStats}>
          R:R <strong>{pos.rr.toFixed(2)}</strong> {t("· риск")} {pos.riskPct.toFixed(2)} %
          {pos.riskUsd != null && pos.size != null && (
            <>
              {" "}
              {t("· риск")} <strong>{pos.riskUsd.toFixed(0)} USDT</strong> {t("· размер")} <strong>{pos.size.toPrecision(4)}</strong>
            </>
          )}
          {pos.riskUsd == null && <span className="caption"> {t("· задайте депозит и риск в настройках")}</span>}
          <Link href={`/journal?${posQuery}`}>{t("в журнал")}</Link>
          <Link href={`/calculator?${posQuery}`}>{t("в калькулятор")}</Link>
        </span>
      )}
      <label className={s.cardCheck}>
        <input type="checkbox" checked={d.timeframe === null} onChange={(e) => onPatch(d.id, { timeframe: e.target.checked ? null : tf })} /> {t("на всех таймфреймах")}
      </label>
      {LEVEL_TYPES.has(d.type) && d.points[0] && <Button onClick={() => onAlert(d)}>{t("алерт на уровне")}</Button>}
      {targets.length > 0 && (
        <span className={s.cardSelect}>
          <Select
            aria-label={t("скопировать на инструмент")}
            value=""
            onChange={(e) => {
              if (e.target.value) onCopy(d.id, e.target.value);
            }}
          >
            <option value="">{t("скопировать на…")}</option>
            {targets.map((i) => (
              <option key={i.symbol} value={i.symbol}>
                {i.symbol}
              </option>
            ))}
          </Select>
        </span>
      )}
      <Button aria-pressed={d.locked} onClick={() => onLock(d.id)}>
        {d.locked ? t("разблокировать") : t("заблокировать")}
      </Button>
      <Button variant="danger" disabled={d.locked} onClick={() => onRemove(d.id)}>
        {t("удалить")}
      </Button>
      <IconButton label={t("снять выделение")} onClick={onDeselect} className={s.cardClose}>
        <IconClose />
      </IconButton>
    </div>
  );
}

/** Карточка лимита рисунков (role=alert): по центру снизу колонки графика, тем же видом; угол графика на это время скрыт. */
export function DrawingLimitCard({ limit, guest, onDismiss }: { limit: number | null; guest: boolean; onDismiss: () => void }) {
  const t = useT();
  return (
    <div className={`${s.card} ${s.limitCard}`} role="alert">
      <p>
        {t("Лимит рисунков на инструмент: {n}. Удалите лишние", { n: limit ?? "—" })}
        {guest ? t(" или войдите") : t(" или оформите подписку уровнем выше")}.
      </p>
      <Button size="sm" onClick={onDismiss}>
        {t("понятно")}
      </Button>
    </div>
  );
}
