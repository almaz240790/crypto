import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SESSION_ENDED, adminApi, adminLogout, adminVerify, hasAdminHint, loadPending, savePending } from "./admin-auth";

/** Клиент сеанса админки (ADR-0011): cookie, заголовок против CSRF, без токена сайта; конец сеанса. */
type Call = { url: string; init: RequestInit };

let calls: Call[];
let reply: () => Response;
let cookie: string;
let events: string[];
let store: Map<string, string>;

beforeEach(() => {
  calls = [];
  events = [];
  cookie = "";
  store = new Map();
  reply = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  });
  vi.stubGlobal("document", {
    get cookie() {
      return cookie;
    },
    set cookie(v: string) {
      const [pair] = v.split(";");
      const [k, val] = pair!.split("=");
      const rest = cookie.split("; ").filter((c) => c && !c.startsWith(`${k}=`));
      cookie = (v.includes("max-age=0") ? rest : [...rest, `${k}=${val}`]).join("; ");
    },
  });
  vi.stubGlobal("window", { dispatchEvent: (e: Event) => events.push(e.type) });
  vi.stubGlobal("CustomEvent", class extends Event {});
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adminApi", () => {
  it("шлёт cookie своего сайта и заголовок админки, токен сайта — никогда", async () => {
    await adminApi("/v1/admin/users");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("x-requested-with")).toBe("platformsol-admin");
    expect(h.get("authorization")).toBeNull();
    expect(calls[0]!.init.credentials).toBe("same-origin");
  });
  it("401 на данных админки — конец сеанса: подсказка снята, событие для оболочки", async () => {
    cookie = "pl_admin_hint=1";
    reply = () => new Response(JSON.stringify({ detail: "Сеанс админки закончился. Войдите снова." }), { status: 401 });
    await expect(adminApi("/v1/admin/users")).rejects.toThrow("Сеанс админки закончился");
    expect(events).toEqual([ADMIN_SESSION_ENDED]);
    expect(hasAdminHint()).toBe(false);
  });
  it("401 на шаге входа — просто ошибка формы, без перехода", async () => {
    reply = () => new Response(JSON.stringify({ detail: "Не получилось войти. Проверьте email и пароль." }), { status: 401 });
    await expect(adminApi("/v1/admin/auth/login", { method: "POST", json: {} })).rejects.toMatchObject({ status: 401 });
    expect(events).toEqual([]);
  });
});

describe("сеанс", () => {
  it("после кода — подсказка для редиректов; выход из админки снимает её и не трогает вход на сайт", async () => {
    cookie = "pl_auth=1";
    await adminVerify("ticket-xxxxxxxx", "123456");
    expect(hasAdminHint()).toBe(true);
    reply = () => new Response(null, { status: 204 });
    await adminLogout();
    expect(hasAdminHint()).toBe(false);
    expect(cookie).toContain("pl_auth=1");
    expect(calls.at(-1)!.url).toBe("/v1/admin/auth/logout");
  });
  it("незаконченный вход переживает перезагрузку вкладки, мусор не принимается", () => {
    const p = { step: "setup" as const, ticket: "t-1234567890", email: "o@example.com", setup: { secret: "S", otpauth_url: "otpauth://x", qr: { size: 21, path: "M0 0h1v1h-1z" } } };
    savePending(p);
    expect(loadPending()).toEqual(p);
    savePending(null);
    expect(loadPending()).toBeNull();
    store.set("pl-admin-login", JSON.stringify({ step: "other", ticket: 1 }));
    expect(loadPending()).toBeNull();
  });
});
