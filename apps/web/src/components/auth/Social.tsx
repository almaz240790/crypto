"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui";
import { loginTelegram, type TelegramUser } from "@/lib/auth-client";
import s from "./AuthCard.module.css";

const GOOGLE_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const TG_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT;

export function googleAuthUrl(next: string): string {
  const redirect = `${window.location.origin}/auth/google`;
  const p = new URLSearchParams({
    client_id: GOOGLE_ID ?? "",
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid email profile",
    state: next,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

declare global {
  interface Window {
    onTelegramAuth?: (u: TelegramUser) => void;
  }
}

/** Кнопки входа через Google и Telegram. Показываются только если провайдер настроен. */
export function Social({ next, onDone, onError }: { next: string; onDone: () => void; onError: (m: string) => void }) {
  const tgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!TG_BOT || !tgRef.current || tgRef.current.childElementCount) return;
    window.onTelegramAuth = async (u) => {
      try {
        await loginTelegram(u);
        onDone();
      } catch (e) {
        onError(e instanceof Error ? e.message : "ошибка входа через Telegram");
      }
    };
    const sc = document.createElement("script");
    sc.src = "https://telegram.org/js/telegram-widget.js?22";
    sc.async = true;
    sc.setAttribute("data-telegram-login", TG_BOT);
    sc.setAttribute("data-size", "medium");
    sc.setAttribute("data-radius", "2");
    sc.setAttribute("data-onauth", "onTelegramAuth(user)");
    sc.setAttribute("data-request-access", "write");
    tgRef.current.appendChild(sc);
  }, [onDone, onError]);

  if (!GOOGLE_ID && !TG_BOT) return null;
  return (
    <>
      <div className={s.sep}>или</div>
      <div className={s.social}>
        {GOOGLE_ID && (
          <Button block onClick={() => (window.location.href = googleAuthUrl(next))}>
            Войти через Google
          </Button>
        )}
        {TG_BOT && <div ref={tgRef} />}
      </div>
    </>
  );
}
