import { NextResponse, type NextRequest } from "next/server";

/** Редиректы по cookie-подсказке (без секретов). Настоящая проверка — на API по токену. */
const PROTECTED = ["/signals", "/onboarding", "/settings", "/watchlist", "/journal", "/calculator", "/screener"];
const GUEST_ONLY = ["/login", "/register"];

export function proxy(req: NextRequest) {
  const authed = req.cookies.get("pl_auth")?.value === "1";
  const { pathname } = req.nextUrl;
  if (!authed && PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (authed && GUEST_ONLY.includes(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/signals";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/signals/:path*", "/onboarding", "/settings/:path*", "/watchlist", "/journal", "/calculator", "/screener", "/login", "/register"],
};
