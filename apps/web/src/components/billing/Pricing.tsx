"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import s from "@/components/billing/billing.module.css";
import { Badge, Button, Input, Panel } from "@/components/ui";
import { checkout, getBillingMe, getPlans, getQuote, PLAN_TITLE, type BillingMe, type Months, type PlanInfo, type Quote } from "@/lib/billing";

const FEATURES: Record<string, string[]> = {
  pro: ["Все градации сигналов, сразу", "Все инструменты", "Telegram, push, email — мгновенно", "Полная история и CSV", "Журнал без ограничений, вотчлист 50"],
  premium: ["Всё из Pro", "Экспериментальные стратегии (форвард)", "Расширенный список инструментов", "Вебхуки и API-ключ (только чтение)", "Приоритетная поддержка, 4 ч"],
};

const PERIOD_LABEL: Record<Months, string> = { 1: "1 месяц", 3: "3 месяца", 12: "12 месяцев" };

export function Pricing() {
  const router = useRouter();
  const { user } = useAuth();
  const [plans, setPlans] = useState<PlanInfo[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [me, setMe] = useState<BillingMe | null>(null);
  const [months, setMonths] = useState<Months>(12);
  const [promo, setPromo] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPlans()
      .then((r) => {
        setPlans(r.plans);
        setEnabled(r.billing_enabled);
      })
      .catch(() => setPlans([]));
  }, []);
  useEffect(() => {
    if (user)
      getBillingMe()
        .then((r) => setMe(r))
        .catch(() => {});
  }, [user]);

  async function pick(plan: string) {
    setChosen(plan);
    setMsg(null);
    setQuote(null);
    if (!user) return router.push(`/register?next=/pricing`);
    try {
      setQuote(await getQuote(plan, months, promo));
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "ошибка", kind: "error" });
    }
  }

  async function pay() {
    if (!chosen) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await checkout(chosen, months, promo);
      if (r.paid_from_balance) {
        setMsg({ text: "Оплачено с баланса, тариф активирован", kind: "ok" });
        router.push("/billing");
      } else if (r.payment.invoice_url) {
        window.location.href = r.payment.invoice_url;
      }
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "ошибка", kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const perMonth = (p: PlanInfo) => (Number(p.prices[String(months)]) / months).toFixed(months === 1 ? 0 : 1);

  return (
    <div className={s.wrap}>
      <div className={s.toggle} role="group" aria-label="срок подписки">
        {([1, 3, 12] as Months[]).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={months === m}
            onClick={() => {
              setMonths(m);
              setQuote(null);
              setChosen(null);
            }}
          >
            {PERIOD_LABEL[m]}
            {m === 3 && <span className="caption"> −10 %</span>}
            {m === 12 && <span className="caption"> −28 %</span>}
          </button>
        ))}
      </div>
      {plans === null ? (
        <p className="text-2">Загрузка…</p>
      ) : (
        <div className={s.cards}>
          <div className={s.card} data-current={me?.plan === "free"}>
            <h3>Free</h3>
            <div className={s.amount}>0</div>
            <ul>
              <li>Сигналы градации A с задержкой 12 часов</li>
              <li>BTC, ETH + 3 инструмента на выбор</li>
              <li>Email-дайджест раз в день</li>
              <li>Публичная статистика</li>
              <li>Журнал 20 записей, вотчлист 5</li>
            </ul>
            {me?.plan === "free" && <Badge tone="muted">ваш тариф</Badge>}
          </div>
          {plans.map((p) => (
            <div key={p.code} className={s.card} data-current={me?.plan === p.code}>
              <h3>{p.title}</h3>
              <div className={s.amount}>
                {p.prices[String(months)]} <small>USD за {PERIOD_LABEL[months]}</small>
                <br />
                <small>≈ {perMonth(p)} USD / мес</small>
              </div>
              <ul>
                {FEATURES[p.code].map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {me?.plan === p.code ? (
                <Badge tone="up">ваш тариф{me.subscription ? ` до ${new Date(me.subscription.current_period_end).toLocaleDateString("ru-RU")}` : ""}</Badge>
              ) : null}
              <Button variant={p.code === "pro" ? "primary" : "default"} onClick={() => pick(p.code)} disabled={!enabled && !!user}>
                {user ? (me?.plan === p.code ? "Продлить" : `Выбрать ${p.title}`) : "Зарегистрироваться"}
              </Button>
            </div>
          ))}
        </div>
      )}
      {!enabled && (
        <p className="caption">Оплата пока не включена: до запуска все зарегистрированные пользователи получают уровень Pro. Первые 7 дней Pro — бесплатно при регистрации.</p>
      )}
      {user && chosen && (
        <Panel title={`Заказ: ${PLAN_TITLE[chosen]} на ${PERIOD_LABEL[months]}`}>
          <div className={s.promo}>
            <Input label="Промокод" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} style={{ textTransform: "uppercase", width: 180 }} />
            <Button size="sm" onClick={() => pick(chosen)}>
              Применить
            </Button>
          </div>
          {quote && (
            <div className={s.summary} style={{ marginTop: 12 }}>
              <span>
                Цена <strong>{quote.price} USD</strong>
              </span>
              {Number(quote.discount) > 0 && (
                <span>
                  Скидка по промокоду <strong>−{quote.discount} USD</strong>
                </span>
              )}
              {Number(quote.balance_applied) > 0 && (
                <span>
                  С баланса <strong>−{quote.balance_applied} USD</strong>
                </span>
              )}
              <span>
                К оплате <strong>{quote.amount_due} USD</strong> в USDT, USDC, BTC, ETH или TON — монету выберете на странице оплаты
              </span>
            </div>
          )}
          {msg && (
            <p className={msg.kind === "error" ? "down" : "up"} role={msg.kind === "error" ? "alert" : "status"} style={{ marginTop: 8 }}>
              {msg.text}
            </p>
          )}
          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <Button variant="primary" onClick={pay} disabled={!quote || busy || !enabled}>
              {Number(quote?.amount_due ?? 1) === 0 ? "Оплатить с баланса" : "Перейти к оплате"}
            </Button>
            <span className="caption">Инвойс действует 30 минут. Подписка без автопродления, оплата продлевает текущий срок.</span>
          </div>
        </Panel>
      )}
    </div>
  );
}
