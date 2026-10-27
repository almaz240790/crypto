"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { TwoFactorRequired, loginGoogle } from "@/lib/auth-client";
import { useAuth } from "./AuthProvider";
import s from "./AuthCard.module.css";
import { useT } from "@/i18n/client";

export function GoogleCallback({ code, state, error }: { code: string | null; state: string | null; error: string | null }) {
  const t = useT();
  const router = useRouter();
  const { reload } = useAuth();
  const ran = useRef(false);
  const [msg, setMsg] = useState<string | null>(error ? `Google: ${error}` : null);

  useEffect(() => {
    if (ran.current || !code) return;
    ran.current = true;
    (async () => {
      try {
        await loginGoogle(code, `${window.location.origin}/auth/google`);
        await reload();
        const next = state && state.startsWith("/") && !state.startsWith("//") ? state : "/signals";
        router.replace(next);
      } catch (e) {
        if (e instanceof TwoFactorRequired) {
          router.replace("/login");
          return;
        }
        setMsg(e instanceof Error ? e.message : t("не удалось войти через Google"));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t меняется только с языком, вход повторять нельзя
  }, [code, state, reload, router]);

  if (!msg) return <p className="text-2">{t("Завершаем вход через Google…")}</p>;
  return (
    <div className={s.form}>
      <div className={s.error} role="alert">
        {msg}
      </div>
      <Link href="/login">{t("Войти другим способом")}</Link>
    </div>
  );
}
