import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";
import { adminGate, codeReady, groupSecret, isAdminPath, normalizeCode, safeAdminNext } from "./adminGate";

/** Вход в админку (ADR-0011): куда ведут /admin без сеанса, куда возвращаться после входа, поле кода. */
describe("adminGate", () => {
  it("/admin и подстраницы без подсказки сеанса — на /admin/login (не на вход сайта)", () => {
    expect(adminGate("/admin", "", false)).toBe("/admin/login?next=%2Fadmin");
    expect(adminGate("/admin", "?tab=users", false)).toBe("/admin/login?next=%2Fadmin%3Ftab%3Dusers");
    expect(adminGate("/admin/anything", "", false)).toBe("/admin/login?next=%2Fadmin%2Fanything");
    expect(adminGate("/admin", "", true)).toBeNull();
  });
  it("страница входа доступна всегда; чужие пути не трогает", () => {
    expect(adminGate("/admin/login", "", false)).toBeNull();
    expect(adminGate("/administrator", "", false)).toBeNull();
    expect(adminGate("/chart", "", false)).toBeNull();
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admins")).toBe(false);
  });
  it("после входа — только в админку, не на сам вход и не на чужой сайт", () => {
    expect(safeAdminNext(undefined)).toBe("/admin");
    expect(safeAdminNext("/admin?tab=audit")).toBe("/admin?tab=audit");
    expect(safeAdminNext("/admin/login?next=/admin")).toBe("/admin");
    expect(safeAdminNext("//evil.example/admin")).toBe("/admin");
    expect(safeAdminNext("https://evil.example/admin")).toBe("/admin");
    expect(safeAdminNext("/chart")).toBe("/admin");
    expect(safeAdminNext("/administrator")).toBe("/admin");
  });
  it("поле кода: 6 цифр или резервный код из 10 знаков, пробелы и дефисы не мешают", () => {
    expect(normalizeCode(" 123 456 ")).toBe("123456");
    expect(normalizeCode("abcd-efgh-23")).toBe("ABCDEFGH23");
    expect(codeReady("123 456")).toBe(true);
    expect(codeReady("12345")).toBe(false);
    expect(codeReady("ABCDE-FGH23")).toBe(true);
    expect(codeReady("ABC")).toBe(false);
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
  });
});

describe("src/proxy.ts для админки", () => {
  it("без подсказки — редирект на /admin/login, всегда noindex", () => {
    const res = proxy(new NextRequest("http://localhost/admin?tab=users"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/admin/login?next=%2Fadmin%3Ftab%3Dusers");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const login = proxy(new NextRequest("http://localhost/admin/login"));
    expect(login.headers.get("location")).toBeNull();
    expect(login.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
  it("вход на сайт (pl_auth) админку не открывает; подсказка сеанса админки — открывает", () => {
    const site = proxy(new NextRequest("http://localhost/admin", { headers: { cookie: "pl_auth=1" } }));
    expect(site.headers.get("location")).toContain("/admin/login");
    const admin = proxy(new NextRequest("http://localhost/admin", { headers: { cookie: "pl_admin_hint=1" } }));
    expect(admin.headers.get("location")).toBeNull();
  });
  it("matcher видит /admin и все подстраницы", () => {
    expect(config.matcher).toContain("/admin");
    expect(config.matcher).toContain("/admin/:path*");
  });
  it("в меню сайта нет ссылки на админку", () => {
    const shell = readFileSync(new URL("../components/app/AppShell.tsx", import.meta.url), "utf8");
    expect(shell).not.toMatch(/href:\s*"\/admin/);
    expect(shell).not.toContain('"Админка"');
  });
});
