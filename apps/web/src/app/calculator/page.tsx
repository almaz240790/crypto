"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import s from "@/components/tools/tools.module.css";
import { Button, EmptyState, Input, Panel, Select } from "@/components/ui";
import { calculate } from "@/lib/calc";
import { formatPrice } from "@/lib/format";
import { getInstruments, type Instrument } from "@/lib/user";

type Preset = { name: string; v: Record<string, string> };
const KEY = "calc.presets";

function readPresets(): Preset[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Preset[];
  } catch {
    return [];
  }
}

export default function CalculatorPage() {
  const { user } = useAuth();
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [v, setV] = useState<Record<string, string>>({ symbol: "BTCUSDT", direction: "long", marketType: "futures", leverage: "3", riskPct: "1", deposit: "", entry: "", stop: "", tp1: "", tp2: "", tp3: "" });
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [edited, setEdited] = useState<Set<string>>(new Set());

  useEffect(() => {
    getInstruments()
      .then((r) => setInstruments(r))
      .catch(() => {});
    queueMicrotask(() => setPresets(readPresets()));
  }, []);

  // значения из профиля — пока поле не трогали руками
  const profile = useMemo(
    () => ({
      deposit: user?.risk.deposit ?? "",
      riskPct: user?.risk.risk_pct ? String(Number(user.risk.risk_pct)) : "1",
      leverage: String(user?.risk.default_leverage ?? 3),
      marketType: user?.risk.market_type ?? "futures",
    }),
    [user],
  );
  const val = (k: string) => (edited.has(k) ? v[k] : ((profile as Record<string, string>)[k] ?? v[k]));
  const set = (k: string, x: string) => {
    setV((p) => ({ ...p, [k]: x }));
    setEdited((p) => new Set(p).add(k));
  };
  const inst = instruments.find((i) => i.symbol === val("symbol"));
  const num = (k: string) => Number(String(val(k)).replace(",", "."));
  const out = calculate({
    deposit: num("deposit"),
    riskPct: num("riskPct"),
    entry: num("entry"),
    stop: num("stop"),
    direction: val("direction") as "long" | "short",
    leverage: num("leverage"),
    marketType: val("marketType") as "spot" | "futures",
    lotSize: inst?.lot_size ? Number(inst.lot_size) : null,
    tps: [num("tp1") || null, num("tp2") || null, num("tp3") || null],
  });
  const tick = inst?.tick_size ?? null;
  const base = val("symbol").replace(/USDT$/, "");

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const all: Record<string, string> = {};
    Object.keys(v).forEach((k) => (all[k] = val(k)));
    const next = [...presets.filter((p) => p.name !== name), { name, v: all }];
    setPresets(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* без сохранения */
    }
    setPresetName("");
  };
  const loadPreset = (p: Preset) => {
    setV(p.v);
    setEdited(new Set(Object.keys(p.v)));
  };

  return (
    <AppShell title="Калькулятор позиции">
      <div className={s.two}>
        <Panel title="Параметры" footer="Депозит, риск, плечо и тип рынка подставляются из профиля; измените в настройках.">
          <div className={s.form}>
            <div className={s.row}>
              <Select label="Инструмент" value={val("symbol")} onChange={(e) => set("symbol", e.target.value)}>
                {(instruments.length ? instruments : [{ symbol: "BTCUSDT" } as Instrument]).map((i) => (
                  <option key={i.symbol} value={i.symbol}>
                    {i.symbol}
                  </option>
                ))}
              </Select>
              <Select label="Направление" value={val("direction")} onChange={(e) => set("direction", e.target.value)}>
                <option value="long">long</option>
                <option value="short">short</option>
              </Select>
              <Select label="Рынок" value={val("marketType")} onChange={(e) => set("marketType", e.target.value)}>
                <option value="futures">фьючерсы</option>
                <option value="spot">спот</option>
              </Select>
            </div>
            <div className={s.row}>
              <Input label="Депозит, USDT" mono inputMode="decimal" value={val("deposit")} onChange={(e) => set("deposit", e.target.value)} />
              <Input label="Риск, %" mono inputMode="decimal" value={val("riskPct")} onChange={(e) => set("riskPct", e.target.value)} />
              <Input label="Плечо" mono inputMode="numeric" value={val("leverage")} onChange={(e) => set("leverage", e.target.value)} disabled={val("marketType") === "spot"} />
            </div>
            <div className={s.row}>
              <Input label="Вход" mono inputMode="decimal" value={val("entry")} onChange={(e) => set("entry", e.target.value)} />
              <Input label="Стоп" mono inputMode="decimal" value={val("stop")} onChange={(e) => set("stop", e.target.value)} />
            </div>
            <div className={s.row}>
              <Input label="TP1" mono inputMode="decimal" value={val("tp1")} onChange={(e) => set("tp1", e.target.value)} />
              <Input label="TP2" mono inputMode="decimal" value={val("tp2")} onChange={(e) => set("tp2", e.target.value)} />
              <Input label="TP3" mono inputMode="decimal" value={val("tp3")} onChange={(e) => set("tp3", e.target.value)} />
            </div>
            <div className={s.inline}>
              <input placeholder="имя пресета" aria-label="имя пресета" value={presetName} onChange={(e) => setPresetName(e.target.value)} />
              <Button size="sm" onClick={savePreset} disabled={!presetName.trim()}>
                Сохранить пресет
              </Button>
              {presets.map((p) => (
                <button key={p.name} type="button" className={s.small} onClick={() => loadPreset(p)}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </Panel>
        <Panel title="Результат" footer="Цена ликвидации — приближённо по формуле изолированной маржи с поддерживающей маржой 0.5 %; у биржи она зависит от уровня позиции и комиссий. Проверяйте в терминале биржи.">
          {!out ? (
            <EmptyState text="Заполните депозит, риск, вход и стоп." />
          ) : (
            <div className={s.form}>
              <dl className={s.out}>
                <dt>Риск в USDT</dt>
                <dd className="num">{out.riskUsd.toFixed(2)}</dd>
                <dt>Расстояние до стопа</dt>
                <dd className="num">{out.riskPerUnit > 0 ? `${formatPrice(out.riskPerUnit, tick)} (${((out.riskPerUnit / num("entry")) * 100).toFixed(2)} %)` : "—"}</dd>
                <dt>Размер позиции</dt>
                <dd className="num" data-testid="calc-size">
                  {out.size} {base}
                  {inst?.lot_size && out.size !== out.sizeRaw ? <span className="caption"> (округлено к шагу {inst.lot_size})</span> : null}
                </dd>
                <dt>Объём позиции</dt>
                <dd className="num">{out.notional.toFixed(2)} USDT</dd>
                {val("marketType") === "futures" && (
                  <>
                    <dt>Нужное плечо</dt>
                    <dd className="num">{out.requiredLeverage <= 1 ? "без плеча" : `≥ ${out.requiredLeverage.toFixed(1)}×`}</dd>
                    <dt>Маржа при {num("leverage") || 1}×</dt>
                    <dd className="num">{out.margin.toFixed(2)} USDT</dd>
                    <dt>Ликвидация (≈)</dt>
                    <dd className="num">{out.liquidation ? formatPrice(out.liquidation, tick) : "—"}</dd>
                  </>
                )}
                {out.tps.map((t, i) => (
                  <>
                    <dt key={`t${i}`}>TP{i + 1} — {formatPrice(t.price, tick)}</dt>
                    <dd key={`d${i}`} className="num up">
                      {t.r.toFixed(2)} R · {t.pct.toFixed(2)} % · +{t.profitUsd.toFixed(2)} USDT
                    </dd>
                  </>
                ))}
                {out.rrTp2 !== null && (
                  <>
                    <dt>R:R до TP2</dt>
                    <dd className="num">{out.rrTp2.toFixed(2)}</dd>
                  </>
                )}
              </dl>
              {out.warnings.map((w) => (
                <p key={w} className="caption down">
                  {w}
                </p>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
