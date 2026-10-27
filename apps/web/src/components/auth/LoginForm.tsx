"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Input } from "@/components/ui";
import { TwoFactorRequired, login, loginTwoFactor, pendingTwoFactorTicket, requestMagic } from "@/lib/auth-client";
import { useAuth } from "./AuthProvider";
import s from "./AuthCard.module.css";
import { Social } from "./Social";
import { useT } from "@/i18n/client";

export function LoginForm({ next }: { next: string }) {
  const t = useT();
  const router = useRouter();
  const { reload } = useAuth();
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [twoFactor, setTwoFactor] = useState(false);
  const [code, setCode] = useState("");
  // соцвход или ссылка из письма могли уже оставить билет 2FA
  useEffect(() => {
    if (pendingTwoFactorTicket()) queueMicrotask(() => setTwoFactor(true));
  }, []);

  const done = useCallback(async () => {
    await reload();
    router.replace(next);
  }, [reload, router, next]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "password") {
        await login(email, password);
        await done();
      } else {
        await requestMagic(email);
        setSent(true);
      }
    } catch (err) {
      if (err instanceof TwoFactorRequired) setTwoFactor(true);
      else setError(err instanceof Error ? err.message : t("не удалось войти"));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await loginTwoFactor(code);
      await done();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("неверный код"));
    } finally {
      setBusy(false);
    }
  }

  if (twoFactor) {
    return (
      <form className={s.form} onSubmit={submitCode} noValidate aria-label={t("код двухфакторной защиты")}>
        {error && (
          <div className={s.error} role="alert">
            {error}
          </div>
        )}
        <Input label={t("Код из приложения")} name="code" autoComplete="one-time-code" inputMode="numeric" required value={code} onChange={(e) => setCode(e.target.value)} hint={t("6 цифр из приложения-аутентификатора или один из резервных кодов")} />
        <Button type="submit" variant="primary" block disabled={busy || code.length < 6}>{t("Подтвердить")}</Button>
        <button type="button" className={s.linkBtn} onClick={() => { setTwoFactor(false); setCode(""); }}>{t("Назад")}</button>
      </form>
    );
  }

  if (sent) {
    return (
      <div className={s.form}>
        <div className={s.ok}>Если адрес {email} зарегистрирован, письмо со ссылкой для входа уже отправлено. Ссылка действует 15 минут.</div>
        <Button variant="ghost" onClick={() => setSent(false)}>{t("Назад")}</Button>
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
      <Input
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {mode === "password" && (
        <Input
          label={t("Пароль")}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      )}
      <Button type="submit" variant="primary" block disabled={busy || !email || (mode === "password" && !password)}>
        {mode === "password" ? t("Войти") : t("Прислать ссылку для входа")}
      </Button>
      <div className={s.row}>
        <button type="button" className={s.linkBtn} onClick={() => setMode(mode === "password" ? "magic" : "password")}>
          {mode === "password" ? t("Войти по ссылке из письма") : t("Войти по паролю")}
        </button>
        <Link href="/reset">{t("Забыли пароль?")}</Link>
      </div>
      <Social next={next} onDone={done} onError={(m) => (pendingTwoFactorTicket() ? setTwoFactor(true) : setError(m))} />
      <div className={s.row}>
        <span className="text-2">{t("Нет аккаунта?")}</span>
        <Link href={`/register?next=${encodeURIComponent(next)}`}>{t("Зарегистрироваться")}</Link>
      </div>
    </form>
  );
}
