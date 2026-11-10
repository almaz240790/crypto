/**
 * Вход в админку (ADR-0011): куда вести со страниц /admin без сеанса админки. Проверка по
 * cookie-подсказке `pl_admin_hint` (без секретов, путь /admin); настоящая проверка — на API по
 * httpOnly-cookie `pl_admin`. Подсказка входа на сайт (`pl_auth`) тоже пропускает к оболочке админки:
 * она спросит API, действует ли переходный режим (админ без настроенного кода), и без него уведёт на вход.
 * Чистые функции — их использует src/proxy.ts и страница входа.
 */

export const ADMIN_HINT_COOKIE = "pl_admin_hint";
export const ADMIN_LOGIN = "/admin/login";

export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/**
 * Адрес страницы входа для пути без подсказок; null — пропустить (страница входа, подсказка сеанса админки
 * или подсказка входа на сайт `siteHint` — возможен переходный режим, решит API).
 */
export function adminGate(pathname: string, search: string, hasHint: boolean, siteHint = false): string | null {
  if (!isAdminPath(pathname) || pathname === ADMIN_LOGIN || pathname.startsWith(ADMIN_LOGIN + "/")) return null;
  if (hasHint || siteHint) return null;
  return `${ADMIN_LOGIN}?next=${encodeURIComponent(pathname + search)}`;
}

/** Куда вернуться после входа: только страницы админки (не сама страница входа и не чужой домен). */
export function safeAdminNext(v: string | null | undefined): string {
  if (!v || !v.startsWith("/admin") || v.startsWith("//")) return "/admin";
  const path = v.split(/[?#]/)[0]!;
  if (!isAdminPath(path) || path === ADMIN_LOGIN || path.startsWith(ADMIN_LOGIN + "/")) return "/admin";
  return v;
}

/** Почему закрылся сеанс админки — как отвечает API в заголовке `X-Admin-Ended` (ADR-0011). */
export const ENDED_REASONS = ["idle", "expired", "logout", "password", "2fa", "role", "blocked", "gone"] as const;
export type EndedReason = (typeof ENDED_REASONS)[number];

/** Причина из заголовка или из адреса (`?ended=`); незнакомое значение — просто «закончился». */
export function endedReason(v: string | null | undefined): EndedReason | null {
  if (!v) return null;
  return (ENDED_REASONS as readonly string[]).includes(v) ? (v as EndedReason) : "gone";
}

/** Что сказать владельцу на странице входа (ключи словаря; текст проходит через t()). */
export const ENDED_TEXT: Record<EndedReason, string> = {
  idle: "Сеанс админки закончился: больше часа без действий. Войдите снова.",
  expired: "Сеанс админки закончился: прошло 8 часов с входа. Войдите снова.",
  logout: "Вы вышли из админки в другой вкладке. Чтобы продолжить, войдите снова.",
  password: "Сеанс админки закрыт: пароль аккаунта изменён. Войдите с новым паролем.",
  "2fa": "Сеанс админки закрыт: защита кодом изменена. Войдите снова.",
  role: "Сеанс админки закрыт: у аккаунта больше нет прав админки.",
  blocked: "Сеанс админки закрыт: аккаунт заблокирован.",
  gone: "Сеанс админки закончился. Войдите снова.",
};

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
