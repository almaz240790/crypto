"use client";

import { FIB_LEVELS, FIB_LEVEL_GROUPS, FIB_PRESET_LEVELS, NOTE_MAX, TOOL_TITLES, fibLevelGroup, fibLevelText, flipPosition, isPosition, normalizeFibLevels, positionParts, positionRiskText, roundToTick, tickPrecision, toggleFibLevel, type Drawing, type FibLevelGroup, type Point, type PositionStats } from "@platform/charts";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
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
  /**
   * Телефон: карточка позиции — одна строка (название, «перевернуть», «параметры», закрыть), пока её не раскрыли:
   * раскрытая закрывала половину свечей, а с ней ручку и плашку цели у Short (ADR-0009, «Рисование»). Карточка
   * Фибоначчи — так же: название, «уровни», закрыть; раскрытая — уровни одной прокручиваемой строкой и остальное.
   */
  compact?: boolean;
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
 * Input, Select, IconButton. На десктопе — слева снизу над шкалой времени, не шире 720 px (у Фибоначчи — 800: с
 * кнопкой «уровни» свёрнутая карточка остаётся одной строкой); на телефоне — во всю ширину колонки графика (до C2).
 * Имена полей и кнопок — прежние (контракт e2e).
 */
export function SelectedDrawingCard({ drawing: d, symbol, tf, instruments, pos, tick = null, compact = false, onPatch, onEdit, onLock, onRemove, onDeselect, onAlert, onCopy }: Props) {
  const t = useT();
  /**
   * Раскрытая карточка (по рисунку: другой выбранный — снова свёрнута): у позиции на телефоне — поля и остальное, у
   * Фибоначчи — уровни (на телефоне — и остальное).
   */
  const [openId, setOpenId] = useState<string | null>(null);
  const levelsId = useId();
  const targets = instruments.filter((i) => i.symbol !== symbol);
  const tickN = tick !== null && Number(tick) > 0 ? Number(tick) : null;
  // цены — по шагу инструмента: в журнал и калькулятор без хвостов float (сохранённые раньше позиции)
  const q = (v: number) => roundToTick(v, tickN);
  const posQuery = pos ? `symbol=${symbol}&direction=${pos.direction}&entry=${q(pos.entry)}&stop=${q(pos.stop)}&tp=${q(pos.target)}` : "";
  const fib = d.type === "fib";
  const open = openId === d.id;
  const fold = compact && (isPosition(d.type) || fib);
  const collapsed = fold && !open;
  const close = (
    <IconButton label={t("снять выделение")} onClick={onDeselect} className={s.cardClose}>
      <IconClose />
    </IconButton>
  );
  // «уровни» у Фибоначчи — и на десктопе (уровни раскрываются под названием), «параметры» у позиции — на телефоне
  const toggle = (fib || fold) && (
    <Button size="sm" aria-expanded={open} aria-controls={fib && open ? levelsId : undefined} onClick={() => setOpenId(open ? null : d.id)}>
      {fib ? t("уровни") : t("параметры")} {open ? "▴" : "▾"}
    </Button>
  );
  if (collapsed)
    return (
      <div className={`${s.card} ${s.cardBar}`} role="region" aria-label={t("выбранный рисунок")}>
        <strong className={s.cardTitle}>{t(TOOL_TITLES[d.type])}</strong>
        {isPosition(d.type) && <FlipButton d={d} tick={tickN} onPatch={onPatch} />}
        {toggle}
        {close}
      </div>
    );
  return (
    <div className={fib ? `${s.card} ${s.cardFib}` : s.card} role="region" aria-label={t("выбранный рисунок")}>
      <strong className={s.cardTitle}>{t(TOOL_TITLES[d.type])}</strong>
      {toggle}
      {fib && open && <FibLevels id={levelsId} levels={d.levels} locked={d.locked} onChange={(levels) => onPatch(d.id, { levels })} />}
      {WITH_TEXT.has(d.type) && (
        <span className={s.cardText}>
          <Input aria-label={t("текст рисунка")} placeholder={t("подпись (до 140 символов)")} maxLength={NOTE_MAX} value={d.text ?? ""} onChange={(e) => onPatch(d.id, { text: e.target.value })} />
        </span>
      )}
      {isPosition(d.type) && onEdit && <PositionFields d={d} tick={tick} locked={d.locked} onEdit={onEdit} onPatch={onPatch} />}
      {pos && (
        <span className={s.posStats}>
          {pos.riskUsd != null && pos.size != null ? (
            <span className={s.posHint}>{positionRiskText(pos.riskUsd, pos.size, { risk: t("риск"), size: t("объём") })}</span>
          ) : (
            <span className={`caption ${s.posHint}`}>{t("задайте депозит и риск в настройках")}</span>
          )}
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
      {close}
    </div>
  );
}

/** «Перевернуть»: Long ⇄ Short, стоп и цель зеркально по шагу цены (шаг отмены). */
function FlipButton({ d, tick, onPatch, className }: { d: Drawing; tick: number | null; onPatch: Props["onPatch"]; className?: string }) {
  const t = useT();
  const dir = d.type === "position-long" ? "Short" : "Long";
  return (
    <Button
      className={className}
      disabled={d.locked}
      aria-label={t(dir === "Short" ? "перевернуть в Short" : "перевернуть в Long")}
      onClick={() => {
        const flipped = flipPosition(d, tick);
        if (flipped) onPatch(d.id, flipped);
      }}
    >
      ⇅ {dir}
    </Button>
  );
}

const FIB_GROUP_LABEL: Readonly<Record<FibLevelGroup, string>> = { targets: "цели по движению", retracement: "коррекция", beyond: "за началом" };

/**
 * Уровни Фибоначчи (ADR-0009, «Рисование», дополнение 2026-11-11): переключатель на каждый уровень, нажатый —
 * показан. Группы по месту уровня: «цели по движению» — за второй точкой (отрицательные: −0.618 — 61.8 % хода дальше
 * конца), «коррекция» — между точками (0…1), «за началом» — за первой точкой (больше 1). Уровень, которого нет среди
 * предложенных (рисунок с другого клиента), показан в своей группе и выключается так же. Последний включённый уровень
 * не выключается; «стандартные» — набор по умолчанию. Каждое нажатие — одна правка рисунка (шаг отмены): onChange
 * получает новый приведённый набор. У заблокированного рисунка переключатели недоступны.
 */
export function FibLevels({ id, levels, locked, onChange }: { id?: string; levels: readonly number[] | undefined; locked: boolean; onChange: (levels: number[]) => void }) {
  const t = useT();
  const shown = normalizeFibLevels(levels);
  const all = [...new Set([...FIB_PRESET_LEVELS, ...shown])].sort((a, b) => a - b);
  return (
    <div id={id} className={s.fibLevels} role="group" aria-label={t("уровни Фибоначчи")}>
      {FIB_LEVEL_GROUPS.map((g) => (
        <div key={g} className={s.fibGroup} role="group" aria-label={t(FIB_GROUP_LABEL[g])}>
          <span className={s.fibCaption} aria-hidden="true">
            {t(FIB_GROUP_LABEL[g])}
          </span>
          <div className={s.fibRow}>
            {all
              .filter((l) => fibLevelGroup(l) === g)
              .map((l) => {
                const on = shown.includes(l);
                const last = on && shown.length === 1;
                return (
                  <Button key={l} size="sm" className={s.fibToggle} aria-pressed={on} disabled={locked || last} title={last ? t("последний уровень не выключается") : undefined} onClick={() => onChange(toggleFibLevel(shown, l))}>
                    {fibLevelText(l)}
                  </Button>
                );
              })}
          </div>
        </div>
      ))}
      <Button size="sm" className={s.fibReset} disabled={locked} title={t("вернуть уровни по умолчанию — у этого рисунка и у новых")} onClick={() => onChange([...FIB_LEVELS])}>
        {t("стандартные")}
      </Button>
    </div>
  );
}

const FIELD_LABEL: Readonly<Record<PosField, string>> = { entry: "Вход", stop: "Стоп", target: "Цель", rr: "R:R 1:", risk: "Риск, %" };
const FIELD_NAME: Readonly<Record<PosField, string>> = { entry: "цена входа", stop: "цена стопа", target: "цена цели", rr: "отношение прибыли к риску", risk: "риск, % от цены входа" };

/**
 * Поля позиции (ADR-0009, «Рисование», дополнение «Позиция»): вход, стоп, цель, R:R и риск, % — правка сразу видна на
 * графике; конец правки (уход из поля, Enter) — один шаг отмены от значения до правки; Esc — вернуть. Неверное
 * значение (стоп или цель не по свою сторону от входа) не применяется: позиция на графике — как до правки, поле
 * показывает ошибку, а уход из поля с ошибкой — как Esc (ничего не сохраняется). Ввод по одной цифре (клавиатура
 * телефона) поэтому не оставляет на графике верное начало числа: «8» от «80380» — не стоп. «Перевернуть» — Long ⇄
 * Short (стоп и цель зеркально по шагу цены, шаг отмены).
 */
function PositionFields({ d, tick, locked, onEdit, onPatch }: { d: Drawing; tick: string | null; locked: boolean; onEdit: NonNullable<Props["onEdit"]>; onPatch: Props["onPatch"] }) {
  const t = useT();
  const p = positionParts(d);
  const digits = tickPrecision(tick);
  const tickN = tick !== null && Number(tick) > 0 ? Number(tick) : null;
  const [edit, setEdit] = useState<{ field: PosField; raw: string; error: string | null } | null>(null);
  /** Точки до правки поля: шаг отмены — от них. */
  const origin = useRef<Point[] | null>(null);
  /** В поле сейчас неверное значение: уход из поля его не сохраняет. */
  const invalid = useRef(false);
  const latest = useRef(d);
  useEffect(() => {
    latest.current = d;
  }, [d]);
  if (!p) return null;
  const finish = (cancel: boolean) => {
    const o = origin.current;
    const bad = invalid.current;
    origin.current = null;
    invalid.current = false;
    setEdit(null);
    if (!o) return;
    const cur = latest.current;
    if (cancel || bad) {
      if (!samePoints(o, cur.points)) onEdit(cur.id, o, false);
    } else if (!samePoints(o, cur.points)) onEdit(cur.id, cur.points, true, o);
  };
  const change = (field: PosField, raw: string) => {
    const o = (origin.current ??= d.points.map((q) => ({ ...q })));
    // от позиции до правки: каждое значение поля — само по себе, а не поверх предыдущего начала числа
    const r = applyField({ type: d.type, points: o }, field, raw, tickN);
    if ("error" in r) {
      invalid.current = true;
      setEdit({ field, raw, error: r.error });
      if (!samePoints(o, latest.current.points)) onEdit(d.id, o, false);
      return;
    }
    invalid.current = false;
    setEdit({ field, raw, error: null });
    onEdit(d.id, r.points, false);
  };
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
      <FlipButton d={d} tick={tickN} onPatch={onPatch} className={s.posFlip} />
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
