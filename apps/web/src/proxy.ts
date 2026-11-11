import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_HINT_COOKIE, adminGate, isAdminPath } from "@/lib/adminGate";
import { SIGNALS_NEXT_HEADER } from "@/lib/signalsAccess";

/** Редиректы по cookie-подсказке (без секретов). Настоящая проверка — на API по токену. */
const PROTECTED = ["/onboarding", "/settings", "/watchlist", "/alerts", "/journal", "/calculator", "/screener", "/billing"];
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
  // Сигналы (ADR-0013): гостя проверяет layout раздела — пока сигналы закрыты, там 404, а не вход.
  // Путь для возврата после входа (когда сигналы открыты) layout получает отсюда.
  if (!authed && (pathname === "/signals" || pathname.startsWith("/signals/"))) {
    const headers = new Headers(req.headers);
    headers.set(SIGNALS_NEXT_HEADER, pathname + search);
    return NextResponse.next({ request: { headers } });
  }
  if (!authed && PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
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
  // Список должен совпадать с PROTECTED, GUEST_ONLY, сигналами и админкой: путь вне matcher прокси не видит.
  matcher: ["/signals/:path*", "/onboarding", "/settings/:path*", "/watchlist", "/alerts", "/journal", "/calculator", "/screener", "/billing", "/admin", "/admin/:path*", "/login", "/register"],
};
