"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { useT } from "@/i18n/client";
import type { AdminSetup } from "@/lib/admin-auth";
import { groupSecret } from "@/lib/adminGate";
import { QrCode } from "./QrCode";
import s from "./AdminLogin.module.css";

/**
 * QR-код для приложения-аутентификатора (ADR-0011): сам код, кнопка «Добавить код на этом устройстве»
 * (на телефоне она выше QR — сканировать свой экран нечем) и ключ для ручного ввода. Используется при
 * первой настройке и при переносе кода на другой телефон.
 */
export function SetupQr({ setup }: { setup: AdminSetup }) {
  const t = useT();
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
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
          <Button size="sm" variant="ghost" onClick={() => void copy()}>
            {copied ? t("Скопировано") : t("Скопировать ключ")}
          </Button>
          <span className={s.hint}>{t("Имя: PlatformSol, тип: по времени (TOTP).")}</span>
        </div>
      )}
    </div>
  );
}
