"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app/AppShell";
import s from "@/components/tools/tools.module.css";
import { Button, EmptyState, Input, Panel, Select, Table, Td, Th } from "@/components/ui";
import { getAccessToken } from "@/lib/auth-client";
import { formatPct, formatR, formatTimeUTC } from "@/lib/format";
import { createJournal, deleteJournal, getInstruments, getJournal, getJournalAnalytics, importTrades, updateJournal, type AnalyticsBucket, type Instrument, type JournalAnalytics, type JournalEntry, type JournalIn, type JournalSummary } from "@/lib/user";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const GRADES: Record<string, string> = { A: "A", B: "B", C: "C", none: "без сигнала" };

/** Кривая капитала в R: одна линия, нулевая отметка пунктиром; цвета — токены. */
function EquityCurve({ points }: { points: { t: string; r: string }[] }) {
  const w = 320, h = 72;
  const vals = [0, ...points.map((p) => Number(p.r))];
  if (vals.length < 2) return <span className="caption">закрытых сделок пока нет</span>;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const x = (i: number) => (i / (vals.length - 1)) * (w - 2) + 1;
  const y = (v: number) => (1 - (v - min) / span) * (h - 2) + 1;
  const last = vals[vals.length - 1]!;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`кривая капитала, итог ${formatR(last)}`} style={{ display: "block", maxWidth: w }}>
      <line x1={1} x2={w - 1} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeDasharray="3 3" />
      <polyline points={vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} fill="none" stroke={last >= 0 ? "var(--up)" : "var(--down)"} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function BucketTable({ title, rows, label }: { title: string; rows: AnalyticsBucket[]; label: (k: string | number) => string }) {
  return (
    <Table compact>
      <thead>
        <tr>
          <Th>{title}</Th>
          <Th num>Сделок</Th>
          <Th num>Итог R</Th>
          <Th num>Винрейт</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => {
          const r = Number(b.sum_r);
          return (
            <tr key={String(b.key)}>
              <Td>{label(b.key)}</Td>
              <Td num>{b.closed}/{b.trades}</Td>
              <Td num className={r > 0 ? "up" : r < 0 ? "down" : ""}>{b.closed ? formatR(b.sum_r) : "—"}</Td>
              <Td num>{b.winrate == null ? "—" : formatPct(b.winrate * 100, { signed: false })}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function Analytics({ a }: { a: JournalAnalytics }) {
  const e = a.errors;
  return (
    <Panel title="Аналитика" footer="Ранний выход — сделка по сигналу закрыта хуже результата сигнала более чем на 0.5 R. Превышение риска — риск сделки больше бюджета из риск-профиля на 10 % и более.">
      <div className={s.analytics} data-testid="journal-analytics">
        <div>
          <p className="caption" style={{ margin: "0 0 4px" }}>
            Кривая капитала, R{a.equity.max_drawdown_r != null && <> · макс. просадка {formatR(a.equity.max_drawdown_r)}</>}
          </p>
          <EquityCurve points={a.equity.points} />
          <p className="caption" style={{ margin: "8px 0 0" }} aria-label="типовые ошибки">
            Типовые ошибки: ранний выход <strong>{e.early_exit.count}</strong> из {e.early_exit.of} по сигналу · вход без сигнала <strong>{e.no_signal.count}</strong> из {e.no_signal.of} ·
            превышение риска {e.risk_exceeded.budget_usd == null ? <span>— задайте депозит в настройках</span> : <><strong>{e.risk_exceeded.count}</strong> из {e.risk_exceeded.of} (бюджет {e.risk_exceeded.budget_usd} USDT)</>}
          </p>
        </div>
        <BucketTable title="День недели" rows={a.by_weekday} label={(k) => WEEKDAYS[Number(k)] ?? String(k)} />
        <BucketTable title="Инструмент" rows={a.by_symbol.slice(0, 12)} label={(k) => String(k)} />
        <BucketTable title="Градация" rows={a.by_grade} label={(k) => GRADES[String(k)] ?? String(k)} />
      </div>
    </Panel>
  );
}

const EMPTY: Record<string, string> = { symbol: "", direction: "long", entry_at: "", entry_price: "", stop_loss: "", tp: "", size: "", exit_at: "", exit_price: "", fees: "", tags: "", note: "" };

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function JournalInner() {
  const sp = useSearchParams();
  const [items, setItems] = useState<JournalEntry[] | null>(null);
  const [summary, setSummary] = useState<JournalSummary | null>(null);
  const [analytics, setAnalytics] = useState<JournalAnalytics | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [imp, setImp] = useState<{ api_key: string; api_secret: string; days: string } | null>(null);
  const [impBusy, setImpBusy] = useState(false);

  async function runImport(ev: FormEvent) {
    ev.preventDefault();
    if (!imp) return;
    setError(null);
    setImpBusy(true);
    try {
      const r = await importTrades({ exchange: "binance", api_key: imp.api_key.trim(), api_secret: imp.api_secret.trim(), days: Number(imp.days) });
      setImp(null);
      await load();
      setToast(`Импортировано ${r.imported} сделок (по сигналам: ${r.matched}, открытых: ${r.open}), пропущено уже известных: ${r.skipped}`);
      setTimeout(() => setToast(null), 6000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ошибка импорта");
    } finally {
      setImpBusy(false);
    }
  }

  const load = useCallback(async () => {
    const r = await getJournal();
    setItems(r.items);
    setSummary(r.summary);
    setAnalytics(r.items.length ? await getJournalAnalytics().catch(() => null) : null);
  }, []);
  useEffect(() => {
    queueMicrotask(() => load().catch((e: Error) => setError(e.message)));
    getInstruments()
      .then((r) => setInstruments(r))
      .catch(() => {});
  }, [load]);
  // префилл из терминала (позиция на графике): /journal?symbol&direction&entry&stop&tp
  useEffect(() => {
    const entry = sp.get("entry");
    if (!entry) return;
    queueMicrotask(() =>
      setForm({
        ...EMPTY,
        symbol: sp.get("symbol") ?? "",
        direction: sp.get("direction") === "short" ? "short" : "long",
        entry_at: toLocalInput(new Date().toISOString()),
        entry_price: entry,
        stop_loss: sp.get("stop") ?? "",
        tp: sp.get("tp") ?? "",
      }),
    );
  }, [sp]);

  const startEdit = (e: JournalEntry) => {
    setEditId(e.id);
    setForm({
      symbol: e.symbol, direction: e.direction, entry_at: toLocalInput(e.entry_at), entry_price: e.entry_price, stop_loss: e.stop_loss ?? "",
      tp: e.take_profits.join(" "), size: e.size ?? "", exit_at: toLocalInput(e.exit_at), exit_price: e.exit_price ?? "", fees: e.fees ?? "",
      tags: e.tags.join(" "), note: e.note ?? "",
    });
  };

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!form) return;
    setError(null);
    const body: JournalIn = {
      symbol: form.symbol.toUpperCase(),
      direction: form.direction as "long" | "short",
      entry_price: form.entry_price,
      entry_at: new Date(form.entry_at).toISOString(),
      stop_loss: form.stop_loss || null,
      take_profits: form.tp.split(/[\s,]+/).filter(Boolean),
      size: form.size || null,
      exit_price: form.exit_price || null,
      exit_at: form.exit_at ? new Date(form.exit_at).toISOString() : null,
      fees: form.fees || null,
      tags: form.tags.split(/[\s,]+/).filter(Boolean),
      note: form.note || null,
    };
    try {
      if (editId) await updateJournal(editId, body);
      else await createJournal(body);
      setForm(null);
      setEditId(null);
      await load();
      setToast(editId ? "Запись обновлена" : "Запись добавлена");
      setTimeout(() => setToast(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ошибка");
    }
  }

  async function downloadCsv() {
    const res = await fetch("/v1/journal/export.csv", { headers: { authorization: `Bearer ${getAccessToken() ?? ""}` }, credentials: "include" });
    if (!res.ok) return setError(`экспорт: ошибка ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "platform-journal.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const f = (k: string) => form?.[k] ?? "";
  const setF = (k: string, v: string) => setForm((p) => ({ ...(p ?? EMPTY), [k]: v }));

  return (
    <AppShell
      title="Журнал сделок"
      actions={
        <div className={s.actions}>
          <Button size="sm" variant="primary" onClick={() => { setEditId(null); setForm({ ...EMPTY, entry_at: toLocalInput(new Date().toISOString()) }); }}>
            Добавить сделку
          </Button>
          <Button size="sm" onClick={downloadCsv}>
            CSV
          </Button>
          <Button size="sm" onClick={() => setImp(imp ? null : { api_key: "", api_secret: "", days: "30" })} aria-pressed={!!imp}>
            Импорт с биржи
          </Button>
        </div>
      }
    >
      <div className={s.wrap} style={{ maxWidth: "none" }}>
        {summary && (
          <div className={s.strip} aria-label="итоги">
            <span>
              сделок <strong>{summary.trades}</strong>
            </span>
            <span>
              закрыто <strong>{summary.closed}</strong>
            </span>
            <span>
              итог <strong>{formatR(summary.sum_r)}</strong>
            </span>
            <span>
              ваш винрейт <strong>{summary.winrate == null ? "—" : formatPct(summary.winrate * 100, { signed: false })}</strong>
            </span>
            <span>
              ваш средний R <strong>{summary.avg_r == null ? "—" : formatR(summary.avg_r)}</strong>
              {summary.system_avg_r != null && <> против <strong>{formatR(summary.system_avg_r)}</strong> у системы по тем же сигналам</>}
            </span>
            {summary.executed_share != null && (
              <span>
                исполнено сигналов <strong>{formatPct(summary.executed_share * 100, { signed: false })}</strong>
              </span>
            )}
          </div>
        )}
        {toast && (
          <p className={s.toast} role="status">
            {toast}
          </p>
        )}
        {imp && (
          <Panel title="Импорт сделок с Binance (USDT-M фьючерсы)" footer="Нужен API-ключ только на чтение (без прав на торговлю и вывод). Ключ и секрет используются один раз для запроса и не сохраняются. Сделки сопоставляются с сигналами по инструменту, направлению и времени входа; повторный импорт не создаёт дублей.">
            <form className={s.form} onSubmit={runImport} aria-label="импорт с биржи">
              {error && (
                <p className={s.toast} data-kind="error" role="alert">
                  {error}
                </p>
              )}
              <div className={s.row}>
                <Input label="API key" mono autoComplete="off" value={imp.api_key} onChange={(e) => setImp({ ...imp, api_key: e.target.value })} required minLength={16} />
                <Input label="API secret" type="password" mono autoComplete="off" value={imp.api_secret} onChange={(e) => setImp({ ...imp, api_secret: e.target.value })} required minLength={16} />
                <Select label="Период" value={imp.days} onChange={(e) => setImp({ ...imp, days: e.target.value })}>
                  <option value="7">7 дней</option>
                  <option value="30">30 дней</option>
                  <option value="90">90 дней</option>
                  <option value="365">год</option>
                </Select>
              </div>
              <div className={s.actions}>
                <Button type="submit" variant="primary" size="sm" disabled={impBusy || imp.api_key.length < 16 || imp.api_secret.length < 16}>
                  {impBusy ? "Импортируем…" : "Импортировать"}
                </Button>
              </div>
            </form>
          </Panel>
        )}
        {analytics && analytics.total.trades > 0 && <Analytics a={analytics} />}
        {form && (
          <Panel title={editId ? "Правка записи" : "Новая запись"} actions={<button type="button" className={s.small} onClick={() => { setForm(null); setEditId(null); }}>закрыть</button>}>
            <form className={s.form} onSubmit={submit}>
              {error && (
                <p className={s.toast} data-kind="error" role="alert">
                  {error}
                </p>
              )}
              <div className={s.row}>
                <Input label="Инструмент" list="j-symbols" value={f("symbol")} onChange={(e) => setF("symbol", e.target.value)} required style={{ textTransform: "uppercase" }} />
                <datalist id="j-symbols">
                  {instruments.map((i) => (
                    <option key={i.symbol} value={i.symbol} />
                  ))}
                </datalist>
                <Select label="Направление" value={f("direction")} onChange={(e) => setF("direction", e.target.value)}>
                  <option value="long">long</option>
                  <option value="short">short</option>
                </Select>
                <Input label="Вход, время" type="datetime-local" value={f("entry_at")} onChange={(e) => setF("entry_at", e.target.value)} required />
                <Input label="Вход, цена" mono inputMode="decimal" value={f("entry_price")} onChange={(e) => setF("entry_price", e.target.value)} required />
              </div>
              <div className={s.row}>
                <Input label="Стоп" mono inputMode="decimal" value={f("stop_loss")} onChange={(e) => setF("stop_loss", e.target.value)} />
                <Input label="Цели (через пробел)" mono value={f("tp")} onChange={(e) => setF("tp", e.target.value)} />
                <Input label="Размер, монет" mono inputMode="decimal" value={f("size")} onChange={(e) => setF("size", e.target.value)} />
                <Input label="Комиссии, USDT" mono inputMode="decimal" value={f("fees")} onChange={(e) => setF("fees", e.target.value)} />
              </div>
              <div className={s.row}>
                <Input label="Выход, время" type="datetime-local" value={f("exit_at")} onChange={(e) => setF("exit_at", e.target.value)} />
                <Input label="Выход, цена" mono inputMode="decimal" value={f("exit_price")} onChange={(e) => setF("exit_price", e.target.value)} hint="результат в R и USDT считается сам" />
                <Input label="Теги (через пробел)" value={f("tags")} onChange={(e) => setF("tags", e.target.value)} />
              </div>
              <Input label="Комментарий" value={f("note")} onChange={(e) => setF("note", e.target.value)} maxLength={2000} />
              <div className={s.actions}>
                <Button type="submit" variant="primary" size="sm">
                  {editId ? "Сохранить" : "Добавить"}
                </Button>
              </div>
            </form>
          </Panel>
        )}
        <Panel flush title="Записи" footer="Записи создаются из сигнала кнопкой «Я вошёл» или вручную. Результат в R — по вашим ценам входа, стопа и выхода.">
          {error && !form && <EmptyState text={error} />}
          {items === null ? (
            <EmptyState text="Загрузка…" />
          ) : items.length === 0 ? (
            <EmptyState text="Записей пока нет." />
          ) : (
            <Table compact>
              <thead>
                <tr>
                  <Th>Вход</Th>
                  <Th>Инструмент</Th>
                  <Th num>Цена</Th>
                  <Th num>Стоп</Th>
                  <Th num>Размер</Th>
                  <Th>Выход</Th>
                  <Th num>R</Th>
                  <Th num>USDT</Th>
                  <Th>Теги</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {items.map((e) => {
                  const r = e.realized_r == null ? null : Number(e.realized_r);
                  return (
                    <tr key={e.id}>
                      <Td mobile="secondary" className="text-2">
                        {formatTimeUTC(e.entry_at)}
                      </Td>
                      <Td>
                        <strong>{e.symbol}</strong> <span className={e.direction === "long" ? "up" : "down"}>{e.direction}</span>
                        {e.source === "signal" && <span className="caption"> · по сигналу</span>}
                      </Td>
                      <Td num mobile="right">{e.entry_price}</Td>
                      <Td num mobile="hidden">{e.stop_loss ?? "—"}</Td>
                      <Td num mobile="hidden">{e.size ?? "—"}</Td>
                      <Td mobile="hidden" className="text-2">
                        {e.exit_price ? `${e.exit_price}${e.exit_at ? ` · ${formatTimeUTC(e.exit_at)}` : ""}` : "открыта"}
                      </Td>
                      <Td num mobile="right" className={r == null ? "" : r > 0 ? "up" : r < 0 ? "down" : ""}>
                        {r == null ? "—" : formatR(r)}
                      </Td>
                      <Td num mobile="hidden">{e.realized_quote ?? "—"}</Td>
                      <Td mobile="hidden" className="caption">
                        {e.tags.join(" ")}
                      </Td>
                      <Td mobile="hidden">
                        <span className={s.actions}>
                          <button type="button" className={s.small} onClick={() => startEdit(e)}>
                            править
                          </button>
                          <button
                            type="button"
                            className={`${s.small} ${s.danger}`}
                            onClick={() => {
                              if (confirm(`Удалить запись ${e.symbol} от ${formatTimeUTC(e.entry_at)}?`)) deleteJournal(e.id).then(load).catch((x: Error) => setError(x.message));
                            }}
                          >
                            удалить
                          </button>
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}

export default function JournalPage() {
  return (
    <Suspense fallback={null}>
      <JournalInner />
    </Suspense>
  );
}
