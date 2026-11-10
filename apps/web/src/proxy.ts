import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_HINT_COOKIE, adminGate, isAdminPath } from "@/lib/adminGate";

/** Редиректы по cookie-подсказке (без секретов). Настоящая проверка — на API по токену. */
const PROTECTED = ["/onboarding", "/settings", "/watchlist", "/alerts", "/journal", "/calculator", "/screener", "/billing"];
/**
 * Только после входа. Сама /signals открыта гостю: там объяснение, что такое тестовые сигналы, и призыв войти —
 * без данных сигналов (ADR-0013). Карточки /signals/… — только вошедшим.
 */
export function needsLogin(pathname: string): boolean {
  return pathname.startsWith("/signals/") || PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
const GUEST_ONLY = ["/login", "/register"];

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const authed = req.cookies.get("pl_auth")?.value === "1";
  // Админка (ADR-0011): свой вход /admin/login и свой сеанс. Вход на сайт пропускает только к оболочке
  // админки: она спросит API, действует ли переходный режим (код ещё не настроен), иначе уведёт на вход.
  if (isAdminPath(pathname)) {
    const to = adminGate(pathname, search, req.cookies.get(ADMIN_HINT_COOKIE)?.value === "1", authed);
    const res = to ? NextResponse.redirect(new URL(to, req.url)) : NextResponse.next();
    res.headers.set("x-robots-tag", "noindex, nofollow");
    return res;
  }
  if (!authed && needsLogin(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (authed && GUEST_ONLY.includes(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/chart";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Список должен совпадать с PROTECTED, GUEST_ONLY и админкой: путь вне matcher прокси не видит.
  matcher: ["/signals/:path*", "/onboarding", "/settings/:path*", "/watchlist", "/alerts", "/journal", "/calculator", "/screener", "/billing", "/admin", "/admin/:path*", "/login", "/register"],
};
