"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { useSignalsAccess } from "@/components/auth/signalsAccess";
import s from "@/components/tools/tools.module.css";
import { Badge, Button, EmptyState, Panel, Table, Td, Th } from "@/components/ui";
import { formatListPrice, formatPct } from "@/lib/format";
import { fetchFeed, DEFAULT_FILTERS } from "@/lib/signals";
import { addWatch, getInstruments, getScreener, getWatchlist, removeWatch, type Instrument, type ScreenerRow } from "@/lib/user";
import { useT } from "@/i18n/client";

export default function WatchlistPage() {
  const t = useT();
  // пока сигналы закрыты (ADR-0013), тому, кому они не видны, — без колонки сигналов и ссылок в их ленту
  const { open: signals } = useSignalsAccess();
  const [symbols, setSymbols] = useState<string[] | null>(null);
  const [rows, setRows] = useState<Record<string, ScreenerRow>>({});
  const [active, setActive] = useState<Record<string, number>>({});
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [input, setInput] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const wl = await getWatchlist();
    const syms = wl.items.map((i) => i.symbol);
    setSymbols(syms);
    if (syms.length) {
      getScreener(syms)
        .then((r) => setRows(Object.fromEntries(r.items.map((x) => [x.symbol, x]))))
        .catch(() => {});
      if (signals)
        fetchFeed({ ...DEFAULT_FILTERS, tab: "open" })
          .then((f) => {
            const c: Record<string, number> = {};
            f.items.forEach((i) => (c[i.symbol] = (c[i.symbol] ?? 0) + 1));
            setActive(c);
          })
          .catch(() => {});
    }
  }, [signals]);

  useEffect(() => {
    queueMicrotask(() => load().catch(() => setSymbols([])));
    getInstruments()
      .then((r) => setInstruments(r))
      .catch(() => {});
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await load();
      setToast(ok);
    } catch (e) {
      setToast(e instanceof Error ? e.message : t("ошибка"));
    }
    setTimeout(() => setToast(null), 3000);
  };

  return (
    <AppShell title={t("Вотчлист")}>
      <div className={s.wrap}>
        <form
          className={s.inline}
          onSubmit={(e) => {
            e.preventDefault();
            const sym = input.trim().toUpperCase();
            if (sym) act(() => addWatch(sym), `${sym} добавлен`).then(() => setInput(""));
          }}
        >
          <input list="wl-symbols" placeholder={t("инструмент")} aria-label={t("инструмент")} value={input} onChange={(e) => setInput(e.target.value)} style={{ textTransform: "uppercase" }} />
          <datalist id="wl-symbols">
            {instruments.map((i) => (
              <option key={i.symbol} value={i.symbol} />
            ))}
          </datalist>
          <Button type="submit" size="sm" variant="primary" disabled={!input.trim()}>{t("Добавить")}</Button>
          {toast && (
            <span className={s.toast} role="status">
              {toast}
            </span>
          )}
        </form>
        <Panel flush title={symbols ? `${symbols.length} инструментов` : t("Вотчлист")} footer={signals ? t("Сигналы по инструментам вотчлиста приходят всегда, остальные — по настройке уведомлений.") : t("Инструменты вотчлиста показаны в меню кабинета: оттуда — сразу на график.")}>
          {symbols === null ? (
            <EmptyState text={t("Загрузка…")} />
          ) : symbols.length === 0 ? (
            <EmptyState text={signals ? t("Список пуст. Добавьте инструмент выше или из ленты сигналов.") : t("Список пуст. Добавьте инструмент выше или найдите его в скринере.")} action={<Button href="/screener" size="sm">{t("Скринер")}</Button>} />
          ) : (
            <Table compact>
              <thead>
                <tr>
                  <Th>{t("Инструмент")}</Th>
                  <Th num>{t("Цена")}</Th>
                  <Th num>{t("24 ч")}</Th>
                  <Th>Bias</Th>
                  <Th>{t("Ближайшая зона")}</Th>
                  {signals && <Th num>{t("Активных сигналов")}</Th>}
                  <Th />
                </tr>
              </thead>
              <tbody>
                {symbols.map((sym) => {
                  const r = rows[sym];
                  const ch = r?.change_24h ? Number(r.change_24h) : null;
                  return (
                    <tr key={sym}>
                      <Td>
                        <Link href={signals ? `/signals?symbol=${sym}&tab=all` : `/chart/${sym}/4h`}>
                          <strong>{sym}</strong>
                        </Link>
                      </Td>
                      <Td num mobile="right">{formatListPrice(r?.price ?? null, instruments.find((i) => i.symbol === sym)?.tick_size)}</Td>
                      <Td num mobile="right" className={ch && ch > 0 ? "up" : ch && ch < 0 ? "down" : ""}>
                        {formatPct(ch)}
                      </Td>
                      <Td mobile="secondary">{r?.bias ? <Badge tone={r.bias === "long" ? "up" : r.bias === "short" ? "down" : "muted"}>{r.bias}</Badge> : "—"}</Td>
                      <Td mobile="secondary" className="text-2">
                        {r?.zone ? `${r.zone.kind.toUpperCase()} ${r.zone.direction} · ${Number(r.zone.distance_atr ?? 0).toFixed(2)} ATR` : t("нет активной")}
                      </Td>
                      {signals && <Td num mobile="hidden">{active[sym] ?? 0}</Td>}
                      <Td mobile="hidden">
                        <button type="button" className={s.small} onClick={() => act(() => removeWatch(sym), `${sym} удалён`)} aria-label={`убрать ${sym}`}>{t("убрать")}</button>
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
