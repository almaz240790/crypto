/**
 * Вход в админку (ADR-0011): куда вести со страниц /admin без сеанса админки. Проверка по
 * cookie-подсказке `pl_admin_hint` (без секретов, путь /admin); настоящая проверка — на API по
 * httpOnly-cookie `pl_admin`. Чистые функции — их использует src/proxy.ts и страница входа.
 */

export const ADMIN_HINT_COOKIE = "pl_admin_hint";
export const ADMIN_LOGIN = "/admin/login";

export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/** Адрес страницы входа для пути без подсказки сеанса; null — пропустить (вход или подсказка есть). */
export function adminGate(pathname: string, search: string, hasHint: boolean): string | null {
  if (!isAdminPath(pathname) || pathname === ADMIN_LOGIN || pathname.startsWith(ADMIN_LOGIN + "/")) return null;
  if (hasHint) return null;
  return `${ADMIN_LOGIN}?next=${encodeURIComponent(pathname + search)}`;
}

/** Куда вернуться после входа: только страницы админки (не сама страница входа и не чужой домен). */
export function safeAdminNext(v: string | null | undefined): string {
  if (!v || !v.startsWith("/admin") || v.startsWith("//")) return "/admin";
  const path = v.split(/[?#]/)[0]!;
  if (!isAdminPath(path) || path === ADMIN_LOGIN || path.startsWith(ADMIN_LOGIN + "/")) return "/admin";
  return v;
}

/** Ключ для ручного ввода в приложение: группы по 4 символа. */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/** Поле кода: цифры TOTP без пробелов; резервный код — буквы и цифры заглавными. */
export function normalizeCode(v: string): string {
  return v.replace(/[^0-9a-z]/gi, "").toUpperCase().slice(0, 16);
}

/** Можно отправлять: 6 цифр из приложения или резервный код (10 символов). */
export function codeReady(v: string): boolean {
  const c = normalizeCode(v);
  return /^\d{6}$/.test(c) || /^[A-Z0-9]{10}$/.test(c);
}
