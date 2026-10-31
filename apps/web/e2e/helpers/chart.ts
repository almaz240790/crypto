import type { Page } from "@playwright/test";

/** Заглушки API терминала для e2e (план 3.17). */
export const T0 = 1_792_000_000 - (1_792_000_000 % 14400);
export const H4 = 14400;
/** Первая порция — свечи 0…299 и текущая 300; история слева — порциями по 500 до свечи HISTORY_FROM. */
export const FIRST_PAGE = 300;
const HISTORY_FROM = -2000;
/** Монета дешевле цента: шаг цены 1e-7 в экспоненциальной записи, как отдавал str(Decimal) в API. */
export const SUBCENT = "1000PEPEUSDT";
const candle = (i: number) => {
  const o = 100 + Math.sin(i / 7) * 5;
  const c = o + Math.cos(i / 5);
  return { t: T0 + i * H4, o: o.toFixed(2), h: (Math.max(o, c) + 1).toFixed(2), l: (Math.min(o, c) - 1).toFixed(2), c: c.toFixed(2), v: "1000", open: false };
};
const subcent = (i: number) => {
  const o = 0.0049 + Math.sin(i / 7) * 0.0003;
  const c = o + Math.cos(i / 5) * 0.00005;
  const f = (x: number) => x.toFixed(7);
  return { t: T0 + i * H4, o: f(o), h: f(Math.max(o, c) + 0.00004), l: f(Math.min(o, c) - 0.00004), c: f(c), v: "123456789", open: false };
};

/** Шаг цены — как у /v1/instruments ниже: у BTCUSDT 0.1 (как на бирже), у монеты дешевле цента — старый формат API. */
const TICKS: Record<string, string> = { BTCUSDT: "0.1", ETHUSDT: "0.01", [SUBCENT]: "1.000E-7" };

export type MockServer = { drawings: Record<string, unknown>[]; layout: Record<string, unknown> | null; layouts?: Record<string, Record<string, unknown>>; alerts?: Record<string, unknown>[]; plan?: "free" | "pro" | "premium" };

export async function mock(page: Page, calls: string[], authed = false, server: MockServer = { drawings: [], layout: null }) {
  server.layouts ??= {};
  server.alerts ??= [];
  if (authed) await page.context().addCookies([{ name: "pl_auth", value: "1", url: "http://localhost:3101" }]);
  await page.route("**/v1/**", (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    calls.push(`${p}?${u.searchParams.toString()}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/auth/refresh") return json(authed ? 200 : 401, authed ? { access_token: "t" } : { detail: "нет" });
    if (p === "/v1/auth/me") return json(200, { id: 7, email: "t@example.com", name: null, email_verified: true, role: "user", locale: "ru", timezone: "UTC", theme: "system", risk: {} });
    if (p === "/v1/billing/me") return json(200, { plan: server.plan ?? "premium", billing_enabled: false, balance_usd: "0", subscription: null });
    if (p === "/v1/instruments") return json(200, [{ symbol: "BTCUSDT", tick_size: "0.1" }, { symbol: "ETHUSDT", tick_size: "0.01" }, { symbol: SUBCENT, tick_size: "0.0000001" }]);
    if (p === "/v1/chart/candles") {
      const tf = u.searchParams.get("tf");
      if (["1m", "5m", "15m"].includes(tf ?? "") && !authed) return json(403, { detail: "таймфреймы 1m–15m доступны на тарифе Pro" });
      const symbol = u.searchParams.get("symbol") ?? "BTCUSDT";
      const mk = symbol === SUBCENT ? subcent : candle;
      // порция «до времени before»: свечи строго раньше, как у API
      const before = u.searchParams.get("before");
      const end = before ? Math.round((Number(before) - T0) / H4) : FIRST_PAGE;
      const start = before ? Math.max(HISTORY_FROM, end - 500) : 0;
      const items = Array.from({ length: Math.max(0, end - start) }, (_, i) => mk(start + i));
      // шаг цены тот же, что в /v1/instruments; прочие символы заглушки — 0.01
      const tick = TICKS[symbol] ?? "0.01";
      return json(200, { symbol, tf, candles: items, current: before ? null : { ...mk(end), open: true }, has_older: start > HISTORY_FROM, tick_size: tick, server_time: "" });
    }
    if (p === "/v1/drawings" && route.request().method() === "GET") return json(200, { symbol: "BTCUSDT", items: server.drawings, limit: 100, sync: true });
    if (p === "/v1/drawings" && route.request().method() === "PUT") {
      const items = route.request().postDataJSON() as Record<string, unknown>[];
      for (const it of items) {
        const i = server.drawings.findIndex((d) => d.client_id === it.client_id);
        const cur = i >= 0 ? server.drawings[i]! : null;
        const win = !cur || (it.updated_at as number) >= (cur.updated_at as number) ? it : cur;
        if (i >= 0) server.drawings[i] = win;
        else server.drawings.push(win);
      }
      return json(200, { items: items.map((it) => server.drawings.find((d) => d.client_id === it.client_id)) });
    }
    if (p === "/v1/chart/layouts") return json(200, Object.keys(server.layouts!).map((name) => ({ name, updated_at: 0 })));
    if (p === "/v1/chart/layout" && route.request().method() === "GET") {
      const name = u.searchParams.get("name");
      if (name) return json(200, { name, data: server.layouts![name] ?? null, updated_at: 0 });
      return json(200, { name: null, data: server.layout, updated_at: (server.layout?.__updated as number) ?? 0 });
    }
    if (p === "/v1/chart/layout" && route.request().method() === "PUT") {
      const b = route.request().postDataJSON() as { name: string | null; data: Record<string, unknown>; updated_at: number };
      if (b.name) {
        server.layouts![b.name] = b.data;
        return json(200, { name: b.name, data: b.data, updated_at: b.updated_at });
      }
      server.layout = { ...b.data, __updated: b.updated_at };
      return json(200, { name: null, data: b.data, updated_at: b.updated_at });
    }
    if (p === "/v1/chart/layout" && route.request().method() === "DELETE") {
      delete server.layouts![u.searchParams.get("name") ?? ""];
      return route.fulfill({ status: 204, body: "" });
    }
    if (p === "/v1/chart/derivatives") {
      // OI на каждой свече и ещё одна точка на свечу раньше первой (как у API: окно derivatives шире свечей);
      // на 1w — корзины не совпадают со свечами (старое выравнивание недель от эпохи, по четвергам)
      const shift = u.searchParams.get("tf") === "1w" ? 3 * 86400 + 7200 : 0;
      const oi = Array.from({ length: FIRST_PAGE + 2 }, (_, k) => ({ t: T0 + (k - 1) * H4 + shift, v: String(7_800_000_000 + k * 2_000_000) }));
      return json(200, { symbol: "BTCUSDT", tf: "4h", funding: [{ t: T0 - H4, v: "0.0001" }, { t: T0 + 100 * H4, v: "0.0001" }, { t: T0 + 200 * H4 + 3600, v: "0.00012" }], funding_current: "0.00012", next_funding_t: Math.floor(Date.now() / 1000) + 3600, oi, liquidations: [{ t: T0 + 100 * H4, long: "1000", short: "2000" }], liquidations_note: "", ls_ratio: [{ t: T0 + 100 * H4, v: "1.2" }, { t: T0 + 200 * H4, v: "0.9" }], ls_top: [{ t: T0 + 100 * H4, v: "1.5" }] });
    }
    if (p === "/v1/alerts" && route.request().method() === "GET") return json(200, { items: server.alerts, active: server.alerts!.length, limit: 50, types: [], frequencies: [] });
    if (p === "/v1/alerts" && route.request().method() === "POST") {
      const b = route.request().postDataJSON() as { symbol: string; type: string; condition: { op: string; price: string }; frequency: string; drawing_client_id: string | null };
      const a = { id: server.alerts!.length + 1, symbol: b.symbol, timeframe: null, type: b.type, condition: b.condition, text: `${b.symbol}: цена пересекла ${b.condition.price} ${b.condition.op === "cross_up" ? "вверх" : "вниз"}`, frequency: b.frequency, expires_at: null, status: "active", drawing_client_id: b.drawing_client_id, note: null, last_triggered_at: null, triggers_count: 0, created_at: null, last_trigger: null };
      server.alerts!.push(a);
      return json(201, a);
    }
    if (p === "/v1/chart/ask") {
      const b = route.request().postDataJSON() as { question: string };
      return json(200, { text: `По данным графика: тренд D1 восходящий (структура). Вопрос: ${b.question.slice(0, 20)}`, source: "llm", footer: "Текст составлен по данным графика на 12:00 UTC, не является рекомендацией.", generated_at: "", facts_hash: "abc", prompt_version: "question.v1" });
    }
    if (p === "/v1/chart/explain") {
      const b = route.request().postDataJSON() as { pattern_id: number };
      return json(200, { text: `Бычье поглощение на BTCUSDT H4: значимый, подтверждён на закрытии свечи. Историческая отработка: 54 % случаев (n=120).`, source: b.pattern_id === 1 ? "template" : "llm", footer: "Текст составлен по данным графика на 12:00 UTC, не является рекомендацией.", generated_at: "", facts_hash: "abc", prompt_version: "explain_pattern.v1" });
    }
    // линия шеи двойной вершины уходит правее последней свечи: линия фигуры не должна сдвигать вид
    if (p === "/v1/chart/figures") {
      // у монеты дешевле цента фигуры в её масштабе (как уровни ниже): иначе линии около 100 растягивали шкалу
      const px = (v: string) => (u.searchParams.get("symbol") === SUBCENT ? (Number(v) * 0.00005).toFixed(7) : v);
      return json(200, {
        symbol: "BTCUSDT", tf: "4h", note: "",
        items: [
          { id: 5, type: "double_top", title: "Двойная вершина", direction: "down", status: "confirmed", scale: 2, start_t: T0 + 150 * 14400, end_t: T0 + 180 * 14400, known_t: T0 + 182 * 14400, confirm_t: T0 + 190 * 14400, invalidated_t: null, points: [[T0 + 150 * 14400, px("104")], [T0 + 165 * 14400, px("99")], [T0 + 180 * 14400, px("104.2")]], lines: [{ name: "neck", a: [T0 + 165 * 14400, px("99")], b: [T0 + 320 * 14400, px("99")] }], breakout_level: px("99"), target: px("94"), invalidation: px("104.2"), quality: 0.81, metrics: {}, source: "backfill", tf: "4h" },
          { id: 6, type: "channel_up", title: "Восходящий канал", direction: null, status: "forming", scale: 3, start_t: T0 + 250 * 14400, end_t: T0 + 290 * 14400, known_t: T0 + 293 * 14400, confirm_t: null, invalidated_t: null, points: [[T0 + 250 * 14400, px("100")], [T0 + 290 * 14400, px("105")]], lines: [{ name: "upper", a: [T0 + 250 * 14400, px("102")], b: [T0 + 300 * 14400, px("108")] }, { name: "lower", a: [T0 + 250 * 14400, px("98")], b: [T0 + 300 * 14400, px("104")] }], breakout_level: null, target: null, invalidation: null, quality: 0.72, metrics: {}, source: "live", tf: "4h" },
        ],
        stats: { double_top: { type: "double_top", title: "Двойная вершина", n: 48, low_n: false, success_rate: "0.4583", ci_low: "0.33", ci_high: "0.59", avg_move_atr: "2.1", avg_adverse_atr: "1.4", avg_bars_to_target: "7.5" } },
      });
    }
    if (p === "/v1/chart/patterns")
      return json(200, {
        symbol: "BTCUSDT", tf: "4h", horizon: 5, note: "",
        items: [
          { id: 1, type: "engulfing", title: "Бычье поглощение", direction: "up", status: "outcome_recorded", significant: true, t: T0 + 200 * 14400, start_t: T0 + 199 * 14400, confirm_t: T0 + 201 * 14400, price: "99", atr: "2", context: { prior_run: -4, volume_ratio: "1.6", sweep: true, trend: "down" }, source: "backfill", tf: "4h" },
          { id: 2, type: "doji", title: "Доджи", direction: null, status: "confirmed", significant: false, t: T0 + 280 * 14400, start_t: T0 + 280 * 14400, confirm_t: T0 + 281 * 14400, price: "101", atr: "2", context: {}, source: "live", tf: "4h" },
        ],
        stats: {
          engulfing: { type: "engulfing", title: "Бычье поглощение / Медвежье поглощение", horizon: 5, n: 120, low_n: false, success_rate: "0.5417", ci_low: "0.45", ci_high: "0.63", avg_move_atr: "1.3", avg_adverse_atr: "0.9" },
          doji: { type: "doji", title: "Доджи", horizon: 5, n: 7, low_n: true, success_rate: null, ci_low: null, ci_high: null, avg_move_atr: null, avg_adverse_atr: null },
        },
      });
    if (p === "/v1/chart/layers") {
      // у монеты дешевле цента уровни в её масштабе (цены около 0.005), у остальных — около 100
      const px = (v: string) => (u.searchParams.get("symbol") === SUBCENT ? (Number(v) * 0.00005).toFixed(7) : v);
      return json(200, {
        symbol: "BTCUSDT", tf: "4h",
        structure: { tf: "4h", strategy_version: "1.2.0", swings: [{ t: T0 + 100 * 14400, p: px("104"), kind: "high" }], events: [{ t: T0 + 120 * 14400, type: "bos", dir: "up", level: px("103.5"), from_t: T0 + 100 * 14400 }], zones: [{ kind: "ob", dir: "up", top: px("101"), bottom: px("99.5"), from_t: T0 + 120 * 14400, status: "active" }], levels: { pdh: px("106"), pdl: px("95"), pwh: px("108"), pwl: px("92") }, equal_levels: [], sweeps: [], bias: { bias: "long", d1_trend: "up", w1_trend: "up", ema50_d1: px("100") }, atr: px("1.8") },
        signals: [{ id: "s1", version: "1.2.0", dir: "short", t: T0 + 250 * 14400, status: "active", grade: "A", entry: px("102"), sl: px("104"), tp: [px("100"), px("98"), px("96")], zone: null, events: [] }],
        server_time: "",
      });
    }
    return json(404, { detail: "нет заглушки" });
  });
}

