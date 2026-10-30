"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import s from "@/components/billing/billing.module.css";
import { Badge, Button, Input, Panel } from "@/components/ui";
import { checkout, getBillingMe, getPlans, getQuote, PLAN_TITLE, type BillingMe, type Months, type PlanInfo, type Quote } from "@/lib/billing";
import { useT } from "@/i18n/client";

const FEATURES: Record<string, string[]> = {
  pro: ["Все градации сигналов, сразу", "Все инструменты", "Telegram, push, email — мгновенно", "Полная история и CSV", "Журнал без ограничений, вотчлист 50"],
  premium: ["Всё из Pro", "Экспериментальные стратегии (форвард)", "Расширенный список инструментов", "Вебхуки и API-ключ (только чтение)", "Приоритетная поддержка, 4 ч"],
};

const PERIOD_LABEL: Record<Months, string> = { 1: "1 месяц", 3: "3 месяца", 12: "12 месяцев" };

export function Pricing() {
  const t = useT();
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
      setMsg({ text: e instanceof Error ? e.message : t("ошибка"), kind: "error" });
    }
  }

  async function pay() {
    if (!chosen) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await checkout(chosen, months, promo);
      if (r.paid_from_balance) {
        setMsg({ text: t("Оплачено с баланса, тариф активирован"), kind: "ok" });
        router.push("/billing");
      } else if (r.payment.invoice_url) {
        window.location.href = r.payment.invoice_url;
      }
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : t("ошибка"), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  // Цена без «.00»: $29, $249, $20.75.
  const usd = (v: number) => `$${v.toFixed(2).replace(/\.00$/, "")}`;
  const perMonth = (p: PlanInfo) => usd(Number(p.prices[String(months)]) / months);

  return (
    <div className={s.wrap}>
      <div className={s.toggle} role="group" aria-label={t("срок подписки")}>
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
            {t(PERIOD_LABEL[m])}
            {m === 3 && <span className={s.save}>−10 %</span>}
            {m === 12 && <span className={s.save}>−28 %</span>}
          </button>
        ))}
      </div>
      {plans === null ? (
        <p className="text-2">{t("Загрузка…")}</p>
      ) : (
        <div className={s.cards}>
          <article className={s.card} data-current={me?.plan === "free" || undefined}>
            <h3>Free</h3>
            <p className={s.amount}>
              <span>$0</span>
            </p>
            <p className={s.per}>{t("навсегда")}</p>
            <ul>
              <li>{t("Сигналы градации A с задержкой 12 часов")}</li>
              <li>{t("BTC, ETH + 3 инструмента на выбор")}</li>
              <li>{t("Email-дайджест раз в день")}</li>
              <li>{t("Публичная статистика")}</li>
              <li>{t("Журнал 20 записей, вотчлист 5")}</li>
            </ul>
            {me?.plan === "free" ? (
              <Badge tone="muted">{t("ваш тариф")}</Badge>
            ) : (
              !user && (
                <Button href="/register" block>
                  {t("Начать бесплатно")}
                </Button>
              )
            )}
          </article>
          {plans.map((p) => (
            <article key={p.code} className={s.card} data-hot={p.code === "pro" || undefined} data-current={me?.plan === p.code || undefined}>
              {p.code === "pro" && <span className={s.badge}>{t("Популярный")}</span>}
              <h3>{p.title}</h3>
              <p className={s.amount}>
                <span>{perMonth(p)}</span> {t("/ мес")}
              </p>
              <p className={s.per}>
                {months === 1 ? t("оплата за 1 месяц") : t("{a} за {n}", { a: usd(Number(p.prices[String(months)])), n: t(PERIOD_LABEL[months]) })}
              </p>
              <ul>
                {FEATURES[p.code].map((f) => (
                  <li key={f}>{t(f)}</li>
                ))}
              </ul>
              {me?.plan === p.code ? (
                <Badge tone="up">
                  {t("ваш тариф")}
                  {me.subscription ? ` ${t("до")} ${new Date(me.subscription.current_period_end).toLocaleDateString("ru-RU")}` : ""}
                </Badge>
              ) : null}
              <Button variant={p.code === "pro" ? "primary" : "default"} block onClick={() => pick(p.code)} disabled={!enabled && !!user}>
                {user ? (me?.plan === p.code ? t("Продлить") : `${t("Выбрать")} ${p.title}`) : t("Зарегистрироваться")}
              </Button>
            </article>
          ))}
        </div>
      )}
      {!enabled && (
        <p className={s.off}>{t("Оплата пока не включена: до запуска все зарегистрированные пользователи получают уровень Pro. Первые 7 дней Pro — бесплатно при регистрации.")}</p>
      )}
      {user && chosen && (
        <Panel title={`Заказ: ${PLAN_TITLE[chosen]} на ${PERIOD_LABEL[months]}`}>
          <div className={s.promo}>
            <Input label={t("Промокод")} value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} style={{ textTransform: "uppercase", width: 180 }} />
            <Button size="sm" onClick={() => pick(chosen)}>{t("Применить")}</Button>
          </div>
          {quote && (
            <div className={s.summary} style={{ marginTop: 12 }}>
              <span>{t("Цена")}{" "}<strong>{quote.price} USD</strong>
              </span>
              {Number(quote.discount) > 0 && (
                <span>{t("Скидка по промокоду")}{" "}<strong>−{quote.discount} USD</strong>
                </span>
              )}
              {Number(quote.balance_applied) > 0 && (
                <span>{t("С баланса")}{" "}<strong>−{quote.balance_applied} USD</strong>
                </span>
              )}
              <span>{t("К оплате")}{" "}<strong>{quote.amount_due} USD</strong>{" "}{t("в USDT, USDC, BTC, ETH или TON — монету выберете на странице оплаты")}</span>
            </div>
          )}
          {msg && (
            <p className={msg.kind === "error" ? "down" : "up"} role={msg.kind === "error" ? "alert" : "status"} style={{ marginTop: 8 }}>
              {msg.text}
            </p>
          )}
          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <Button variant="primary" onClick={pay} disabled={!quote || busy || !enabled}>
              {Number(quote?.amount_due ?? 1) === 0 ? t("Оплатить с баланса") : t("Перейти к оплате")}
            </Button>
            <span className="caption">{t("Инвойс действует 30 минут. Подписка без автопродления, оплата продлевает текущий срок.")}</span>
          </div>
        </Panel>
      )}
    </div>
  );
}
