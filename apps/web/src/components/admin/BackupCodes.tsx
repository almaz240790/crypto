"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { useT } from "@/i18n/client";
import s from "./BackupCodes.module.css";

/**
 * Резервные коды (ADR-0011): API отдаёт их один раз. Список, «скопировать», «скачать файлом» и галочка
 * «сохранил(а)» — без неё дальше не пройти. Используется при первой настройке, при выпуске новых кодов
 * и при переносе кода на другой телефон.
 */
export function BackupCodes({ codes, email, doneLabel, onDone }: { codes: string[]; email: string; doneLabel: string; onDone: () => void }) {
  const t = useT();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    const body = `PlatformSol — резервные коды для входа в админку (${email})\nКаждый код срабатывает один раз.\n\n${codes.join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "platformsol-admin-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={s.box}>
      <ul className={s.codes} data-testid="backup-codes" aria-label={t("Резервные коды")}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className={s.row}>
        <Button size="sm" onClick={() => void copy()}>
          {copied ? t("Скопировано") : t("Скопировать коды")}
        </Button>
        <Button size="sm" variant="ghost" onClick={download}>
          {t("Скачать файлом")}
        </Button>
      </div>
      <label className={s.check}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t("Я сохранил(а) коды в надёжном месте — например, в заметке в «Пароли» или на бумаге")}</span>
      </label>
      <Button className={s.done} variant="primary" block disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
