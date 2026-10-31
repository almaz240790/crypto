"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { DISCLAIMER } from "@/components/site";
import { Button, Input, Select } from "@/components/ui";
import { pwnedCount, register } from "@/lib/auth-client";
import { countryOptions } from "@/lib/countries";
import { useAuth } from "./AuthProvider";
import s from "./AuthCard.module.css";
import { Social } from "./Social";
import { useLocale } from "@/i18n/client";

const MIN = 10;

export function RegisterForm({ next }: { next: string }) {
  const { locale, t } = useLocale();
  const router = useRouter();
  const { reload } = useAuth();
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [terms, setTerms] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);

  const done = useCallback(async () => {
    await reload();
    router.replace(next);
  }, [reload, router, next]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN) {
      setPwError(t("минимум {n} символов", { n: MIN }));
      return;
    }
    setBusy(true);
    try {
      const n = await pwnedCount(password);
      if (n && n > 0) {
        setPwError(t("этот пароль встречается в утечках ({n} раз), выберите другой", { n: n.toLocaleString(locale) }));
        return;
      }
      await register({
        email,
        password,
        name: name.trim() || undefined,
        country: country || undefined,
        marketing_opt_in: marketing,
      });
      await done();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("не удалось зарегистрироваться"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={s.form} onSubmit={submit} noValidate>
      {error && (
        <div className={s.error} role="alert">
          {error}
        </div>
      )}
      <Input label="Email" type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <Input
        label={t("Пароль")}
        type="password"
        name="password"
        autoComplete="new-password"
        required
        minLength={MIN}
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setPwError(null);
        }}
        error={pwError}
        hint={t("не короче {n} символов; проверяется по базе утечек", { n: MIN })}
      />
      <Input label={t("Имя (необязательно)")} name="name" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      <Select label={t("Страна")} name="country" value={country} onChange={(e) => setCountry(e.target.value)} hint={t("нужна для соблюдения ограничений по юрисдикциям")}>
        <option value="">{t("— не указывать —")}</option>
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </Select>
      <label className={s.check}>
        <input type="checkbox" name="terms" checked={terms} onChange={(e) => setTerms(e.target.checked)} required />
        <span>
          {t("Я принимаю условия использования и понимаю:")} {t(DISCLAIMER)}
        </span>
      </label>
      <label className={s.check}>
        <input type="checkbox" name="marketing" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
        <span>{t("Получать письма о новых функциях (не чаще раза в месяц)")}</span>
      </label>
      <Button type="submit" variant="primary" block disabled={busy || !email || !password || !terms}>
        {busy ? t("Проверяем…") : t("Создать аккаунт")}
      </Button>
      <Social next={next} onDone={done} onError={setError} />
      <div className={s.row}>
        <span className="text-2">{t("Уже есть аккаунт?")}</span>
        <Link href={`/login?next=${encodeURIComponent(next)}`}>{t("Войти")}</Link>
      </div>
    </form>
  );
}
