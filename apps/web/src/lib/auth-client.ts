"use client";

import { DEFAULT_LOCALE, localeFromCookie, makeT } from "@/i18n";

/** Перевод клиентских сообщений по cookie языка (вне React-дерева). */
const tc = () => makeT(typeof document === "undefined" ? DEFAULT_LOCALE : (localeFromCookie(document.cookie) ?? DEFAULT_LOCALE));

/**
 * Клиентская авторизация (план 3.2): access-токен живёт в памяти вкладки,
 * refresh — в httpOnly cookie API (path /v1/auth, проксируется Next.js).
 * Cookie-подсказка `pl_auth=1` (без секретов) нужна middleware для редиректов.
 */

export type Me = {
  id: number;
  email: string;
  name: string | null;
  email_verified: boolean;
  role: string;
  locale: string;
  timezone: string;
  theme: string;
  risk: {
    deposit: string | null;
    risk_pct: string;
    exchange: string;
    market_type: string;
    default_leverage: number;
    experience: string | null;
  };
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;

export const HINT_COOKIE = "pl_auth";

/** Текущий access-токен (для WebSocket); null, если не вошли. */
export function getAccessToken(): string | null {
  return accessToken;
}

export function setHint(on: boolean) {
  document.cookie = on
    ? `${HINT_COOKIE}=1; path=/; max-age=${30 * 86400}; samesite=lax`
    : `${HINT_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export function hasHint(): boolean {
  return typeof document !== "undefined" && document.cookie.includes(`${HINT_COOKIE}=1`);
}

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown };
    if (typeof j.detail === "string") return j.detail;
    if (Array.isArray(j.detail)) {
      const first = j.detail[0] as { msg?: string; loc?: unknown[] } | undefined;
      if (first?.msg) return first.msg.replace(/^Value error, /, "");
    }
  } catch {
    /* не JSON */
  }
  return res.status === 429 ? tc()("слишком много попыток, подождите") : tc()("ошибка {status}", { status: res.status });
}

/** Получить новый access по refresh-cookie. Один одновременный запрос на вкладку. */
export function refresh(): Promise<string | null> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch("/v1/auth/refresh", { method: "POST", credentials: "include" });
        if (!res.ok) {
          accessToken = null;
          setHint(false);
          return null;
        }
        const j = (await res.json()) as { access_token: string };
        accessToken = j.access_token;
        setHint(true);
        return accessToken;
      } catch {
        return null;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/** fetch к API с токеном; при 401 — одна попытка обновить токен и повторить. */
export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { json, auth = true, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  const doFetch = async (token: string | null) => {
    if (auth && token) headers.set("authorization", `Bearer ${token}`);
    return fetch(path, {
      ...rest,
      headers,
      credentials: "include",
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  };
  let res = await doFetch(auth ? (accessToken ?? (await refresh())) : null);
  if (res.status === 401 && auth) {
    const t = await refresh();
    if (t) res = await doFetch(t);
  }
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

type TokenOut = { access_token?: string; two_factor?: boolean; ticket?: string | null };

const TICKET_KEY = "pl-2fa-ticket";

/** Вход прошёл, но включена 2FA: билет сохранён, нужен код из приложения (страница /login). */
export class TwoFactorRequired extends Error {
  constructor() {
    super(tc()("нужен код двухфакторной защиты"));
    this.name = "TwoFactorRequired";
  }
}

export function pendingTwoFactorTicket(): string | null {
  try {
    return sessionStorage.getItem(TICKET_KEY);
  } catch {
    return null;
  }
}

function accept(t: TokenOut) {
  if (t.two_factor) {
    try {
      sessionStorage.setItem(TICKET_KEY, t.ticket ?? "");
    } catch {
      /* приватный режим */
    }
    throw new TwoFactorRequired();
  }
  accessToken = t.access_token ?? null;
  setHint(true);
}

export async function login(email: string, password: string): Promise<void> {
  accept(await api<TokenOut>("/v1/auth/login", { method: "POST", json: { email, password }, auth: false }));
}

export async function loginTwoFactor(code: string): Promise<void> {
  const ticket = pendingTwoFactorTicket() ?? "";
  accept(await api<TokenOut>("/v1/auth/login/2fa", { method: "POST", json: { ticket, code }, auth: false }));
  try {
    sessionStorage.removeItem(TICKET_KEY);
  } catch {
    /* приватный режим */
  }
}

export async function register(body: {
  email: string;
  password: string;
  name?: string;
  country?: string;
  marketing_opt_in: boolean;
}): Promise<void> {
  accept(await api<TokenOut>("/v1/auth/register", { method: "POST", json: body, auth: false }));
}

export async function logout(): Promise<void> {
  try {
    await api("/v1/auth/logout", { method: "POST", auth: false });
  } finally {
    accessToken = null;
    setHint(false);
  }
}

export function requestMagic(email: string): Promise<void> {
  return api("/v1/auth/magic", { method: "POST", json: { email }, auth: false });
}

export async function consumeMagic(token: string): Promise<void> {
  accept(await api<TokenOut>("/v1/auth/magic/consume", { method: "POST", json: { token }, auth: false }));
}

export function verifyEmail(token: string): Promise<void> {
  return api("/v1/auth/verify", { method: "POST", json: { token }, auth: false });
}

export function requestReset(email: string): Promise<void> {
  return api("/v1/auth/reset", { method: "POST", json: { email }, auth: false });
}

export function confirmReset(token: string, password: string): Promise<void> {
  return api("/v1/auth/reset/confirm", { method: "POST", json: { token, password }, auth: false });
}

export async function loginGoogle(code: string, redirect_uri: string): Promise<void> {
  accept(await api<TokenOut>("/v1/auth/google", { method: "POST", json: { code, redirect_uri }, auth: false }));
}

export type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

export async function loginTelegram(u: TelegramUser): Promise<void> {
  accept(await api<TokenOut>("/v1/auth/telegram", { method: "POST", json: u, auth: false }));
}

export function getMe(): Promise<Me> {
  return api<Me>("/v1/auth/me");
}

export function patchRisk(body: Partial<Me["risk"]>): Promise<Me> {
  return api<Me>("/v1/me/risk", { method: "PATCH", json: body });
}

export function patchProfile(body: Record<string, unknown>): Promise<Me> {
  return api<Me>("/v1/me", { method: "PATCH", json: body });
}

/** Проверка пароля по утечкам (HIBP k-anonymity): наружу уходят только 5 символов SHA-1. */
export async function pwnedCount(password: string): Promise<number | null> {
  try {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
    const hex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hex.slice(0, 5)}`, {
      headers: { "Add-Padding": "true" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith(hex.slice(5)));
    return line ? Number(line.split(":")[1]) : 0;
  } catch {
    return null; // сеть недоступна — не блокируем регистрацию
  }
}
