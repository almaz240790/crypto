import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";
import { adminGate, codeReady, ENDED_REASONS, ENDED_TEXT, endedReason, groupSecret, isAdminPath, normalizeCode, safeAdminNext } from "./adminGate";
import { needsCode } from "./admin";
import { cleanIp, clientIp, PROXY_HEADER, PROXY_IP_HEADER, proxyTrust } from "./proxyTrust";

/** Вход в админку (ADR-0011): куда ведут /admin без сеанса, куда возвращаться после входа, поле кода. */
describe("adminGate", () => {
  it("/admin и подстраницы без подсказки сеанса — на /admin/login (не на вход сайта)", () => {
    expect(adminGate("/admin", "", false)).toBe("/admin/login?next=%2Fadmin");
    expect(adminGate("/admin", "?tab=users", false)).toBe("/admin/login?next=%2Fadmin%3Ftab%3Dusers");
    expect(adminGate("/admin/anything", "", false)).toBe("/admin/login?next=%2Fadmin%2Fanything");
    expect(adminGate("/admin", "", true)).toBeNull();
  });
  it("вход на сайт пропускает к оболочке админки: переходный режим (код не настроен) решает API", () => {
    expect(adminGate("/admin", "?tab=users", false, true)).toBeNull();
    expect(adminGate("/admin/login", "", false, true)).toBeNull();
    expect(adminGate("/admin", "", false, false)).toBe("/admin/login?next=%2Fadmin");
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

describe("причина закрытия сеанса", () => {
  it("у каждой причины от API — свой понятный текст; незнакомая — просто «закончился»", () => {
    expect(endedReason(null)).toBeNull();
    expect(endedReason("")).toBeNull();
    expect(endedReason("password")).toBe("password");
    expect(endedReason("1")).toBe("gone"); // старые адреса ?ended=1
    expect(endedReason("<script>")).toBe("gone");
    for (const r of ENDED_REASONS) expect(ENDED_TEXT[r]).toMatch(/админк/);
    expect(new Set(Object.values(ENDED_TEXT)).size).toBe(ENDED_REASONS.length);
    expect(ENDED_TEXT.password).toContain("пароль");
    expect(ENDED_TEXT.idle).toContain("часа без действий");
    expect(ENDED_TEXT.password).not.toContain("без действий"); // смена пароля — не «простой»
  });
  it("словарь знает каждую причину", () => {
    const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
    for (const r of ENDED_REASONS) expect(en[ENDED_TEXT[r]]).toBeTruthy();
  });
});

describe("выдача прав админки", () => {
  it("код из приложения нужен для повышения до admin или owner", () => {
    expect(needsCode("user", "admin")).toBe(true);
    expect(needsCode("support", "owner")).toBe(true);
    expect(needsCode("admin", "owner")).toBe(true);
    expect(needsCode("owner", "admin")).toBe(false);
    expect(needsCode("admin", "user")).toBe(false);
    expect(needsCode("user", "support")).toBe(false);
  });
});

describe("подпись прокси сайта для API", () => {
  const h = (x: Record<string, string>) => new Headers(x);
  it("без секрета ничего не добавляет", () => {
    expect(proxyTrust(h({ "x-real-ip": "203.0.113.9" }), undefined)).toEqual({});
    expect(proxyTrust(h({ "x-real-ip": "203.0.113.9" }), "")).toEqual({});
  });
  it("с секретом — подпись и адрес клиента: X-Real-IP, иначе последнее значение X-Forwarded-For", () => {
    expect(proxyTrust(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6" }), "s3")).toEqual({ [PROXY_HEADER]: "s3", [PROXY_IP_HEADER]: "203.0.113.9" });
    // первое значение цепочки мог прислать сам клиент — берём то, что дописал ближайший прокси
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(h({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(proxyTrust(h({}), "s3")).toEqual({ [PROXY_HEADER]: "s3" });
  });
  it("в адрес не попадает произвольный текст", () => {
    expect(cleanIp("192.0.2.1 (home Wi-Fi - this was you)")).toBeNull();
    expect(cleanIp("999.1.1.1")).toBeNull();
    expect(cleanIp(" 192.0.2.1 ")).toBe("192.0.2.1");
    expect(clientIp(h({ "x-real-ip": "this was you", "x-forwarded-for": "1.2.3.4 (all good)" }))).toBeNull();
  });
  it("прокси /v1 пропускает причину закрытия сеанса и не пропускает чужую подпись", () => {
    const route = readFileSync(new URL("../app/v1/[...path]/route.ts", import.meta.url), "utf8");
    expect(route).toContain('"x-admin-ended"');
    const pass = /const PASS_REQ = \[([^\]]*)\]/.exec(route)![1]!;
    expect(pass).not.toContain("x-pl-");
    expect(pass).not.toContain("x-real-ip");
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
  it("вход на сайт (pl_auth) пропускает к оболочке — она спросит API о переходном режиме; подсказка сеанса админки — тоже", () => {
    const site = proxy(new NextRequest("http://localhost/admin", { headers: { cookie: "pl_auth=1" } }));
    expect(site.headers.get("location")).toBeNull();
    expect(site.headers.get("x-robots-tag")).toBe("noindex, nofollow");
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
