"use client";

import Link from "next/link";
import { useState } from "react";
import s from "@/components/auth/AuthCard.module.css";
import { Button } from "@/components/ui";
import { api } from "@/lib/auth-client";
import { useT } from "@/i18n/client";

/** Отписка по ссылке из письма: без входа, одним нажатием (приёмка 2.13). */
export function Unsubscribe({ token }: { token: string | null }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "busy" | "ok" | "error">(token ? "idle" : "error");
  const [msg, setMsg] = useState(token ? "" : t("в ссылке нет токена"));
  if (state === "ok") {
    return (
      <div className={s.form}>
        <div className={s.ok} role="status">{t("Вы отписаны от писем: дайджест и уведомления о сигналах выключены. Включить обратно можно в настройках.")}</div>
        <Link href="/settings">{t("Настройки уведомлений")}</Link>
      </div>
    );
  }
  return (
    <div className={s.form}>
      {state === "error" && (
        <div className={s.error} role="alert">
          {msg}
        </div>
      )}
      <p className="text-2">{t("Отписаться от всех писем PlatformSol? Письма о входе и восстановлении пароля продолжат приходить.")}</p>
      <Button
        variant="primary"
        block
        disabled={!token || state === "busy"}
        onClick={async () => {
          setState("busy");
          try {
            await api("/v1/notifications/unsubscribe", { method: "POST", json: { token }, auth: false });
            setState("ok");
          } catch (e) {
            setState("error");
            setMsg(e instanceof Error ? e.message : t("не удалось отписаться"));
          }
        }}
      >{t("Отписаться")}</Button>
    </div>
  );
}
