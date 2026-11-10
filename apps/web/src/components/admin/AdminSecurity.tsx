"use client";

import { useState, type FormEvent } from "react";
import { Button, Input, Panel } from "@/components/ui";
import { useT } from "@/i18n/client";
import { adminNewBackupCodes, adminRotateConfirm, adminRotateStart, saveBackup, type AdminSetup } from "@/lib/admin-auth";
import { codeReady, normalizeCode } from "@/lib/adminGate";
import { useAdminMe, useAdminReload } from "./AdminShell";
import { BackupCodes } from "./BackupCodes";
import { SetupQr } from "./SetupQr";
import s from "./AdminSecurity.module.css";

const sixDigits = (v: string) => /^\d{6}$/.test(normalizeCode(v));
const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/**
 * «Защита входа» (ADR-0011): выпустить новые резервные коды и перенести код на другой телефон — без выключения
 * защиты и без похода на сайт. Каждое действие подтверждается кодом из приложения.
 */
export function AdminSecurity() {
  const t = useT();
  const me = useAdminMe();
  const reload = useAdminReload();
  const [busy, setBusy] = useState(false);
  // новые резервные коды
  const [codeNew, setCodeNew] = useState("");
  const [errNew, setErrNew] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  // перенос на другой телефон
  const [codeOld, setCodeOld] = useState("");
  const [codePhone, setCodePhone] = useState("");
  const [errMove, setErrMove] = useState<string | null>(null);
  const [move, setMove] = useState<(AdminSetup & { pending: string }) | null>(null);
  const [moved, setMoved] = useState<string[] | null>(null);

  async function guard(setErr: (v: string | null) => void, fn: () => Promise<void>) {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(message(e, t("Не получилось. Попробуйте ещё раз.")));
    } finally {
      setBusy(false);
    }
  }

  /** Коды показаны один раз: до галочки «сохранил(а)» лежат во вкладке и переживают перезагрузку. */
  function show(list: string[], set: (v: string[] | null) => void) {
    saveBackup({ codes: list, email: me.email });
    set(list);
    reload();
  }

  function saved(set: (v: string[] | null) => void) {
    saveBackup(null);
    set(null);
  }

  const issue = (e: FormEvent) => {
    e.preventDefault();
    void guard(setErrNew, async () => {
      const r = await adminNewBackupCodes(normalizeCode(codeNew));
      setCodeNew("");
      show(r.backup_codes, setCodes);
    });
  };

  const startMove = (e: FormEvent) => {
    e.preventDefault();
    void guard(setErrMove, async () => {
      setMove(await adminRotateStart(normalizeCode(codeOld)));
      setCodeOld("");
      setCodePhone("");
    });
  };

  const confirmMove = (e: FormEvent) => {
    e.preventDefault();
    if (!move) return;
    void guard(setErrMove, async () => {
      const r = await adminRotateConfirm(move.pending, normalizeCode(codePhone));
      setMove(null);
      setCodePhone("");
      show(r.backup_codes, setMoved);
    });
  };

  return (
    <div className={s.grid} data-testid="admin-security">
      <Panel title={t("Резервные коды")}>
        {codes ? (
          <div className={s.form}>
            <p className={s.ok} role="status">
              {t("Новые резервные коды выпущены, старые больше не работают. Сохраните их сейчас — второй раз мы их не покажем.")}
            </p>
            <BackupCodes codes={codes} email={me.email} doneLabel={t("Готово, коды сохранены")} onDone={() => saved(setCodes)} />
          </div>
        ) : (
          <form className={s.form} onSubmit={issue} noValidate aria-label={t("Новые резервные коды")}>
            <p className={s.text}>
              {t("Осталось кодов:")} <span className={s.count} data-testid="backup-left">{me.backup_codes_left}</span> {t("из 10")}
            </p>
            <p className={s.muted}>{t("Резервный код заменяет код из приложения, когда телефона нет под рукой. Каждый срабатывает один раз. Потеряли или почти закончились — выпустите новые: старые сразу перестанут работать.")}</p>
            {errNew && (
              <p className={s.error} role="alert">
                {errNew}
              </p>
            )}
            <Input label={t("Код из приложения")} name="code-new" autoComplete="one-time-code" inputMode="numeric" value={codeNew} onChange={(e) => setCodeNew(e.target.value)} />
            <Button type="submit" variant="primary" disabled={busy || !sixDigits(codeNew)}>
              {t("Выпустить новые коды")}
            </Button>
          </form>
        )}
      </Panel>

      <Panel title={t("Новый телефон")}>
        {moved ? (
          <div className={s.form}>
            <p className={s.ok} role="status">
              {t("Готово: код теперь на новом телефоне. Код на старом телефоне и старые резервные коды больше не работают. Сохраните новые резервные коды.")}
            </p>
            <BackupCodes codes={moved} email={me.email} doneLabel={t("Готово, коды сохранены")} onDone={() => saved(setMoved)} />
          </div>
        ) : move ? (
          <form className={s.form} onSubmit={confirmMove} noValidate aria-label={t("Перенос кода: новый телефон")}>
            <p className={s.text}>{t("На новом телефоне откройте «Пароли» → «Коды проверки» → «+» (или Google Authenticator) и наведите камеру на QR-код. Затем введите 6 цифр, которые покажет новый телефон.")}</p>
            <SetupQr setup={move} />
            {errMove && (
              <p className={s.error} role="alert">
                {errMove}
              </p>
            )}
            <Input label={t("Код с нового телефона")} name="code-phone" autoComplete="one-time-code" inputMode="numeric" value={codePhone} onChange={(e) => setCodePhone(e.target.value)} />
            <div className={s.row}>
              <Button type="submit" variant="primary" disabled={busy || !sixDigits(codePhone)}>
                {t("Перенести код")}
              </Button>
              <Button variant="ghost" onClick={() => setMove(null)}>
                {t("Отмена")}
              </Button>
            </div>
            <p className={s.muted}>{t("Пока перенос не подтверждён, ничего не меняется: старый телефон продолжает работать.")}</p>
          </form>
        ) : (
          <form className={s.form} onSubmit={startMove} noValidate aria-label={t("Перенос кода: подтверждение")}>
            <p className={s.muted}>{t("Меняете телефон — перенесите код заранее, пока старый под рукой. Защита при этом не выключается. Старого телефона уже нет — подойдёт резервный код.")}</p>
            {errMove && (
              <p className={s.error} role="alert">
                {errMove}
              </p>
            )}
            <Input label={t("Код со старого телефона или резервный код")} name="code-old" autoComplete="one-time-code" inputMode="text" autoCapitalize="characters" value={codeOld} onChange={(e) => setCodeOld(e.target.value)} />
            <Button type="submit" disabled={busy || !codeReady(codeOld)}>
              {t("Показать QR-код для нового телефона")}
            </Button>
            <p className={s.muted}>{t("После переноса другие открытые сеансы админки закроются, этот останется.")}</p>
          </form>
        )}
      </Panel>

      <Panel title={t("Если телефон потерян")}>
        <ol className={s.list}>
          <li>{t("Есть резервный код — войдите с ним вместо кода из приложения и перенесите код на новый телефон (блок выше).")}</li>
          <li>{t("Нет ни телефона, ни резервных кодов — напишите разработчику: защиту сбрасывают на сервере, после чего вход идёт по ссылке из письма и код настраивается заново.")}</li>
        </ol>
      </Panel>
    </div>
  );
}
