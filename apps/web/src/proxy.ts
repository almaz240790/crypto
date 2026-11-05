import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_HINT_COOKIE, adminGate, isAdminPath } from "@/lib/adminGate";

/** Редиректы по cookie-подсказке (без секретов). Настоящая проверка — на API по токену. */
const PROTECTED = ["/signals", "/onboarding", "/settings", "/watchlist", "/alerts", "/journal", "/calculator", "/screener", "/billing"];
const GUEST_ONLY = ["/login", "/register"];

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  // Админка (ADR-0011): свой вход /admin/login и свой сеанс; вход на сайт сюда не пускает
  if (isAdminPath(pathname)) {
    const to = adminGate(pathname, search, req.cookies.get(ADMIN_HINT_COOKIE)?.value === "1");
    const res = to ? NextResponse.redirect(new URL(to, req.url)) : NextResponse.next();
    res.headers.set("x-robots-tag", "noindex, nofollow");
    return res;
  }
  const authed = req.cookies.get("pl_auth")?.value === "1";
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
  // Список должен совпадать с PROTECTED, GUEST_ONLY и админкой: путь вне matcher прокси не видит.
  matcher: ["/signals/:path*", "/onboarding", "/settings/:path*", "/watchlist", "/alerts", "/journal", "/calculator", "/screener", "/billing", "/admin", "/admin/:path*", "/login", "/register"],
};
