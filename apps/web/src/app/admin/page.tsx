"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import t from "@/components/tools/tools.module.css";
import { Badge, Button, EmptyState, Input, Panel, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import * as A from "@/lib/admin";
import { formatTimeUTC } from "@/lib/format";
import s from "./page.module.css";

const TABS = [
  ["strategies", "Стратегии"],
  ["instruments", "Инструменты"],
  ["signals", "Сигналы"],
  ["users", "Пользователи"],
  ["system", "Система"],
  ["audit", "Аудит"],
] as const;
type Tab = (typeof TABS)[number][0];
type Run = (fn: () => Promise<unknown>, ok: string, after?: () => void) => Promise<void>;

function useToast() {
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const note = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    setMsg({ text, kind });
    setTimeout(() => setMsg(null), 4000);
  }, []);
  const run: Run = useCallback(
    async (fn, ok, after) => {
      try {
        await fn();
        note(ok);
        after?.();
      } catch (e) {
        note(e instanceof Error ? e.message : "ошибка", "error");
      }
    },
    [note],
  );
  return { msg, run };
}

function Strategies({ run }: { run: Run }) {
  const [d, setD] = useState<A.AdminStrategies | null>(null);
  const [form, setForm] = useState({ version: "", to: "forward", reason: "" });
  const [notes, setNotes] = useState<Record<number, string>>({});
  const load = useCallback(() => A.getStrategies().then((x) => setD(x)).catch(() => setD(null)), []);
  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);
  if (!d) return <EmptyState text="Загрузка…" />;
  return (
    <div className={s.grid}>
      <Panel title="Версии стратегии" flush>
        <Table compact stack={false}>
          <thead>
            <tr>
              <Th>Версия</Th>
              <Th>Статус</Th>
              <Th num>Сигналов</Th>
              <Th>Активирована</Th>
              <Th>Подтвердил</Th>
              <Th>Параметры</Th>
            </tr>
          </thead>
          <tbody>
            {d.versions.map((v) => (
              <tr key={v.id}>
                <Td>
                  <strong>
                    {v.name} {v.version}
                  </strong>
                </Td>
                <Td>
                  <Badge tone={v.status === "live" ? "up" : v.status === "forward" ? "accent" : "muted"}>{v.status}</Badge>
                </Td>
                <Td num>{v.signals}</Td>
                <Td>{v.activated_at ? formatTimeUTC(v.activated_at, { withYear: true }) : "—"}</Td>
                <Td>{v.approved_by ?? "—"}</Td>
                <Td>
                  <details>
                    <summary className="caption">показать</summary>
                    <pre className={s.pre}>{JSON.stringify(v.params, null, 1)}</pre>
                  </details>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
      <Panel
        title="Заявка на смену статуса"
        footer="Четырёхглазый принцип: заявку подтверждает другой админ. Владелец может подтвердить свою заявку только с письменным обоснованием, и это попадает в аудит. Перевод в live возможен только из forward."
      >
        <form
          className={t.form}
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => A.createStatusRequest(Number(form.version), form.to, form.reason), "Заявка создана", () => {
              setForm({ version: "", to: "forward", reason: "" });
              void load();
            });
          }}
        >
          <div className={t.row}>
            <Select label="Версия" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} required>
              <option value="">—</option>
              {d.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} {v.version} ({v.status})
                </option>
              ))}
            </Select>
            <Select label="Новый статус" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}>
              {["backtest", "forward", "live", "archived"].map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
            <Input label="Обоснование" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} minLength={10} required placeholder="ссылка на отчёт, цифры форварда" />
          </div>
          <div className={t.actions}>
            <Button type="submit" size="sm" variant="primary" disabled={!form.version || form.reason.length < 10}>
              Создать заявку
            </Button>
          </div>
        </form>
      </Panel>
      <Panel title="Заявки" flush>
        {d.requests.length === 0 ? (
          <EmptyState text="Заявок нет." />
        ) : (
          <Table compact stack={false}>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Версия</Th>
                <Th>Переход</Th>
                <Th>Кто</Th>
                <Th>Обоснование</Th>
                <Th>Решение</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {d.requests.map((r) => {
                const v = d.versions.find((x) => x.id === r.strategy_version_id);
                const mine = r.requested_by_id === d.me.id;
                return (
                  <tr key={r.id}>
                    <Td>{r.id}</Td>
                    <Td>{v ? `${v.name} ${v.version}` : r.strategy_version_id}</Td>
                    <Td>
                      {r.from_status} → <strong>{r.to_status}</strong>
                    </Td>
                    <Td className="caption">{r.requested_by}</Td>
                    <Td style={{ whiteSpace: "normal", maxWidth: 320 }}>{r.reason}</Td>
                    <Td>
                      <Badge tone={r.decision === "applied" ? "up" : r.decision === "rejected" ? "down" : "warn"}>{r.decision}</Badge>
                      {r.decision_note && <div className="caption">{r.decision_note}</div>}
                    </Td>
                    <Td>
                      {r.decision === "pending" && (
                        <div className={t.inline}>
                          <input
                            placeholder={mine ? "обоснование владельца (≥ 20 символов)" : "заметка"}
                            aria-label={`заметка к заявке ${r.id}`}
                            value={notes[r.id] ?? ""}
                            onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                            style={{ minWidth: 220 }}
                          />
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={mine && d.me.role !== "owner"}
                            onClick={() => void run(() => A.decideStatusRequest(r.id, true, notes[r.id] || null), "Заявка подтверждена, статус применён", () => void load())}
                          >
                            Подтвердить
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => void run(() => A.decideStatusRequest(r.id, false, notes[r.id] || null), "Заявка отклонена", () => void load())}>
                            Отклонить
                          </Button>
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>
      <Panel title="Прогоны бэктеста" flush>
        <Table compact stack={false}>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Версия</Th>
              <Th>Период</Th>
              <Th num>Пар</Th>
              <Th num>Сделок</Th>
              <Th num>PF</Th>
              <Th num>Итог R</Th>
              <Th>Заметка</Th>
            </tr>
          </thead>
          <tbody>
            {d.runs.map((r) => (
              <tr key={r.id}>
                <Td>{r.id}</Td>
                <Td>{r.strategy_version}</Td>
                <Td>
                  {r.period[0]} — {r.period[1]}
                </Td>
                <Td num>{r.instruments}</Td>
                <Td num>{r.metrics.closed ?? "—"}</Td>
                <Td num>{r.metrics.profit_factor?.toFixed(2) ?? "—"}</Td>
                <Td num>{r.metrics.sum_r?.toFixed(1) ?? "—"}</Td>
                <Td className="caption">{r.note}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </div>
  );
}

function Instruments({ run }: { run: Run }) {
  const [rows, setRows] = useState<A.AdminInstrument[] | null>(null);
  const load = useCallback(() => A.getInstruments().then((x) => setRows(x)).catch(() => setRows([])), []);
  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);
  if (!rows) return <EmptyState text="Загрузка…" />;
  return (
    <Panel title={`${rows.length} инструментов`} flush footer="Выключенный инструмент не участвует в прогонах движка и не показывается в скринере.">
      <Table compact stack={false}>
        <thead>
          <tr>
            <Th>Инструмент</Th>
            <Th>Активен</Th>
            <Th num>Шаг цены</Th>
            <Th num>Шаг лота</Th>
            <Th>Последняя H4</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id}>
              <Td>
                <strong>{i.symbol}</strong>{" "}
                <span className="caption">
                  {i.exchange} {i.market_type}
                </span>
              </Td>
              <Td>
                <Badge tone={i.is_active ? "up" : "muted"}>{i.is_active ? "да" : "нет"}</Badge>
              </Td>
              <Td num>{i.tick_size}</Td>
              <Td num>{i.lot_size}</Td>
              <Td className="caption">{i.last_h4 ? formatTimeUTC(i.last_h4) : "—"}</Td>
              <Td>
                <button
                  type="button"
                  className={t.small}
                  onClick={() => void run(() => A.patchInstrument(i.id, { is_active: !i.is_active }), i.is_active ? `${i.symbol} выключен` : `${i.symbol} включён`, () => void load())}
                >
                  {i.is_active ? "выключить" : "включить"}
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

function Signals({ run }: { run: Run }) {
  const [rows, setRows] = useState<A.AdminSignal[] | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const load = useCallback(() => A.getSignals().then((x) => setRows(x)).catch(() => setRows([])), []);
  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);
  if (!rows) return <EmptyState text="Загрузка…" />;
  return (
    <Panel title="Последние сигналы (все области)" flush footer="Отмена не удаляет сигнал: статус cancelled и событие с публичной причиной.">
      {rows.length === 0 ? (
        <EmptyState text="Сигналов нет." />
      ) : (
        <Table compact stack={false}>
          <thead>
            <tr>
              <Th>Свеча</Th>
              <Th>Инструмент</Th>
              <Th>Версия</Th>
              <Th>Статус</Th>
              <Th>Флаги и факты движка</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="caption">{formatTimeUTC(r.candle_close_time)}</Td>
                <Td>
                  <strong>{r.symbol}</strong> {r.direction} {r.grade} {r.score}
                </Td>
                <Td className="caption">
                  {r.version} ({r.scope})
                </Td>
                <Td>
                  <StatusBadge status={r.status} />
                </Td>
                <Td>
                  <details>
                    <summary className="caption">
                      {r.flags.length} флагов, {r.facts.length} фактов
                    </summary>
                    <pre className={s.pre}>
                      {[...r.flags.map((f) => `! ${f}`), ...r.facts].join("\n")}
                      {"\nhash "}
                      {r.input_hash}
                    </pre>
                  </details>
                </Td>
                <Td>
                  {["pending", "active", "tp1_hit", "tp2_hit"].includes(r.status) && (
                    <div className={t.inline}>
                      <input placeholder="публичная причина" aria-label={`причина отмены ${r.id}`} value={reason[r.id] ?? ""} onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })} />
                      <Button size="sm" variant="danger" disabled={(reason[r.id] ?? "").length < 10} onClick={() => void run(() => A.cancelSignal(r.id, reason[r.id]), "Сигнал отменён", () => void load())}>
                        Отменить
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function Users({ run, me }: { run: Run; me: { id: number; role: string } }) {
  const [rows, setRows] = useState<A.AdminUser[] | null>(null);
  const [q, setQ] = useState("");
  const load = useCallback(() => A.getUsers(q).then((x) => setRows(x)).catch(() => setRows([])), [q]);
  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);
  return (
    <div className={s.grid}>
      <div className={t.inline}>
        <input placeholder="поиск по email" aria-label="поиск по email" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Panel title={rows ? `${rows.length} пользователей` : "Пользователи"} flush>
        {!rows ? (
          <EmptyState text="Загрузка…" />
        ) : (
          <Table compact stack={false}>
            <thead>
              <tr>
                <Th>Email</Th>
                <Th>Роль</Th>
                <Th>Страна</Th>
                <Th>Подтверждён</Th>
                <Th>Создан</Th>
                <Th>Блок</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <Td>
                    {u.email} {u.name && <span className="caption">{u.name}</span>}
                  </Td>
                  <Td>
                    {me.role === "owner" && u.id !== me.id ? (
                      <select aria-label={`роль ${u.email}`} value={u.role} onChange={(e) => void run(() => A.patchUser(u.id, { role: e.target.value }), "Роль изменена", () => void load())}>
                        {["user", "support", "admin", "owner"].map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      u.role
                    )}
                  </Td>
                  <Td>{u.country ?? "—"}</Td>
                  <Td>{u.verified ? "да" : "нет"}</Td>
                  <Td className="caption">{u.created_at ? formatTimeUTC(u.created_at, { withYear: true }) : "—"}</Td>
                  <Td>{u.blocked_at ? <Badge tone="down">{u.blocked_reason ?? "заблокирован"}</Badge> : u.deleted ? <Badge tone="muted">удалён</Badge> : "—"}</Td>
                  <Td>
                    {u.id !== me.id && u.role !== "owner" && !u.deleted && (
                      <button
                        type="button"
                        className={`${t.small} ${u.blocked_at ? "" : t.danger}`}
                        onClick={() => {
                          const reason = u.blocked_at ? null : prompt("Причина блокировки");
                          if (!u.blocked_at && !reason) return;
                          void run(() => A.patchUser(u.id, { block: !u.blocked_at, reason }), u.blocked_at ? "Разблокирован" : "Заблокирован", () => void load());
                        }}
                      >
                        {u.blocked_at ? "разблокировать" : "заблокировать"}
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}

function System() {
  const [d, setD] = useState<A.SystemStatus | null>(null);
  useEffect(() => {
    A.getSystem()
      .then((x) => setD(x))
      .catch(() => setD(null));
  }, []);
  if (!d) return <EmptyState text="Загрузка…" />;
  const age = (x: number | null | undefined) => (x == null ? "нет данных" : x < 180 ? `${x} с назад` : `${Math.round(x / 60)} мин назад`);
  return (
    <div className={s.grid}>
      <Panel title="Воркеры" footer="Heartbeat пишется в Redis раз в секунду (market-data) или раз в цикл (трекер 60 с, уведомитель 30 с).">
        <dl className={s.kv}>
          {Object.entries(d.workers).map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd className={typeof v === "string" || v.heartbeat_age_sec == null || v.heartbeat_age_sec > 300 ? "down" : "up"}>
                {typeof v === "string" ? v : age(v.heartbeat_age_sec)}
                {typeof v !== "string" && v.status ? (
                  <span className="caption">
                    {" "}
                    · режим {String(v.status.mode)}, свечей {String(v.status.polled ?? v.status.klines)}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel title="Данные и движок">
        <dl className={s.kv}>
          <dt>Инструментов с H4</dt>
          <dd>{d.candles_h4.instruments}</dd>
          <dt>Отстают больше 5 ч</dt>
          <dd className={d.candles_h4.stale_over_5h ? "down" : "up"}>{d.candles_h4.stale_over_5h}</dd>
          <dt>Последний сигнал</dt>
          <dd>{d.last_signal_at ? formatTimeUTC(d.last_signal_at) : "—"}</dd>
          <dt>Последнее событие трекера</dt>
          <dd>{d.last_event_at ? formatTimeUTC(d.last_event_at) : "—"}</dd>
          <dt>Писем сегодня</dt>
          <dd>{d.notifications_sent_today}</dd>
          <dt>Почта</dt>
          <dd>{d.mail}</dd>
        </dl>
      </Panel>
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState<A.AuditRow[] | null>(null);
  useEffect(() => {
    A.getAudit()
      .then((x) => setRows(x))
      .catch(() => setRows([]));
  }, []);
  if (!rows) return <EmptyState text="Загрузка…" />;
  return (
    <Panel title="Аудит-лог" flush>
      {rows.length === 0 ? (
        <EmptyState text="Действий пока нет." />
      ) : (
        <Table compact stack={false}>
          <thead>
            <tr>
              <Th>Когда</Th>
              <Th>Кто</Th>
              <Th>Действие</Th>
              <Th>Объект</Th>
              <Th>Детали</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <Td className="caption">{a.at ? formatTimeUTC(a.at) : "—"}</Td>
                <Td>{a.actor}</Td>
                <Td>{a.action}</Td>
                <Td className="caption">{a.target}</Td>
                <Td className="caption">{JSON.stringify(a.payload)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function AdminInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const { user, loading } = useAuth();
  const tab = (TABS.find(([k]) => k === sp.get("tab"))?.[0] ?? "strategies") as Tab;
  const { msg, run } = useToast();
  if (loading) return <EmptyState text="Загрузка…" />;
  if (!user || (user.role !== "admin" && user.role !== "owner")) return <EmptyState text="Раздел доступен только администраторам." />;
  return (
    <>
      <div className={s.tabs} role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} data-active={tab === k} onClick={() => router.replace(`/admin?tab=${k}`)}>
            {label}
          </button>
        ))}
      </div>
      {msg && (
        <p className={t.toast} data-kind={msg.kind} role="status" style={{ marginBottom: 12 }}>
          {msg.text}
        </p>
      )}
      {tab === "strategies" && <Strategies run={run} />}
      {tab === "instruments" && <Instruments run={run} />}
      {tab === "signals" && <Signals run={run} />}
      {tab === "users" && <Users run={run} me={{ id: user.id, role: user.role }} />}
      {tab === "system" && <System />}
      {tab === "audit" && <Audit />}
    </>
  );
}

export default function AdminPage() {
  return (
    <AppShell title="Админка">
      <Suspense fallback={<EmptyState text="Загрузка…" />}>
        <AdminInner />
      </Suspense>
    </AppShell>
  );
}
