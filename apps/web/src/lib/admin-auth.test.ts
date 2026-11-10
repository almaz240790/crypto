import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SESSION_ENDED, AdminApiError, adminApi, adminLogout, adminVerify, getAdminMe, hasAdminHint, loadBackup, loadPending, saveBackup, savePending, setAdminHint } from "./admin-auth";

/** Клиент сеанса админки (ADR-0011): cookie, заголовок против CSRF, без токена сайта; конец сеанса. */
type Call = { url: string; init: RequestInit };

let calls: Call[];
let reply: () => Response;
let cookie: string;
let events: string[];
let details: unknown[];
let written: string[];
let store: Map<string, string>;

beforeEach(() => {
  calls = [];
  events = [];
  details = [];
  written = [];
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
      written.push(v);
      const [pair] = v.split(";");
      const [k, val] = pair!.split("=");
      const rest = cookie.split("; ").filter((c) => c && !c.startsWith(`${k}=`));
      cookie = (v.includes("max-age=0") ? rest : [...rest, `${k}=${val}`]).join("; ");
    },
  });
  vi.stubGlobal("window", {
    dispatchEvent: (e: Event & { detail?: unknown }) => {
      events.push(e.type);
      details.push(e.detail);
    },
  });
  vi.stubGlobal(
    "CustomEvent",
    class extends Event {
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        super(type);
        this.detail = init?.detail;
      }
    },
  );
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
  it("причина закрытия сеанса из заголовка X-Admin-Ended доходит до оболочки (в т. ч. 403 — нет прав)", async () => {
    const ended = (status: number, reason: string) => () => new Response(JSON.stringify({ detail: "закрыт" }), { status, headers: { "x-admin-ended": reason } });
    reply = ended(401, "password");
    await expect(adminApi("/v1/admin/audit")).rejects.toMatchObject({ status: 401, ended: "password" });
    reply = ended(403, "role");
    await expect(adminApi("/v1/admin/users")).rejects.toBeInstanceOf(AdminApiError);
    reply = ended(401, "brand-new-reason");
    await expect(adminApi("/v1/admin/users")).rejects.toMatchObject({ ended: "gone" });
    expect(details).toEqual(["password", "role", "gone"]);
    // без причины 401 на данных — просто «закончился»
    reply = () => new Response(JSON.stringify({ detail: "Нужен вход в админку." }), { status: 401 });
    await expect(adminApi("/v1/admin/users")).rejects.toMatchObject({ ended: "gone" });
  });
  it("действия с кодом внутри админки: 401 без причины — неверный код (форма), с причиной — конец сеанса", async () => {
    reply = () => new Response(JSON.stringify({ detail: "Код не подошёл." }), { status: 401 });
    await expect(adminApi("/v1/admin/auth/2fa/backup-codes", { method: "POST", json: { code: "000000" } })).rejects.toMatchObject({ status: 401, ended: null });
    expect(events).toEqual([]);
    reply = () => new Response(JSON.stringify({ detail: "закрыт" }), { status: 401, headers: { "x-admin-ended": "idle" } });
    await expect(adminApi("/v1/admin/auth/2fa/backup-codes", { method: "POST", json: { code: "000000" } })).rejects.toMatchObject({ ended: "idle" });
    expect(details).toEqual(["idle"]);
  });
  it("проверка «кто вошёл» события не шлёт: причину читает тот, кто спрашивал", async () => {
    cookie = "pl_admin_hint=1";
    reply = () => new Response(JSON.stringify({ detail: "закрыт" }), { status: 401, headers: { "x-admin-ended": "expired" } });
    await expect(getAdminMe()).rejects.toMatchObject({ status: 401, ended: "expired" });
    expect(events).toEqual([]);
    expect(hasAdminHint()).toBe(true);
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
  it("резервные коды до галочки «сохранил(а)» переживают перезагрузку вкладки, потом стираются", () => {
    expect(loadBackup()).toBeNull();
    saveBackup({ codes: ["ABCDEFGH23", "BCDEFGHJ34"], email: "o@example.com" });
    expect(loadBackup()).toEqual({ codes: ["ABCDEFGH23", "BCDEFGHJ34"], email: "o@example.com" });
    saveBackup(null);
    expect(loadBackup()).toBeNull();
    for (const junk of [{ codes: [], email: "o@example.com" }, { codes: [1, 2], email: "o@example.com" }, { codes: ["A"] }, "x"]) {
      store.set("pl-admin-backup", JSON.stringify(junk));
      expect(loadBackup()).toBeNull();
    }
    store.set("pl-admin-backup", "{не json");
    expect(loadBackup()).toBeNull();
  });
  it("подсказка сеанса — SameSite=Lax и только путь /admin: по ссылке из письма админка открывается без нового входа", () => {
    setAdminHint(true);
    expect(written.at(-1)).toMatch(/^pl_admin_hint=1; path=\/admin; max-age=115200; samesite=lax$/);
    setAdminHint(false);
    expect(written.at(-1)).toContain("max-age=0");
    expect(hasAdminHint()).toBe(false);
  });
});
