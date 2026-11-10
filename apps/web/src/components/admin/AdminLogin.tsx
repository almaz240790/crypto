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
  getAdminMe,
  getGraceMe,
  loadBackup,
  loadPending,
  saveBackup,
  savePending,
  setAdminHint,
  type AdminConfig,
  type AdminMailStep,
  type AdminMe,
  type AdminSetup,
  type PendingLogin,
} from "@/lib/admin-auth";
import { codeReady, ENDED_TEXT, normalizeCode, type EndedReason } from "@/lib/adminGate";
import { BackupCodes } from "./BackupCodes";
import { SetupQr } from "./SetupQr";
import s from "./AdminLogin.module.css";

type View = "check" | "password" | "magic" | "magicSent" | "mail" | "setup" | "code" | "backup";

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
/** 410 — билет сгорел или устарел: только заново с первого шага. */
const isGone = (e: unknown) => e instanceof ApiError && e.status === 410;
const isWrongStep = (e: unknown) => e instanceof ApiError && e.status === 409;

/**
 * Вход в админку (ADR-0011): email и пароль (или ссылка на почту) → код из приложения на телефоне.
 * Первый вход: подтверждение почты ссылкой из письма, QR-код для «Пароли» на iPhone / Google Authenticator,
 * первый код, резервные коды. `live` — в браузере есть подсказка открытого сеанса: сначала проверяем его
 * и ведём сразу в админку (закладка на /admin/login, ссылка из письма о тикете).
 * `setup` — пришли из плашки переходного режима («Настроить»): тот же вход, но с объяснением, что это настройка
 * защиты. Если владелец в переходном режиме (вошёл на сайт, кода нет), а письмо не пришло, шаг «Проверьте почту»
 * напоминает, что админка пока открыта по адресу /admin, и даёт отправить письмо ещё раз. Настроить код без
 * письма нельзя.
 */
export function AdminLogin({ next, link, ended, live, setup: setupMode = false }: { next: string; link: string | null; ended: EndedReason | null; live: boolean; setup?: boolean }) {
  const t = useT();
  const router = useRouter();
  const [view, setView] = useState<View>(live ? "check" : "password");
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [mailStep, setMailStep] = useState<AdminMailStep | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(ended ? t(ENDED_TEXT[ended]) : null);
  const [backup, setBackup] = useState<string[]>([]);
  /** Переходный режим: вошли на сайт админом или владельцем, код ещё не настроен (админка открыта по входу на сайт). */
  const [grace, setGrace] = useState<AdminMe | null>(null);

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
    if (setupMode)
      void getGraceMe().then((g) => {
        setGrace(g);
        if (g) setEmail((e) => e || g.email);
      });
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
      // резервные коды показаны, но ещё не подтверждены сохранёнными — после перезагрузки снова они
      const stash = loadBackup();
      if (stash) {
        setBackup(stash.codes);
        setEmail(stash.email);
        setView("backup");
        return;
      }
      const p = loadPending();
      if (p) {
        void toSecondStep(p).catch(() => restart());
        return;
      }
      // сеанс уже открыт (закладка, ссылка из письма) — сразу в админку, без повторного входа
      if (live)
        getAdminMe()
          .then(() => {
            setAdminHint(true);
            router.replace(next);
          })
          .catch(() => {
            setAdminHint(false);
            setView("password");
          });
    });
  }, [link, live, next, restart, router, setupMode, t, toSecondStep]);

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
    void run(async () => {
      const r = await adminLogin(email, password);
      if (r.step !== "mail") return toSecondStep(r);
      // пароль верный, но код ещё не настроен: настройка — только по ссылке (письмо или сервер)
      setPassword("");
      setMailStep(r);
      setView("mail");
      // вошли на сайт этим же аккаунтом — админка пока открыта и без письма (переходный режим)
      const g = await getGraceMe();
      setGrace(g && g.email.toLowerCase() === r.email.toLowerCase() ? g : null);
    });
  };

  /** Письмо со ссылкой ещё раз (те же лимиты, что у входа по ссылке: 3 письма в час на адрес). */
  const resend = () => {
    if (!mailStep) return;
    void run(async () => {
      await adminMagic(mailStep.email);
      setInfo(t("Отправили новое письмо на {email}. Откройте ссылку из самого свежего письма — она действует 10 минут.", { email: mailStep.email }));
    });
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
      saveBackup({ codes: me.backup_codes, email: me.email }); // до галочки «сохранил(а)» — переживут перезагрузку
      savePending(null);
      setEmail(me.email);
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
        // защиту кодом успели выключить: первая настройка — только по ссылке, начинаем с первого шага
        if (isWrongStep(err)) return restart(message(err, t("Начните вход заново.")));
        throw err;
      }
      savePending(null);
      router.replace(next);
    });
  };

  function backupSaved() {
    saveBackup(null);
    router.replace(next);
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
  if (view === "check") {
    body = (
      <div className={s.form}>
        <h1 className={s.title}>{t("Вход в админку")}</h1>
        <p className={s.lead} role="status">
          {t("Проверяем, открыт ли сеанс админки…")}
        </p>
      </div>
    );
  } else if (view === "mail" && mailStep) {
    body = (
      <div className={s.form}>
        <p className={s.step}>{t("Шаг 1 из 2 · подтверждение почты")}</p>
        <h1 className={s.title}>{mailStep.sent ? t("Проверьте почту") : t("Нужна ссылка для первой настройки")}</h1>
        {mailStep.sent ? (
          <p className={s.ok} role="status">
            {t("Пароль верный. Код из телефона для админки ещё не настроен — первую настройку открывает ссылка из письма. Мы отправили её на {email}: она действует 10 минут и срабатывает один раз. Откройте ссылку на этом устройстве — появится QR-код.", { email: mailStep.email })}
          </p>
        ) : mailStep.mail ? (
          <p className={s.info} role="status">
            {t("Пароль верный. Письмо со ссылкой на {email} уже отправляли недавно — откройте последнее письмо. Новое можно запросить через час.", { email: mailStep.email })}
          </p>
        ) : (
          <p className={s.info} role="status">
            {t("Пароль верный. Код из телефона для админки ещё не настроен, а отправка писем на сервере выключена. Первую настройку открывает одноразовая ссылка с сервера — попросите её у разработчика (команда scripts/admin_link.py). Ссылка действует 30 минут.")}
          </p>
        )}
        <p className={s.note}>{t("Зачем это: одного пароля мало, чтобы привязать к админке приложение с кодами. Так украденный пароль не откроет админку.")}</p>
        {grace && (
          <div className={s.grace} data-testid="admin-grace-mail">
            <p className={s.note}>{t("Письмо не пришло? Проверьте папку «Спам». Админка пока открыта по адресу /admin — до настройки защиты туда пускает вход на сайт.")}</p>
            {alerts}
            <div className={s.actions}>
              {mailStep.mail && (
                <Button type="button" disabled={busy} onClick={resend}>
                  {t("Отправить письмо ещё раз")}
                </Button>
              )}
              <Button variant="ghost" href="/admin">
                {t("Открыть админку")}
              </Button>
            </div>
          </div>
        )}
        <button type="button" className={s.link} onClick={() => restart()}>
          {t("Назад к паролю")}
        </button>
      </div>
    );
  } else if (view === "password") {
    body = (
      <form className={s.form} onSubmit={submitPassword} noValidate aria-label={setupMode ? t("Настройка защиты входа") : t("Вход в админку")}>
        <p className={s.step}>{t("Шаг 1 из 2 · пароль")}</p>
        {setupMode ? (
          <>
            <h1 className={s.title}>{t("Настройка защиты входа")}</h1>
            <p className={s.lead}>{t("Защитите админку кодом из телефона — это одна минута. Введите email и пароль от сайта: мы пришлём письмо со ссылкой, по ней откроется QR-код для приложения «Пароли» или Google Authenticator.")}</p>
          </>
        ) : (
          <>
            <h1 className={s.title}>{t("Вход в админку")}</h1>
            <p className={s.lead}>{t("Только для владельца и администраторов. Сначала email и пароль, затем 6-значный код из приложения на телефоне.")}</p>
          </>
        )}
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
        {grace && (
          <Link href="/admin" className={s.link}>
            {t("Вернуться в админку")}
          </Link>
        )}
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
              <SetupQr setup={setup} />
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
        <p className={s.lead}>{t("Если телефон потеряется, войти можно одним из этих кодов вместо кода из приложения. Каждый код срабатывает один раз. После перехода в админку мы их больше не покажем — но там, в разделе «Защита входа», можно выпустить новые.")}</p>
        <BackupCodes codes={backup} email={email} doneLabel={t("Перейти в админку")} onDone={backupSaved} />
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
