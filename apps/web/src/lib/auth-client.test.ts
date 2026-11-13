import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api() — fetch к API с токеном сайта (план 3.2). Публичные эндпоинты (свечи, слои, лента сигналов) принимают
 * необязательный вход: без токена — гость, с недействительным или истёкшим токеном — 401 (аудит TSA-1). Клиент
 * на 401 обновляет токен и повторяет; не обновился (сеанс закончился) — повторяет без токена, как гость: публичная
 * страница не ломается. Без подсказки входа (cookie pl_auth) refresh до запроса не шлётся (аудит TSA-6).
 */
type Call = { url: string; auth: string | null; method: string };

let calls: Call[];
let cookie: string;
let handler: (url: string, auth: string | null) => Response;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CANDLES = "/v1/chart/candles?symbol=BTCUSDT&tf=1m&limit=500";

/** Модуль заново на каждый тест: access-токен живёт в памяти модуля. */
const load = async () => {
  vi.resetModules();
  return import("./auth-client");
};

beforeEach(() => {
  calls = [];
  cookie = "";
  handler = () => json(200, { ok: true });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ url, auth, method: init.method ?? "GET" });
    return handler(url, auth);
  });
  vi.stubGlobal("document", {
    get cookie() {
      return cookie;
    },
    set cookie(v: string) {
      const [pair] = v.split(";");
      const [k] = pair!.split("=");
      const rest = cookie.split("; ").filter((c) => c && !c.startsWith(`${k}=`));
      cookie = (v.includes("max-age=0") ? rest : [...rest, pair!]).join("; ");
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api(): гость без подсказки входа (TSA-6)", () => {
  it("свечи — один запрос без токена, refresh не шлётся", async () => {
    const { api } = await load();
    await api(CANDLES);
    await api(`${CANDLES}&before=1`);
    expect(calls.map((c) => c.url)).toEqual([CANDLES, `${CANDLES}&before=1`]);
    expect(calls.every((c) => c.auth === null)).toBe(true);
  });

  it("с подсказкой входа (перезагрузка вкладки) — сначала refresh, потом запрос с токеном", async () => {
    cookie = "pl_auth=1";
    handler = (url) => (url === "/v1/auth/refresh" ? json(200, { access_token: "a1" }) : json(200, { ok: true }));
    const { api } = await load();
    await api(CANDLES);
    expect(calls.map((c) => `${c.url} ${c.auth}`)).toEqual(["/v1/auth/refresh null", `${CANDLES} Bearer a1`]);
  });
});

describe("api(): истёкший токен на публичном эндпоинте (TSA-1)", () => {
  it("401 → refresh → повтор с новым токеном (Pro остаётся Pro)", async () => {
    cookie = "pl_auth=1";
    let issued = 0;
    handler = (url, auth) => {
      if (url === "/v1/auth/refresh") return json(200, { access_token: `a${++issued}` });
      return auth === "Bearer a1" ? json(401, { detail: "недействительный токен" }) : json(200, { ok: auth });
    };
    const { api } = await load();
    await expect(api(CANDLES)).resolves.toEqual({ ok: "Bearer a2" });
    expect(calls.map((c) => `${c.url} ${c.auth}`)).toEqual(["/v1/auth/refresh null", `${CANDLES} Bearer a1`, "/v1/auth/refresh null", `${CANDLES} Bearer a2`]);
  });

  it("сеанс закончился (refresh 401) — запрос повторяется без токена и отвечает как гостю; подсказка снята", async () => {
    cookie = "pl_auth=1";
    let refreshes = 0;
    handler = (url, auth) => {
      if (url === "/v1/auth/refresh") return ++refreshes === 1 ? json(200, { access_token: "a1" }) : json(401, { detail: "сессия истекла" });
      return auth ? json(401, { detail: "недействительный токен" }) : json(200, { guest: true });
    };
    const { api, hasHint } = await load();
    await expect(api(CANDLES)).resolves.toEqual({ guest: true });
    expect(calls.map((c) => `${c.url} ${c.auth}`)).toEqual(["/v1/auth/refresh null", `${CANDLES} Bearer a1`, "/v1/auth/refresh null", `${CANDLES} null`]);
    expect(hasHint()).toBe(false);
    // дальше — гость: ни refresh, ни токена
    calls = [];
    await expect(api(CANDLES)).resolves.toEqual({ guest: true });
    expect(calls.map((c) => `${c.url} ${c.auth}`)).toEqual([`${CANDLES} null`]);
  });

  it("сервер отказал в обновлении (аккаунт заблокирован или удалён) — подписчики onSessionLost узнают: вкладка становится гостем", async () => {
    cookie = "pl_auth=1";
    let blocked = false;
    handler = (url, auth) => {
      if (url === "/v1/auth/refresh") return blocked ? json(401, { detail: "Аккаунт заблокирован. Напишите в поддержку." }) : json(200, { access_token: "a1" });
      if (!auth) return json(200, { guest: true });
      return blocked ? json(401, { detail: "недействительный токен" }) : json(200, { ok: auth });
    };
    const { api, getAccessToken, hasHint, onSessionLost } = await load();
    const lost = vi.fn();
    const off = onSessionLost(lost);
    await expect(api(CANDLES)).resolves.toEqual({ ok: "Bearer a1" });
    expect(lost).not.toHaveBeenCalled();
    blocked = true;
    await expect(api(CANDLES)).resolves.toEqual({ guest: true });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
    expect(hasHint()).toBe(false);
    off();
    cookie = "pl_auth=1";
    await api(CANDLES);
    expect(lost).toHaveBeenCalledTimes(1); // отписка работает
  });

  it("сбой сети при обновлении — не конец сеанса: подписчики onSessionLost не вызываются", async () => {
    cookie = "pl_auth=1";
    handler = (url) => {
      if (url === "/v1/auth/refresh") throw new TypeError("Failed to fetch");
      return json(200, { guest: true });
    };
    const { api, hasHint, onSessionLost } = await load();
    const lost = vi.fn();
    onSessionLost(lost);
    await expect(api(CANDLES)).resolves.toEqual({ guest: true });
    expect(lost).not.toHaveBeenCalled();
    expect(hasHint()).toBe(true);
  });

  it("закрытый эндпоинт без сеанса — та же ошибка 401, без лишнего refresh у гостя", async () => {
    handler = () => json(401, { detail: "нужен токен" });
    const { api, ApiError } = await load();
    await expect(api("/v1/alerts")).rejects.toBeInstanceOf(ApiError);
    await expect(api("/v1/alerts")).rejects.toMatchObject({ status: 401 });
    expect(calls.map((c) => c.url)).toEqual(["/v1/alerts", "/v1/alerts"]);
  });
});
