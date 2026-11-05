"use client";

/**
 * Сеанс админки (ADR-0011): отдельно от сессии сайта. Токен — в httpOnly-cookie `pl_admin` на /v1/admin
 * (скрипт страницы его не видит); здесь — запросы к /v1/admin/* с этой cookie и заголовком против CSRF,
 * cookie-подсказка `pl_admin_hint` для редиректов (src/proxy.ts) и шаги входа /admin/login.
 * Токен сайта (Authorization) в админку не отправляется.
 */

import { ADMIN_HINT_COOKIE } from "./adminGate";
import { ApiError, readError } from "./auth-client";

export const ADMIN_CSRF = { name: "x-requested-with", value: "platformsol-admin" };
/** Событие окна: сеанс админки закончился (401 от API) — оболочка админки ведёт на вход. */
export const ADMIN_SESSION_ENDED = "pl-admin-session-ended";
const HINT_MAX_AGE = 8 * 3600;

export type AdminMe = {
  id: number;
  email: string;
  name: string | null;
  role: string;
  method: "password" | "magic";
  started_at: string;
  expires_at: string;
  idle_minutes: number;
  backup_codes_left: number;
};
export type AdminStep = { step: "code" | "setup"; ticket: string; email: string };
export type AdminSetup = { secret: string; otpauth_url: string; qr: { size: number; path: string } };
export type AdminConfig = { mail: boolean; idle_minutes: number; session_hours: number };

export function setAdminHint(on: boolean) {
  try {
    document.cookie = on
      ? `${ADMIN_HINT_COOKIE}=1; path=/admin; max-age=${HINT_MAX_AGE}; samesite=strict`
      : `${ADMIN_HINT_COOKIE}=; path=/admin; max-age=0; samesite=strict`;
  } catch {
    /* приватный режим */
  }
}

export function hasAdminHint(): boolean {
  return typeof document !== "undefined" && document.cookie.includes(`${ADMIN_HINT_COOKIE}=1`);
}

/** fetch к /v1/admin/*: cookie админки, заголовок против CSRF, без токена сайта. */
export async function adminApi<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("accept", "application/json");
  headers.set(ADMIN_CSRF.name, ADMIN_CSRF.value);
  if (json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(path, {
    ...rest,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    const message = await readError(res);
    // шаги входа сами показывают ошибку; остальное — сеанс закончился, на страницу входа
    if (res.status === 401 && !path.startsWith("/v1/admin/auth/")) {
      setAdminHint(false);
      window.dispatchEvent(new CustomEvent(ADMIN_SESSION_ENDED));
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const getAdminConfig = () => adminApi<AdminConfig>("/v1/admin/auth/config");
export const adminLogin = (email: string, password: string) =>
  adminApi<AdminStep>("/v1/admin/auth/login", { method: "POST", json: { email, password } });
export const adminMagic = (email: string) => adminApi<{ status: string }>("/v1/admin/auth/magic", { method: "POST", json: { email } });
export const adminConsumeLink = (link: string) => adminApi<AdminStep>("/v1/admin/auth/magic/consume", { method: "POST", json: { link } });
export const adminSetupStart = (ticket: string) => adminApi<AdminSetup>("/v1/admin/auth/setup", { method: "POST", json: { ticket } });

export async function adminSetupConfirm(ticket: string, code: string): Promise<AdminMe & { backup_codes: string[] }> {
  const me = await adminApi<AdminMe & { backup_codes: string[] }>("/v1/admin/auth/setup/confirm", { method: "POST", json: { ticket, code } });
  setAdminHint(true);
  return me;
}

export async function adminVerify(ticket: string, code: string): Promise<AdminMe> {
  const me = await adminApi<AdminMe>("/v1/admin/auth/verify", { method: "POST", json: { ticket, code } });
  setAdminHint(true);
  return me;
}

export const getAdminMe = () => adminApi<AdminMe>("/v1/admin/auth/me");

/** Выход только из админки: сессия сайта (refresh-cookie на /v1/auth) остаётся. */
export async function adminLogout(): Promise<void> {
  try {
    await adminApi("/v1/admin/auth/logout", { method: "POST" });
  } finally {
    setAdminHint(false);
  }
}

/** Незаконченный вход в этой вкладке: переживает перезагрузку (iPhone выгружает вкладку, пока
 * владелец добавляет код в «Пароли»), иначе QR-код сменился бы и добавленный код не подошёл. */
export type PendingLogin = AdminStep & { setup?: AdminSetup };
const PENDING_KEY = "pl-admin-login";

export function savePending(p: PendingLogin | null) {
  try {
    if (p) sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* приватный режим */
  }
}

export function loadPending(): PendingLogin | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingLogin;
    return p && typeof p.ticket === "string" && (p.step === "code" || p.step === "setup") ? p : null;
  } catch {
    return null;
  }
}
