"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Input } from "@/components/ui";
import { confirmReset, pwnedCount, requestReset } from "@/lib/auth-client";
import s from "./AuthCard.module.css";
import { useT } from "@/i18n/client";

export function ResetForm({ token }: { token: string | null }) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (token) {
        const n = await pwnedCount(password);
        if (n && n > 0) throw new Error(t("этот пароль встречается в утечках, выберите другой"));
        await confirmReset(token, password);
      } else {
        await requestReset(email);
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ошибка"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className={s.form}>
        <div className={s.ok}>
          {token ? t("Пароль изменён. Войдите с новым паролем.") : `Если адрес ${email} зарегистрирован, письмо со ссылкой отправлено. Ссылка действует 1 час.`}
        </div>
        <Button href="/login">{t("Войти")}</Button>
      </div>
    );
  }

  return (
    <form className={s.form} onSubmit={submit} noValidate>
      {error && (
        <div className={s.error} role="alert">
          {error}
        </div>
      )}
      {token ? (
        <Input label={t("Новый пароль")} type="password" name="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} hint={t("не короче 10 символов")} />
      ) : (
        <Input label="Email" type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      )}
      <Button type="submit" variant="primary" block disabled={busy || (token ? password.length < 10 : !email)}>
        {token ? t("Сохранить пароль") : t("Прислать ссылку")}
      </Button>
      <div className={s.row}>
        <Link href="/login">{t("Назад ко входу")}</Link>
      </div>
    </form>
  );
}
