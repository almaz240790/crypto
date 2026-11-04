"use client";

import { NOTE_MAX, TOOL_TITLES, flipPosition, isPosition, positionParts, tickPrecision, type Drawing, type Point, type PositionStats } from "@platform/charts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, IconButton, Input, Select } from "@/components/ui";
import { IconClose } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import type { Timeframe } from "@/lib/timeframes";
import type { Instrument } from "@/lib/user";
import { applyField, formatField, samePoints, type PosField } from "./positionEdit";
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
  /** Шаг цены инструмента: поля позиции — с его точностью, новые цены — по нему. */
  tick?: string | null;
  onPatch: (id: string, patch: Partial<Drawing>) => void;
  /**
   * Правка точек полем позиции: final = false — промежуточное значение (без шага отмены), final = true — конец правки,
   * origin — точки до неё (один шаг отмены, как у перетаскивания).
   */
  onEdit?: (id: string, points: Point[], final: boolean, origin?: Point[]) => void;
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
export function SelectedDrawingCard({ drawing: d, symbol, tf, instruments, pos, tick = null, onPatch, onEdit, onLock, onRemove, onDeselect, onAlert, onCopy }: Props) {
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
      {isPosition(d.type) && onEdit && <PositionFields d={d} tick={tick} locked={d.locked} onEdit={onEdit} onPatch={onPatch} />}
      {pos && (
        <span className={s.posStats}>
          {pos.riskUsd != null && pos.size != null && (
            <>
              {t("риск")} <strong>{pos.riskUsd.toFixed(0)} USDT</strong> {t("· размер")} <strong>{pos.size.toPrecision(4)}</strong>
            </>
          )}
          {pos.riskUsd == null && <span className="caption">{t("задайте депозит и риск в настройках")}</span>}
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

const FIELD_LABEL: Readonly<Record<PosField, string>> = { entry: "Вход", stop: "Стоп", target: "Цель", rr: "R:R 1:", risk: "Риск, %" };
const FIELD_NAME: Readonly<Record<PosField, string>> = { entry: "цена входа", stop: "цена стопа", target: "цена цели", rr: "отношение прибыли к риску", risk: "риск, % от цены входа" };

/**
 * Поля позиции (ADR-0009, «Рисование», дополнение «Позиция»): вход, стоп, цель, R:R и риск, % — правка сразу видна на
 * графике; конец правки (уход из поля, Enter) — один шаг отмены от значения до правки; Esc — вернуть. Неверное
 * значение (стоп или цель не по свою сторону от входа) не применяется, поле показывает ошибку. «Перевернуть» — Long ⇄
 * Short (стоп и цель зеркально, шаг отмены).
 */
function PositionFields({ d, tick, locked, onEdit, onPatch }: { d: Drawing; tick: string | null; locked: boolean; onEdit: NonNullable<Props["onEdit"]>; onPatch: Props["onPatch"] }) {
  const t = useT();
  const p = positionParts(d);
  const digits = tickPrecision(tick);
  const tickN = tick !== null && Number(tick) > 0 ? Number(tick) : null;
  const [edit, setEdit] = useState<{ field: PosField; raw: string; error: string | null } | null>(null);
  /** Точки до правки поля: шаг отмены — от них. */
  const origin = useRef<Point[] | null>(null);
  const latest = useRef(d);
  useEffect(() => {
    latest.current = d;
  }, [d]);
  if (!p) return null;
  const finish = (cancel: boolean) => {
    const o = origin.current;
    origin.current = null;
    setEdit(null);
    if (!o) return;
    const cur = latest.current;
    if (cancel) onEdit(cur.id, o, false);
    else if (!samePoints(o, cur.points)) onEdit(cur.id, cur.points, true, o);
  };
  const change = (field: PosField, raw: string) => {
    origin.current ??= d.points.map((q) => ({ ...q }));
    const base = { type: d.type, points: origin.current };
    const r = applyField(field === "rr" || field === "risk" ? base : d, field, raw, tickN);
    if ("error" in r) return setEdit({ field, raw, error: r.error });
    setEdit({ field, raw, error: null });
    onEdit(d.id, r.points, false);
  };
  const dir = d.type === "position-long" ? "Short" : "Long";
  return (
    <div className={s.posFields} role="group" aria-label={t("параметры позиции")}>
      {(["entry", "stop", "target", "rr", "risk"] as const).map((f) => {
        const mine = edit?.field === f ? edit : null;
        return (
          <div key={f} className={s.posField}>
            {/* подпись — внутри поля сверху: на телефоне карточка ниже и закрывает меньше графика */}
            <span className={s.posCaption} aria-hidden="true">
              {t(FIELD_LABEL[f])}
            </span>
            <Input
              aria-label={t(FIELD_NAME[f])}
              mono
              inputMode="decimal"
              autoComplete="off"
              disabled={locked}
              value={mine ? mine.raw : formatField(p, f, digits)}
              error={mine?.error ? t(mine.error) : undefined}
              onChange={(e) => change(f, e.target.value)}
              onBlur={() => finish(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") {
                  e.preventDefault();
                  finish(true);
                }
              }}
            />
          </div>
        );
      })}
      <Button
        className={s.posFlip}
        disabled={locked}
        aria-label={t(dir === "Short" ? "перевернуть в Short" : "перевернуть в Long")}
        onClick={() => {
          const flipped = flipPosition(d);
          if (flipped) onPatch(d.id, flipped);
        }}
      >
        ⇅ {dir}
      </Button>
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
