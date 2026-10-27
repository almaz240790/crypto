import type { Page } from "@playwright/test";

/** Заглушки API терминала для e2e (план 3.17). */
const T0 = 1_792_000_000 - (1_792_000_000 % 14400);
const candle = (i: number) => {
  const o = 100 + Math.sin(i / 7) * 5;
  const c = o + Math.cos(i / 5);
  return { t: T0 + i * 14400, o: o.toFixed(2), h: (Math.max(o, c) + 1).toFixed(2), l: (Math.min(o, c) - 1).toFixed(2), c: c.toFixed(2), v: "1000", open: false };
};

export type MockServer = { drawings: Record<string, unknown>[]; layout: Record<string, unknown> | null; layouts?: Record<string, Record<string, unknown>>; alerts?: Record<string, unknown>[] };

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
    if (p === "/v1/instruments") return json(200, [{ symbol: "BTCUSDT", tick_size: "0.1" }, { symbol: "ETHUSDT", tick_size: "0.01" }]);
    if (p === "/v1/chart/candles") {
      const tf = u.searchParams.get("tf");
      if (["1m", "5m", "15m"].includes(tf ?? "") && !authed) return json(403, { detail: "таймфреймы 1m–15m доступны на тарифе Pro" });
      const before = u.searchParams.get("before");
      const n = before ? 500 : 300;
      const items = Array.from({ length: n }, (_, i) => candle(before ? i - 500 : i));
      return json(200, { symbol: "BTCUSDT", tf, candles: items, current: { ...candle(n), t: T0 + n * 14400, open: true }, has_older: !before, tick_size: "0.1", server_time: "" });
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
    if (p === "/v1/chart/derivatives")
      return json(200, { symbol: "BTCUSDT", tf: "4h", funding: [{ t: T0 + 100 * 14400, v: "0.0001" }, { t: T0 + 200 * 14400, v: "0.00012" }], funding_current: "0.00012", next_funding_t: Math.floor(Date.now() / 1000) + 3600, oi: [{ t: T0 + 100 * 14400, v: "1000000" }], liquidations: [{ t: T0 + 100 * 14400, long: "1000", short: "2000" }], liquidations_note: "" });
    if (p === "/v1/alerts" && route.request().method() === "GET") return json(200, { items: server.alerts, active: server.alerts!.length, limit: 50, types: [], frequencies: [] });
    if (p === "/v1/alerts" && route.request().method() === "POST") {
      const b = route.request().postDataJSON() as { symbol: string; type: string; condition: { op: string; price: string }; frequency: string; drawing_client_id: string | null };
      const a = { id: server.alerts!.length + 1, symbol: b.symbol, timeframe: null, type: b.type, condition: b.condition, text: `${b.symbol}: цена пересекла ${b.condition.price} ${b.condition.op === "cross_up" ? "вверх" : "вниз"}`, frequency: b.frequency, expires_at: null, status: "active", drawing_client_id: b.drawing_client_id, note: null, last_triggered_at: null, triggers_count: 0, created_at: null, last_trigger: null };
      server.alerts!.push(a);
      return json(201, a);
    }
    if (p === "/v1/chart/explain") {
      const b = route.request().postDataJSON() as { pattern_id: number };
      return json(200, { text: `Бычье поглощение на BTCUSDT H4: значимый, подтверждён на закрытии свечи. Историческая отработка: 54 % случаев (n=120).`, source: b.pattern_id === 1 ? "template" : "llm", footer: "Текст составлен по данным графика на 12:00 UTC, не является рекомендацией.", generated_at: "", facts_hash: "abc", prompt_version: "explain_pattern.v1" });
    }
    if (p === "/v1/chart/figures")
      return json(200, {
        symbol: "BTCUSDT", tf: "4h", note: "",
        items: [
          { id: 5, type: "double_top", title: "Двойная вершина", direction: "down", status: "confirmed", scale: 2, start_t: T0 + 150 * 14400, end_t: T0 + 180 * 14400, known_t: T0 + 182 * 14400, confirm_t: T0 + 190 * 14400, invalidated_t: null, points: [[T0 + 150 * 14400, "104"], [T0 + 165 * 14400, "99"], [T0 + 180 * 14400, "104.2"]], lines: [{ name: "neck", a: [T0 + 165 * 14400, "99"], b: [T0 + 210 * 14400, "99"] }], breakout_level: "99", target: "94", invalidation: "104.2", quality: 0.81, metrics: {}, source: "backfill", tf: "4h" },
          { id: 6, type: "channel_up", title: "Восходящий канал", direction: null, status: "forming", scale: 3, start_t: T0 + 250 * 14400, end_t: T0 + 290 * 14400, known_t: T0 + 293 * 14400, confirm_t: null, invalidated_t: null, points: [[T0 + 250 * 14400, "100"], [T0 + 290 * 14400, "105"]], lines: [{ name: "upper", a: [T0 + 250 * 14400, "102"], b: [T0 + 300 * 14400, "108"] }, { name: "lower", a: [T0 + 250 * 14400, "98"], b: [T0 + 300 * 14400, "104"] }], breakout_level: null, target: null, invalidation: null, quality: 0.72, metrics: {}, source: "live", tf: "4h" },
        ],
        stats: { double_top: { type: "double_top", title: "Двойная вершина", n: 48, low_n: false, success_rate: "0.4583", ci_low: "0.33", ci_high: "0.59", avg_move_atr: "2.1", avg_adverse_atr: "1.4", avg_bars_to_target: "7.5" } },
      });
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
    if (p === "/v1/chart/layers")
      return json(200, {
        symbol: "BTCUSDT", tf: "4h",
        structure: { tf: "4h", strategy_version: "1.2.0", swings: [{ t: T0 + 100 * 14400, p: "104", kind: "high" }], events: [{ t: T0 + 120 * 14400, type: "bos", dir: "up", level: "103.5", from_t: T0 + 100 * 14400 }], zones: [{ kind: "ob", dir: "up", top: "101", bottom: "99.5", from_t: T0 + 120 * 14400, status: "active" }], levels: { pdh: "106", pdl: "95", pwh: "108", pwl: "92" }, equal_levels: [], sweeps: [], bias: { bias: "long", d1_trend: "up", w1_trend: "up", ema50_d1: "100" }, atr: "1.8" },
        signals: [{ id: "s1", version: "1.2.0", dir: "short", t: T0 + 250 * 14400, status: "active", grade: "A", entry: "102", sl: "104", tp: ["100", "98", "96"], zone: null, events: [] }],
        server_time: "",
      });
    return json(404, { detail: "нет заглушки" });
  });
}

