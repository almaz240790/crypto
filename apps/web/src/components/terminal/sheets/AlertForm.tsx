"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button, Input, Select } from "@/components/ui";
import { useT } from "@/i18n/client";
import type { AlertDraft } from "../state/useChartAlerts";
import c from "../chrome/chrome.module.css";

type Props = {
  authed: boolean;
  draft: AlertDraft;
  onDraft: (d: AlertDraft) => void;
  onSubmit: () => void;
  /** Активных алертов по инструменту. */
  count: number;
};

/**
 * Алерт по цене (план 2A.6, 2B.9 §9): форма из ui Select, Input и Button. Гость видит объяснение и «Войти» /
 * «Регистрация» до формы, а не ошибку после отправки. Тексты опций — прежние.
 */
export function AlertForm({ authed, draft, onDraft, onSubmit, count }: Props) {
  const t = useT();
  const path = usePathname();
  if (!authed) {
    return (
      <div className={c.alertForm}>
        <p>{t("Войдите, чтобы ставить алерты")}</p>
        <div className={c.actions}>
          <Button variant="primary" size="sm" href={`/login?next=${encodeURIComponent(path)}`}>
            {t("Войти")}
          </Button>
          <Button variant="ghost" size="sm" href="/register">
            {t("Регистрация")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form
      className={c.alertForm}
      aria-label={t("новый алерт по цене")}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Select label={t("условие")} aria-label={t("условие цены")} value={draft.op} onChange={(e) => onDraft({ ...draft, op: e.target.value as AlertDraft["op"] })}>
        <option value="cross_up">{t("пересечение вверх")}</option>
        <option value="cross_down">{t("пересечение вниз")}</option>
        <option value="enter_range">{t("вход в диапазон")}</option>
      </Select>
      <Input label={t("цена")} aria-label={t("цена алерта")} mono inputMode="decimal" required value={draft.price} onChange={(e) => onDraft({ ...draft, price: e.target.value })} />
      {draft.op === "enter_range" && <Input label={t("вторая граница")} aria-label={t("вторая граница")} mono inputMode="decimal" required value={draft.price2} onChange={(e) => onDraft({ ...draft, price2: e.target.value })} />}
      <Select label={t("срабатывание")} aria-label={t("частота")} value={draft.frequency} onChange={(e) => onDraft({ ...draft, frequency: e.target.value as AlertDraft["frequency"] })}>
        <option value="once">{t("один раз")}</option>
        <option value="every">{t("каждый раз")}</option>
        <option value="once_per_bar">{t("раз в свечу")}</option>
      </Select>
      <Button type="submit" variant="primary">
        {t("Создать алерт")}
      </Button>
      <p className="caption">
        {t("Проверка по минутным свечам, до 60 с. Активных по инструменту: {n}.", { n: count })} <Link href="/alerts">{t("Все алерты")}</Link>
      </p>
    </form>
  );
}
