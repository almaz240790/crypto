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
import { useT } from "@/i18n/client";

const TONE: Record<PaymentOut["status"], "up" | "down" | "warn" | "muted"> = { paid: "up", pending: "warn", underpaid: "warn", expired: "muted", failed: "down", refunded: "muted" };

function Inner() {
  const tr = useT();
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
      setToast(p.status === "paid" ? tr("Оплата подтверждена") : `Статус: ${PAYMENT_STATUS[p.status]}`);
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : tr("ошибка"));
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
        <Panel title={tr("Текущий тариф")} actions={<Button href="/pricing" size="sm" variant="primary">{me.plan === "free" ? tr("Выбрать тариф") : tr("Продлить")}</Button>}>
          <div className={s.strip}>
            <span>{tr("тариф")}{" "}<strong>{PLAN_TITLE[me.plan]}</strong>
            </span>
            {sub && (
              <>
                <span>{tr("действует до")}{" "}<strong>{formatTimeUTC(sub.current_period_end)}</strong>
                </span>
                <span>{tr("осталось")}{" "}<strong>{sub.days_left} дн.</strong>
                </span>
                {sub.status === "trialing" && <Badge tone="warn">{tr("пробный период")}</Badge>}
                {sub.in_grace && <Badge tone="down">{tr("льготные 3 дня — продлите, чтобы не потерять доступ")}</Badge>}
              </>
            )}
            <span>{tr("баланс")}{" "}<strong>{me.balance_usd} USD</strong>
            </span>
            {!me.billing_enabled && <span className="caption">{tr("до запуска оплаты все пользователи на уровне Pro")}</span>}
          </div>
        </Panel>
      )}
      <Panel flush title={tr("История платежей")} footer={tr("Хэш транзакции — ссылка на обозреватель сети. Инвойс действует 30 минут; недоплата зачисляется на баланс, переплата — тоже.")}>
        {items === null ? (
          <EmptyState text={tr("Загрузка…")} />
        ) : items.length === 0 ? (
          <EmptyState text={tr("Платежей пока нет.")} action={<Button href="/pricing" size="sm">{tr("Тарифы")}</Button>} />
        ) : (
          <Table compact>
            <thead>
              <tr>
                <Th>{tr("Дата")}</Th>
                <Th>{tr("Заказ")}</Th>
                <Th num>{tr("Сумма")}</Th>
                <Th>{tr("Статус")}</Th>
                <Th>{tr("Оплачено")}</Th>
                <Th>{tr("Транзакция")}</Th>
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
                    {p.actually_paid ? `${p.actually_paid} ${p.pay_currency ?? ""}` : p.provider === "balance" ? tr("с баланса") : "—"}
                  </Td>
                  <Td mobile="hidden" className="caption">
                    {p.tx_hash ? <span title={p.tx_hash}>{p.tx_hash.slice(0, 10)}…</span> : "—"}
                  </Td>
                  <Td mobile="hidden">
                    {p.status === "pending" && (
                      <span style={{ display: "inline-flex", gap: 8 }}>
                        {p.invoice_url && (
                          <Link href={p.invoice_url} target="_blank" rel="noreferrer">{tr("оплатить")}</Link>
                        )}
                        <button type="button" className={t.small} onClick={() => check(p.id)} aria-label={`проверить оплату ${p.id}`}>{tr("проверить")}</button>
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
  const tr = useT();
  return (
    <AppShell title={tr("Тариф и оплата")}>
      <Suspense fallback={<EmptyState text={tr("Загрузка…")} />}>
        <Inner />
      </Suspense>
    </AppShell>
  );
}
