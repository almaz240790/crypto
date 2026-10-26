"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import s from "@/components/billing/billing.module.css";
import t from "@/components/tools/tools.module.css";
import { Badge, Button, EmptyState, Panel, Table, Td, Th } from "@/components/ui";
import { getBillingMe, getPayments, PAYMENT_STATUS, PLAN_TITLE, refreshPayment, type BillingMe, type PaymentOut } from "@/lib/billing";
import { formatTimeUTC } from "@/lib/format";

const TONE: Record<PaymentOut["status"], "up" | "down" | "warn" | "muted"> = { paid: "up", pending: "warn", underpaid: "warn", expired: "muted", failed: "down", refunded: "muted" };

function Inner() {
  const params = useSearchParams();
  const justPaid = params.get("paid");
  const [me, setMe] = useState<BillingMe | null>(null);
  const [items, setItems] = useState<PaymentOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, p] = await Promise.all([getBillingMe(), getPayments()]);
    setMe(m);
    setItems(p);
  }, []);
  useEffect(() => {
    queueMicrotask(() => load().catch((e: Error) => setError(e.message)));
  }, [load]);

  async function check(id: string) {
    try {
      const p = await refreshPayment(id);
      setToast(p.status === "paid" ? "Оплата подтверждена" : `Статус: ${PAYMENT_STATUS[p.status]}`);
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "ошибка");
    }
    setTimeout(() => setToast(null), 4000);
  }

  const sub = me?.subscription;
  return (
    <div className={s.wrap}>
      {justPaid && (
        <p className="up" role="status">
          Спасибо. Оплата по инвойсу {justPaid} обрабатывается: подтверждение сети занимает от минуты до часа. Статус обновится сам, кнопка «Проверить» — для ручной сверки.
        </p>
      )}
      {toast && (
        <p role="status" className="text-2">
          {toast}
        </p>
      )}
      {error && <EmptyState text={error} />}
      {me && (
        <Panel title="Текущий тариф" actions={<Button href="/pricing" size="sm" variant="primary">{me.plan === "free" ? "Выбрать тариф" : "Продлить"}</Button>}>
          <div className={s.strip}>
            <span>
              тариф <strong>{PLAN_TITLE[me.plan]}</strong>
            </span>
            {sub && (
              <>
                <span>
                  действует до <strong>{formatTimeUTC(sub.current_period_end)}</strong>
                </span>
                <span>
                  осталось <strong>{sub.days_left} дн.</strong>
                </span>
                {sub.status === "trialing" && <Badge tone="warn">пробный период</Badge>}
                {sub.in_grace && <Badge tone="down">льготные 3 дня — продлите, чтобы не потерять доступ</Badge>}
              </>
            )}
            <span>
              баланс <strong>{me.balance_usd} USD</strong>
            </span>
            {!me.billing_enabled && <span className="caption">до запуска оплаты все пользователи на уровне Pro</span>}
          </div>
        </Panel>
      )}
      <Panel flush title="История платежей" footer="Хэш транзакции — ссылка на обозреватель сети. Инвойс действует 30 минут; недоплата зачисляется на баланс, переплата — тоже.">
        {items === null ? (
          <EmptyState text="Загрузка…" />
        ) : items.length === 0 ? (
          <EmptyState text="Платежей пока нет." action={<Button href="/pricing" size="sm">Тарифы</Button>} />
        ) : (
          <Table compact>
            <thead>
              <tr>
                <Th>Дата</Th>
                <Th>Заказ</Th>
                <Th num>Сумма</Th>
                <Th>Статус</Th>
                <Th>Оплачено</Th>
                <Th>Транзакция</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <Td mobile="secondary" className="text-2">
                    {p.created_at ? formatTimeUTC(p.created_at) : "—"}
                  </Td>
                  <Td>
                    <strong>{PLAN_TITLE[p.plan]}</strong> × {p.months} мес. <span className="caption">{p.id}</span>
                  </Td>
                  <Td num mobile="right">
                    {p.amount_due_usd} USD
                    {Number(p.discount_usd) > 0 && <span className="caption"> (−{p.discount_usd})</span>}
                  </Td>
                  <Td>
                    <Badge tone={TONE[p.status]}>{PAYMENT_STATUS[p.status]}</Badge>
                  </Td>
                  <Td mobile="hidden" className="text-2">
                    {p.actually_paid ? `${p.actually_paid} ${p.pay_currency ?? ""}` : p.provider === "balance" ? "с баланса" : "—"}
                  </Td>
                  <Td mobile="hidden" className="caption">
                    {p.tx_hash ? <span title={p.tx_hash}>{p.tx_hash.slice(0, 10)}…</span> : "—"}
                  </Td>
                  <Td mobile="hidden">
                    {p.status === "pending" && (
                      <span style={{ display: "inline-flex", gap: 8 }}>
                        {p.invoice_url && (
                          <Link href={p.invoice_url} target="_blank" rel="noreferrer">
                            оплатить
                          </Link>
                        )}
                        <button type="button" className={t.small} onClick={() => check(p.id)} aria-label={`проверить оплату ${p.id}`}>
                          проверить
                        </button>
                      </span>
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

export default function BillingPage() {
  return (
    <AppShell title="Тариф и оплата">
      <Suspense fallback={<EmptyState text="Загрузка…" />}>
        <Inner />
      </Suspense>
    </AppShell>
  );
}
