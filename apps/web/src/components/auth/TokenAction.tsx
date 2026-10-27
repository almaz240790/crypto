"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { TwoFactorRequired, consumeMagic, verifyEmail } from "@/lib/auth-client";
import { useAuth } from "./AuthProvider";
import s from "./AuthCard.module.css";
import { useT } from "@/i18n/client";

/** Страницы по ссылке из письма: /verify?token и /magic?token. Выполняется один раз. */
export function TokenAction({ kind, token }: { kind: "verify" | "magic"; token: string | null }) {
  const t = useT();
  const router = useRouter();
  const { reload } = useAuth();
  const ran = useRef(false);
  const [state, setState] = useState<"busy" | "ok" | "error">(token ? "busy" : "error");
  const [msg, setMsg] = useState(token ? "" : t("в ссылке нет токена"));

  useEffect(() => {
    if (ran.current || !token) return;
    ran.current = true;
    (async () => {
      try {
        if (kind === "verify") {
          await verifyEmail(token);
          setState("ok");
          setMsg(t("Email подтверждён."));
        } else {
          await consumeMagic(token);
          await reload();
          router.replace("/signals");
        }
      } catch (e) {
        if (e instanceof TwoFactorRequired) {
          router.replace("/login");
          return;
        }
        setState("error");
        setMsg(e instanceof Error ? e.message : t("ссылка недействительна"));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t меняется только с языком, вход повторять нельзя
  }, [kind, token, reload, router]);

  if (state === "busy") return <p className="text-2">{t("Проверяем ссылку…")}</p>;
  return (
    <div className={s.form}>
      <div className={state === "ok" ? s.ok : s.error} role="status">
        {msg}
      </div>
      <div className={s.row}>
        <Button href="/signals">{t("К сигналам")}</Button>
        {state === "error" && <Link href="/login">{t("Войти заново")}</Link>}
      </div>
    </div>
  );
}
