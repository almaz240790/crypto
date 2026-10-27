"use client";

import Link from "next/link";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { DirectionBadge, EmptyState, GradeBadge, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { getAccessToken } from "@/lib/auth-client";
import { formatPrice, formatR, formatTimeUTC } from "@/lib/format";
import {
  addToWatchlist,
  fetchFeed,
  fetchSummary,
  filtersFromSearch,
  filtersToSearch,
  journalFromSignal,
  PAGE,
  unrealizedR,
  type FeedFilters,
  type FeedResponse,
  type SignalRow,
  type Summary,
} from "@/lib/signals";
import { useLive } from "@/lib/useLive";
import { Countdown } from "./Countdown";
import s from "./Feed.module.css";
import { Sparkline } from "./Sparkline";
import { useT } from "@/i18n/client";
import type { T } from "@/i18n";
const GRADES = ["A", "B", "C"];
const DAYS = [
  ["", "весь период"],
  ["7", "7 дней"],
  ["30", "30 дней"],
  ["90", "90 дней"],
  ["365", "год"],
];

function ago(iso: string, now: number, t: T): string {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 60) return t("{n} мин", { n: m });
  const h = Math.floor(m / 60);
  if (h < 48) return t("{n} ч", { n: h });
  return t("{n} д", { n: Math.floor(h / 24) });
}

export function Feed({ instruments }: { instruments: { symbol: string; tick_size: string | null }[] }) {
  const t = useT();
  const ticks = useMemo(() => Object.fromEntries(instruments.map((i) => [i.symbol, i.tick_size])), [instruments]);
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { user } = useAuth();
  const filters = useMemo(() => filtersFromSearch(new URLSearchParams(sp.toString())), [sp]);
  const canForward = user?.role === "admin" || user?.role === "owner";

  const [data, setData] = useState<FeedResponse | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setFilters = useCallback(
    (patch: Partial<FeedFilters>) => {
      const next = { ...filters, ...patch, page: patch.page ?? 0 };
      router.replace(`${pathname}${filtersToSearch(next)}`, { scroll: false });
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    let alive = true;
    fetchFeed(filters)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        setNow(Date.now());
      })
      .catch((e: Error) => alive && setError(e.message));
    fetchSummary(filters.scope)
      .then((x) => alive && setSummary(x))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [filters, tick]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // По закрытию H4: движок публикует сигнал ~60 с спустя — перечитываем ленту дважды.
  const onZero = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setTick((t) => t + 1), 70_000);
    setTimeout(() => setTick((t) => t + 1), 1_000);
  }, []);

  const symbols = useMemo(() => Array.from(new Set((data?.items ?? []).map((i) => i.symbol))), [data]);
  const onSignal = useCallback(() => setTick((t) => t + 1), []);
  const { prices: livePrices, connected } = useLive(symbols, getAccessToken(), onSignal);

  const priceOf = (row: SignalRow): string | undefined =>
    livePrices[row.symbol]?.p ?? data?.prices[String(row.instrument_id)]?.p;

  const sortBtn = (key: string, label: string) => (
    <button
      type="button"
      className={s.sortBtn}
      data-active={filters.sort === key}
      onClick={() => setFilters({ sort: key, order: filters.sort === key && filters.order === "desc" ? "asc" : "desc" })}
      aria-label={t("сортировать по: {label}", { label })}
    >
      {label}
      {filters.sort === key ? (filters.order === "desc" ? " ↓" : " ↑") : ""}
    </button>
  );

  async function act(fn: () => Promise<unknown>, okText: string) {
    try {
      await fn();
      setToast({ text: okText, kind: "ok" });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : t("ошибка"), kind: "error" });
    }
    setTimeout(() => setToast(null), 4000);
  }

  const items = data?.items ?? [];
  const pages = data ? Math.ceil(data.total / PAGE) : 0;

  return (
    <div className={s.wrap}>
      <div className={s.counters}>
        <span>{t("активных")}{" "}<strong>{summary?.active ?? "—"}</strong>
        </span>
        <span>{t("новых сегодня")}{" "}<strong>{summary?.today_new ?? "—"}</strong>
        </span>
        <span>{t("следующая свеча H4 через")}{" "}<Countdown until={summary?.next_h4_close ?? null} onZero={onZero} />
        </span>
        <span className={s.live} title={connected ? t("живые цены по WebSocket") : t("нет соединения, цены по последней минуте")}>
          <i data-on={connected} /> {connected ? "live" : "offline"}
        </span>
      </div>

      <div className={s.bar} role="group" aria-label={t("фильтры")}>
        <div className={s.tabs}>
          {(
            [
              ["open", t("Активные")],
              ["closed", t("История")],
              ["all", t("Все")],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={filters.tab === v} onClick={() => setFilters({ tab: v })}>
              {l}
            </button>
          ))}
        </div>
        <input
          list="feed-symbols"
          placeholder={t("инструмент")}
          aria-label={t("инструмент")}
          defaultValue={filters.symbol}
          key={`sym-${filters.symbol}`}
          onBlur={(e) => e.target.value.toUpperCase() !== filters.symbol && setFilters({ symbol: e.target.value.toUpperCase() })}
          onKeyDown={(e) => e.key === "Enter" && setFilters({ symbol: (e.target as HTMLInputElement).value.toUpperCase() })}
        />
        <datalist id="feed-symbols">
          {instruments.map((x) => (
            <option key={x.symbol} value={x.symbol} />
          ))}
        </datalist>
        <select aria-label={t("направление")} value={filters.direction} onChange={(e) => setFilters({ direction: e.target.value })}>
          <option value="">{t("long и short")}</option>
          <option value="long">long</option>
          <option value="short">short</option>
        </select>
        <select aria-label={t("градация")} value={filters.grade} onChange={(e) => setFilters({ grade: e.target.value })}>
          <option value="">{t("все градации")}</option>
          {GRADES.map((g) => (
            <option key={g} value={g}>
              только {g}
            </option>
          ))}
        </select>
        <select aria-label={t("период")} value={filters.days} onChange={(e) => setFilters({ days: e.target.value })}>
          {DAYS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {canForward && (
          <select aria-label={t("стратегия")} value={filters.scope} onChange={(e) => setFilters({ scope: e.target.value as "live" | "forward" })}>
            <option value="live">live</option>
            <option value="forward">{t("форвард (только админ)")}</option>
          </select>
        )}
        {filtersToSearch(filters) && (
          <button type="button" className={s.sortBtn} onClick={() => router.replace(pathname)}>{t("сбросить")}</button>
        )}
      </div>

      {toast && (
        <div className={s.toast} data-kind={toast.kind} role="status">
          {toast.text}
        </div>
      )}

      {data?.restrictions && (data.restrictions.delay_hours > 0 || data.restrictions.grades) && (
        <p className="caption" role="note">
          Тариф {data.restrictions.plan}: сигналы градации {data.restrictions.grades?.join(", ") ?? t("всех")} с задержкой {data.restrictions.delay_hours} ч
          {!data.restrictions.all_instruments && ", только BTC, ETH и инструменты вотчлиста"}.{" "}
          <Link href="/pricing">{t("Тарифы")}</Link>
        </p>
      )}
      <Panel flush title={data ? `${data.total} ${data.scope === "forward" ? t("форвард-") : ""}${t("сигналов")}` : t("Сигналы")} actions={<span>{t("обновляется по WebSocket и каждую свечу H4")}</span>}>
        {error ? (
          <EmptyState text={t("Не удалось загрузить ленту: {error}", { error })} />
        ) : !data ? (
          <EmptyState text={t("Загрузка…")} />
        ) : items.length === 0 ? (
          <EmptyState
            text={
              filters.tab === "open"
                ? t("Нет активных сигналов. Следующая проверка через {rest}", { rest: summary ? "" : "—" })
                : t("По этим фильтрам сигналов нет.")
            }
            action={filters.tab === "open" ? <Countdown until={summary?.next_h4_close ?? null} /> : undefined}
          />
        ) : (
          <Table clickable compact>
            <thead>
              <tr>
                <Th>{sortBtn("time", t("Время, UTC"))}</Th>
                <Th>{sortBtn("symbol", t("Инструмент"))}</Th>
                <Th>{sortBtn("score", t("Гр."))}</Th>
                <Th num>{t("Вход")}</Th>
                <Th num>SL</Th>
                <Th num>TP1</Th>
                <Th num>TP2</Th>
                <Th num>TP3</Th>
                <Th num>{sortBtn("rr", "R:R")}</Th>
                <Th>{sortBtn("status", t("Статус"))}</Th>
                <Th num>P&L, R</Th>
                <Th className={s.actCol} />
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const price = priceOf(r);
                const open = ["pending", "active", "tp1_hit", "tp2_hit"].includes(r.status);
                const pnl = open ? unrealizedR(r, price) : r.result?.realized_r ? Number(r.result.realized_r) : null;
                const tick = ticks[r.symbol] ?? null;
                return (
                  <tr key={r.id} onClick={() => router.push(`/signals/${r.id}`)}>
                    <Td mobile="secondary" title={t("{ago} назад", { ago: ago(r.candle_close_time, now, t) })}>
                      <span className="text-2 num" style={{ textAlign: "left" }}>
                        {formatTimeUTC(r.candle_close_time).replace(" UTC", "")}
                      </span>
                    </Td>
                    <Td>
                      <span className={s.sym}>
                        <strong>{r.symbol}</strong>
                        <DirectionBadge direction={r.direction} />
                        <Sparkline values={data.sparklines[String(r.instrument_id)] ?? []} up={r.direction === "long"} width={56} height={18} />
                      </span>
                    </Td>
                    <Td mobile="hidden">
                      <GradeBadge grade={r.grade} /> <span className="caption">{r.score}</span>
                    </Td>
                    <Td num mobile="right">
                      {formatPrice(r.entry_limit ?? r.entry_market, tick)}
                    </Td>
                    <Td num mobile="hidden" className="down">
                      {formatPrice(r.stop_loss, tick)}
                    </Td>
                    <Td num mobile="hidden">
                      {formatPrice(r.tp1, tick)}
                    </Td>
                    <Td num mobile="hidden">
                      {formatPrice(r.tp2, tick)}
                    </Td>
                    <Td num mobile="hidden">
                      {formatPrice(r.tp3, tick)}
                    </Td>
                    <Td num mobile="hidden">
                      {r.rr_tp2 ? Number(r.rr_tp2).toFixed(2) : "—"}
                    </Td>
                    <Td mobile="secondary">
                      <StatusBadge status={r.status} />{" "}
                      {r.last_event_at && <span className={s.ago}>{ago(r.last_event_at, now, t)}</span>}
                    </Td>
                    <Td num mobile="right" className={pnl == null ? "" : pnl > 0 ? "up" : pnl < 0 ? "down" : ""}>
                      {pnl == null ? "—" : formatR(pnl)}
                    </Td>
                    <Td mobile="hidden" className={s.actCol} onClick={(e) => e.stopPropagation()}>
                      <span className={s.actions}>
                        <button type="button" onClick={() => act(() => addToWatchlist(r.symbol), `${r.symbol} в вотчлисте`)}>{t("+ вотчлист")}</button>
                        {open && (
                          <button type="button" onClick={() => act(() => journalFromSignal(r), `Запись в журнале: ${r.symbol} ${r.direction}`)}>{t("я вошёл")}</button>
                        )}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>

      {pages > 1 && (
        <div className={s.pager}>
          <span>
            страница {filters.page + 1} из {pages}
          </span>
          <span className={s.actions}>
            <button type="button" disabled={filters.page === 0} onClick={() => setFilters({ page: filters.page - 1 })}>{t("назад")}</button>
            <button type="button" disabled={filters.page + 1 >= pages} onClick={() => setFilters({ page: filters.page + 1 })}>{t("вперёд")}</button>
          </span>
        </div>
      )}
      <p className="caption">{t("Прошлые результаты не гарантируют будущих. Сигнал — не рекомендация; решение о входе и размере позиции принимаете вы.")}</p>
    </div>
  );
}
