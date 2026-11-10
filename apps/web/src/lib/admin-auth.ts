"use client";

/**
 * Сеанс админки (ADR-0011): отдельно от сессии сайта. Токен — в httpOnly-cookie `pl_admin` на /v1/admin
 * (скрипт страницы его не видит); здесь — запросы к /v1/admin/* с этой cookie и заголовком против CSRF,
 * cookie-подсказка `pl_admin_hint` для редиректов (src/proxy.ts) и шаги входа /admin/login.
 * Токен сайта (Authorization) в админку не отправляется.
 */

import { ADMIN_HINT_COOKIE, endedReason, type EndedReason } from "./adminGate";
import { ApiError, readError } from "./auth-client";

export const ADMIN_CSRF = { name: "x-requested-with", value: "platformsol-admin" };
/** Заголовок ответа API: почему сеанс закрыт (см. ENDED_REASONS). */
export const ADMIN_ENDED_HEADER = "x-admin-ended";
/** Событие окна: сеанс админки закончился — оболочка админки ведёт на вход; detail — причина. */
export const ADMIN_SESSION_ENDED = "pl-admin-session-ended";
/** Как у cookie сеанса на API (8 часов + сутки): по истечении сеанса оболочка успевает спросить API и
 * показать причину «прошло 8 часов», а не молча увести на вход. */
const HINT_MAX_AGE = (8 + 24) * 3600;

/** Ошибка API админки; `ended` — причина, если сеанс закрыт (для подсказки на странице входа). */
export class AdminApiError extends ApiError {
  ended: EndedReason | null;
  constructor(status: number, message: string, ended: EndedReason | null = null) {
    super(status, message);
    this.ended = ended;
  }
}

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
/** Первый фактор пройден: билет на код или на первую настройку кода. */
export type AdminStep = { step: "code" | "setup"; ticket: string; email: string };
/** Пароль верный, но код ещё не настроен: настройка — только по ссылке из письма (или с сервера). */
export type AdminMailStep = { step: "mail"; email: string; mail: boolean; sent: boolean };
export type AdminSetup = { secret: string; otpauth_url: string; qr: { size: number; path: string } };
export type AdminConfig = { mail: boolean; idle_minutes: number; session_hours: number };
export type AdminCodes = { backup_codes: string[]; backup_codes_left: number };

/**
 * Подсказка сеанса для редиректов. SameSite=Lax (не Strict): по ссылке из письма или мессенджера браузер
 * отправит её, и /admin?tab=… откроется сразу, без лишнего входа. Секрета в ней нет; настоящая проверка — на API.
 */
export function setAdminHint(on: boolean) {
  try {
    document.cookie = on
      ? `${ADMIN_HINT_COOKIE}=1; path=/admin; max-age=${HINT_MAX_AGE}; samesite=lax`
      : `${ADMIN_HINT_COOKIE}=; path=/admin; max-age=0; samesite=lax`;
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
    const reason = endedReason(res.headers.get(ADMIN_ENDED_HEADER));
    // Сеанс закрыт: API назвал причину — или 401 на данных админки. На шагах входа и действиях с кодом
    // (/v1/admin/auth/*) 401 без причины — это «неверный пароль или код»: ошибку показывает сама форма.
    const ended = reason ?? (res.status === 401 && !path.startsWith("/v1/admin/auth/") ? "gone" : null);
    if (ended && path !== "/v1/admin/auth/me") {
      setAdminHint(false);
      window.dispatchEvent(new CustomEvent(ADMIN_SESSION_ENDED, { detail: ended }));
    }
    throw new AdminApiError(res.status, message, ended);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const getAdminConfig = () => adminApi<AdminConfig>("/v1/admin/auth/config");
export const adminLogin = (email: string, password: string) =>
  adminApi<AdminStep | AdminMailStep>("/v1/admin/auth/login", { method: "POST", json: { email, password } });
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

/** Защита входа внутри админки: новые резервные коды и перенос кода на другой телефон. */
export const adminNewBackupCodes = (code: string) => adminApi<AdminCodes>("/v1/admin/auth/2fa/backup-codes", { method: "POST", json: { code } });
export const adminRotateStart = (code: string) => adminApi<AdminSetup & { pending: string }>("/v1/admin/auth/2fa/rotate", { method: "POST", json: { code } });
export const adminRotateConfirm = (pending: string, code: string) =>
  adminApi<AdminCodes>("/v1/admin/auth/2fa/rotate/confirm", { method: "POST", json: { pending, code } });

/** Незаконченный вход в этой вкладке: переживает перезагрузку (iPhone выгружает вкладку, пока
 * владелец добавляет код в «Пароли»), иначе QR-код сменился бы и добавленный код не подошёл. */
export type PendingLogin = AdminStep & { setup?: AdminSetup };
const PENDING_KEY = "pl-admin-login";

function store(key: string, value: unknown | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* приватный режим */
  }
}

function read(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export const savePending = (p: PendingLogin | null) => store(PENDING_KEY, p);

export function loadPending(): PendingLogin | null {
  const p = read(PENDING_KEY) as PendingLogin | null;
  return p && typeof p.ticket === "string" && (p.step === "code" || p.step === "setup") ? p : null;
}

/** Резервные коды, которые владелец ещё не подтвердил сохранёнными: API отдаёт их один раз, поэтому до
 * галочки «сохранил(а)» они лежат во вкладке и переживают перезагрузку (на iPhone — уход в «Пароли» и
 * обновление страницы жестом). После подтверждения стираются. */
export type BackupStash = { codes: string[]; email: string };
const BACKUP_KEY = "pl-admin-backup";

export const saveBackup = (b: BackupStash | null) => store(BACKUP_KEY, b);

export function loadBackup(): BackupStash | null {
  const b = read(BACKUP_KEY) as BackupStash | null;
  const ok = b && Array.isArray(b.codes) && b.codes.length > 0 && b.codes.every((c) => typeof c === "string") && typeof b.email === "string";
  return ok ? b : null;
}
