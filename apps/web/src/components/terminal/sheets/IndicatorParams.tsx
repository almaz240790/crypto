"use client";

import { clampParams, indicatorById, instanceTitle, type IndicatorInstance } from "@platform/charts";
import { useState } from "react";
import { useT } from "@/i18n/client";
import c from "../chrome/chrome.module.css";

/**
 * Редактор параметров экземпляра (план 2B.9 §9): числовое поле на каждый ParamSpec, aria-label «{параметр} {имя}»
 * («Период EMA 50»). Значение применяется по Enter и при уходе из поля, приводится к min/max и шагу (clampParams):
 * пока человек печатает, имя экземпляра не меняется.
 */
export function IndicatorParams({ inst, onChange }: { inst: IndicatorInstance; onChange: (uid: string, params: Record<string, number>) => void }) {
  const t = useT();
  const spec = indicatorById(inst.id);
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (!spec || spec.params.length === 0) return null;
  const name = instanceTitle(spec, inst.params, t);
  const commit = (key: string) => {
    const raw = draft[key];
    if (raw === undefined) return;
    setDraft((d) => {
      const { [key]: _drop, ...rest } = d;
      void _drop;
      return rest;
    });
    const n = Number(raw.replace(",", "."));
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    const next = clampParams(spec, { ...inst.params, [key]: n });
    if (next[key] !== inst.params[key]) onChange(inst.uid, next);
  };
  return (
    <span className={c.params}>
      {spec.params.map((p) => (
        <label key={p.key} className={c.param}>
          <span className={c.paramLabel}>{t(p.label)}</span>
          <input
            className={c.paramInput}
            type="number"
            inputMode="numeric"
            min={p.min}
            max={p.max}
            step={p.step ?? 1}
            aria-label={`${t(p.label)} ${name}`}
            value={draft[p.key] ?? String(inst.params[p.key] ?? p.default)}
            onChange={(e) => setDraft((d) => ({ ...d, [p.key]: e.target.value }))}
            onBlur={() => commit(p.key)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit(p.key);
              }
            }}
          />
        </label>
      ))}
    </span>
  );
}
