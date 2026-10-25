"use client";

import Link from "next/link";
import { useState } from "react";
import s from "@/components/auth/AuthCard.module.css";
import { Button } from "@/components/ui";
import { api } from "@/lib/auth-client";

/** Отписка по ссылке из письма: без входа, одним нажатием (приёмка 2.13). */
export function Unsubscribe({ token }: { token: string | null }) {
  const [state, setState] = useState<"idle" | "busy" | "ok" | "error">(token ? "idle" : "error");
  const [msg, setMsg] = useState(token ? "" : "в ссылке нет токена");
  if (state === "ok") {
    return (
      <div className={s.form}>
        <div className={s.ok} role="status">
          Вы отписаны от писем: дайджест и уведомления о сигналах выключены. Включить обратно можно в настройках.
        </div>
        <Link href="/settings">Настройки уведомлений</Link>
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
      <p className="text-2">Отписаться от всех писем Platform? Письма о входе и восстановлении пароля продолжат приходить.</p>
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
            setMsg(e instanceof Error ? e.message : "не удалось отписаться");
          }
        }}
      >
        Отписаться
      </Button>
    </div>
  );
}
