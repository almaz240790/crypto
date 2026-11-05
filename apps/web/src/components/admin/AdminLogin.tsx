"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input } from "@/components/ui";
import { Logo } from "@/components/site/Logo";
import { useT } from "@/i18n/client";
import { ApiError } from "@/lib/auth-client";
import {
  adminConsumeLink,
  adminLogin,
  adminMagic,
  adminSetupConfirm,
  adminSetupStart,
  adminVerify,
  getAdminConfig,
  loadPending,
  savePending,
  type AdminConfig,
  type AdminSetup,
  type PendingLogin,
} from "@/lib/admin-auth";
import { codeReady, groupSecret, normalizeCode } from "@/lib/adminGate";
import { QrCode } from "./QrCode";
import s from "./AdminLogin.module.css";

type View = "password" | "magic" | "magicSent" | "setup" | "code" | "backup";

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
/** 410 — билет сгорел или устарел: только заново с первого шага. */
const isGone = (e: unknown) => e instanceof ApiError && e.status === 410;
const isWrongStep = (e: unknown) => e instanceof ApiError && e.status === 409;

/**
 * Вход в админку (ADR-0011): email и пароль (или ссылка на почту) → код из приложения на телефоне.
 * Первый вход: QR-код для «Пароли» на iPhone / Google Authenticator, первый код, резервные коды.
 */
export function AdminLogin({ next, link, ended }: { next: string; link: string | null; ended: boolean }) {
  const t = useT();
  const router = useRouter();
  const [view, setView] = useState<View>("password");
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(ended ? t("Сеанс админки закончился: час без действий или 8 часов с входа. Войдите снова.") : null);
  const [backup, setBackup] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const restart = useCallback((why: string | null = null) => {
    savePending(null);
    setPending(null);
    setCode("");
    setPassword("");
    setView("password");
    setError(why);
  }, []);

  /** Первый фактор пройден: запомнить вкладкой и показать второй шаг (настройка — с QR-кодом). */
  const toSecondStep = useCallback(async (p: PendingLogin) => {
    let n = p;
    if (p.step === "setup" && !p.setup) {
      try {
        n = { ...p, setup: await adminSetupStart(p.ticket) };
      } catch (e) {
        if (isWrongStep(e)) n = { ...p, step: "code" };
        else throw e;
      }
    }
    savePending(n);
    setPending(n);
    setEmail(n.email);
    setCode("");
    setView(n.step === "setup" ? "setup" : "code");
  }, []);

  // один раз при открытии: ссылка из письма → сразу второй шаг; иначе — незаконченный вход этой вкладки
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    getAdminConfig()
      .then(setConfig)
      .catch(() => setConfig({ mail: false, idle_minutes: 60, session_hours: 8 }));
    queueMicrotask(() => {
      if (link) {
        router.replace("/admin/login");
        setBusy(true);
        adminConsumeLink(link)
          .then(toSecondStep)
          .catch((e) => restart(message(e, t("Ссылка недействительна или устарела. Запросите новую."))))
          .finally(() => setBusy(false));
        return;
      }
      const p = loadPending();
      if (p) void toSecondStep(p).catch(() => restart());
    });
  }, [link, restart, router, t, toSecondStep]);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (isGone(e)) restart(message(e, t("Начните вход заново.")));
      else setError(message(e, t("Не получилось. Попробуйте ещё раз.")));
    } finally {
      setBusy(false);
    }
  }

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => toSecondStep(await adminLogin(email, password)));
  };

  const submitMagic = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await adminMagic(email);
      setView("magicSent");
    });
  };

  const submitSetup = (e: FormEvent) => {
    e.preventDefault();
    if (!pending) return;
    void run(async () => {
      const me = await adminSetupConfirm(pending.ticket, normalizeCode(code));
      savePending(null);
      setBackup(me.backup_codes);
      setView("backup");
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (!pending) return;
    void run(async () => {
      try {
        await adminVerify(pending.ticket, normalizeCode(code));
      } catch (err) {
        if (isWrongStep(err)) return toSecondStep({ ...pending, step: "setup" });
        throw err;
      }
      savePending(null);
      router.replace(next);
    });
  };

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2500);
    } catch {
      setCopied(null);
    }
  }

  function download() {
    const body = `PlatformSol — резервные коды для входа в админку (${email})\nКаждый код срабатывает один раз.\n\n${backup.join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "platformsol-admin-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  const setup: AdminSetup | undefined = pending?.setup;
  const alerts = (
    <>
      {info && (
        <p className={s.info} role="status">
          {info}
        </p>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </>
  );

  let body;
  if (view === "password") {
    body = (
      <form className={s.form} onSubmit={submitPassword} noValidate aria-label={t("Вход в админку")}>
        <p className={s.step}>{t("Шаг 1 из 2 · пароль")}</p>
        <h1 className={s.title}>{t("Вход в админку")}</h1>
        <p className={s.lead}>{t("Только для владельца и администраторов. Сначала email и пароль, затем 6-значный код из приложения на телефоне.")}</p>
        {alerts}
        <Input label="Email" type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input label={t("Пароль")} type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" block disabled={busy || !email || !password}>
          {t("Продолжить")}
        </Button>
        {config?.mail ? (
          <button type="button" className={s.link} onClick={() => { setError(null); setView("magic"); }}>
            {t("Нет пароля? Войти по ссылке на почту")}
          </button>
        ) : config ? (
          <p className={s.note}>{t("Вход по ссылке на почту сейчас недоступен: на сервере не настроена отправка писем. Войдите по паролю.")}</p>
        ) : null}
      </form>
    );
  } else if (view === "magic") {
    body = (
      <form className={s.form} onSubmit={submitMagic} noValidate aria-label={t("Вход по ссылке на почту")}>
        <p className={s.step}>{t("Шаг 1 из 2 · ссылка на почту")}</p>
        <h1 className={s.title}>{t("Вход по ссылке на почту")}</h1>
        <p className={s.lead}>{t("Для аккаунтов без пароля (вход через Google или по ссылке). Пришлём письмо со ссылкой — она действует 10 минут и срабатывает один раз.")}</p>
        {alerts}
        <Input label="Email" type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button type="submit" variant="primary" block disabled={busy || !email}>
          {t("Прислать ссылку")}
        </Button>
        <button type="button" className={s.link} onClick={() => restart()}>
          {t("Назад к паролю")}
        </button>
      </form>
    );
  } else if (view === "magicSent") {
    body = (
      <div className={s.form}>
        <p className={s.step}>{t("Шаг 1 из 2 · ссылка на почту")}</p>
        <h1 className={s.title}>{t("Проверьте почту")}</h1>
        <p className={s.ok} role="status">
          {t("Если у адреса {email} есть доступ к админке, письмо со ссылкой уже отправлено. Откройте ссылку в течение 10 минут — дальше понадобится код из приложения.", { email })}
        </p>
        <button type="button" className={s.link} onClick={() => restart()}>
          {t("Назад к паролю")}
        </button>
      </div>
    );
  } else if (view === "setup") {
    body = (
      <form className={s.form} onSubmit={submitSetup} noValidate aria-label={t("Настройка кода для входа")}>
        <p className={s.step}>{t("Шаг 2 из 2 · настройка кода (один раз)")}</p>
        <h1 className={s.title}>{t("Защитите вход кодом из телефона")}</h1>
        <p className={s.lead}>{t("Для админки нужен второй ключ — 6 цифр из приложения на телефоне. Код меняется каждые 30 секунд, поэтому украденного пароля мало.")}</p>
        <ol className={s.steps}>
          <li>
            {t("Откройте на iPhone приложение «Пароли» → «Коды проверки» → «+». Подойдёт и Google Authenticator.")}
          </li>
          <li>
            {t("Наведите камеру телефона на QR-код. Если эта страница открыта на самом телефоне — нажмите «Добавить код на этом устройстве».")}
            {setup ? (
              <div className={s.qrBox}>
                <div className={s.qr} data-testid="admin-qr">
                  <QrCode size={setup.qr.size} path={setup.qr.path} label={t("QR-код для приложения-аутентификатора")} />
                </div>
                <a className={s.appLink} href={setup.otpauth_url}>
                  {t("Добавить код на этом устройстве")}
                </a>
                <button type="button" className={s.link} aria-expanded={showKey} onClick={() => setShowKey(!showKey)}>
                  {showKey ? t("Скрыть ключ") : t("Не получается? Ввести ключ вручную")}
                </button>
                {showKey && (
                  <div className={s.key}>
                    <code data-testid="admin-secret">{groupSecret(setup.secret)}</code>
                    <Button size="sm" variant="ghost" onClick={() => void copy(setup.secret, "key")}>
                      {copied === "key" ? t("Скопировано") : t("Скопировать ключ")}
                    </Button>
                    <span className={s.hint}>{t("Имя: PlatformSol, тип: по времени (TOTP).")}</span>
                  </div>
                )}
              </div>
            ) : (
              <p className={s.hint}>{t("Готовим QR-код…")}</p>
            )}
          </li>
          <li>{t("Введите 6 цифр, которые показало приложение для PlatformSol.")}</li>
        </ol>
        {/* ошибка — у поля кода: на телефоне верх формы после нажатия уже не виден */}
        {alerts}
        <Input label={t("Код из приложения")} name="code" autoComplete="one-time-code" inputMode="numeric" required value={code} onChange={(e) => setCode(e.target.value)} />
        <Button type="submit" variant="primary" block disabled={busy || !/^\d{6}$/.test(normalizeCode(code))}>
          {t("Включить защиту и войти")}
        </Button>
        <button type="button" className={s.link} onClick={() => restart()}>
          {t("Начать заново")}
        </button>
      </form>
    );
  } else if (view === "code") {
    body = (
      <form className={s.form} onSubmit={submitCode} noValidate aria-label={t("Код из приложения")}>
        <p className={s.step}>{t("Шаг 2 из 2 · код")}</p>
        <h1 className={s.title}>{t("Код из приложения")}</h1>
        <p className={s.lead}>{t("Откройте «Пароли» → «Коды проверки» (или Google Authenticator) и введите 6 цифр для PlatformSol. Телефона нет под рукой — введите один из резервных кодов.")}</p>
        {alerts}
        <Input label={t("Код")} name="code" autoComplete="one-time-code" inputMode="text" autoCapitalize="characters" required value={code} onChange={(e) => setCode(e.target.value)} hint={pending ? t("Вход для {email}", { email: pending.email }) : undefined} />
        <Button type="submit" variant="primary" block disabled={busy || !codeReady(code)}>
          {t("Войти в админку")}
        </Button>
        <button type="button" className={s.link} onClick={() => restart()}>
          {t("Начать заново")}
        </button>
      </form>
    );
  } else {
    body = (
      <div className={s.form}>
        <p className={s.step}>{t("Готово · защита включена")}</p>
        <h1 className={s.title}>{t("Сохраните резервные коды")}</h1>
        <p className={s.lead}>{t("Если телефон потеряется, войти можно одним из этих кодов вместо кода из приложения. Каждый код срабатывает один раз. Больше мы их не покажем.")}</p>
        <ul className={s.codes} data-testid="backup-codes" aria-label={t("Резервные коды")}>
          {backup.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className={s.row}>
          <Button size="sm" onClick={() => void copy(backup.join("\n"), "codes")}>
            {copied === "codes" ? t("Скопировано") : t("Скопировать коды")}
          </Button>
          <Button size="sm" variant="ghost" onClick={download}>
            {t("Скачать файлом")}
          </Button>
        </div>
        <label className={s.check}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>{t("Я сохранил(а) коды в надёжном месте — например, в заметке в «Пароли» или на бумаге")}</span>
        </label>
        <Button variant="primary" block disabled={!saved} onClick={() => router.replace(next)}>
          {t("Перейти в админку")}
        </Button>
      </div>
    );
  }

  return (
    <main className={s.page}>
      <div className={s.top}>
        <Link href="/" className={s.brand} aria-label="PlatformSol">
          <Logo />
        </Link>
        <span className={s.badge}>{t("Админка")}</span>
      </div>
      <section className={s.card} aria-busy={busy}>
        {body}
      </section>
      <p className={s.foot}>{t("Вход в админку отдельный: выход из неё не выводит с сайта, и наоборот.")}</p>
    </main>
  );
}
