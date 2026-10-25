// Заглушка API для e2e серверных страниц (лендинг, /stats): Next рендерит их на сервере,
// и перехват запросов в браузере до них не дотягивается. Запускается Playwright-ом на :8099.
import http from "node:http";

const m = (closed, wr, sum, open = 0, expired = 0) => ({
  signals: closed + open + expired, closed, expired, open, winrate: wr, avg_r: closed ? sum / closed : null, profit_factor: 1.5,
  expectancy: 0.3, max_drawdown_r: 4.2, max_losing_streak: 3, tp1_share: 0.6, tp2_share: 0.4, tp3_share: 0.2, sum_r: sum, avg_duration_hours: 30,
});
const eq = Array.from({ length: 20 }, (_, i) => ({ t: new Date(Date.UTC(2026, 6, 1 + i)).toISOString(), r: Math.round((i * 0.7 - (i % 3)) * 100) / 100 }));
const stats = (scope) => ({
  metrics: m(40, 0.47, 14.2, 2, 5),
  by_grade: { A: m(15, 0.55, 9), B: m(25, 0.42, 5.2) },
  by_symbol: { BTCUSDT: m(20, 0.5, 8), ETHUSDT: m(20, 0.45, 6.2) },
  by_month: { "2026-08": m(20, 0.5, 8), "2026-09": m(20, 0.45, 6.2) },
  by_direction: { up: m(40, 0.47, 14.2) },
  by_entry_type: { market: m(40, 0.47, 14.2) },
  r_histogram: [{ from: null, to: -1.5, n: 0 }, { from: -1.5, to: -1, n: 2 }, { from: -1, to: -0.5, n: 18 }, { from: -0.5, to: 0, n: 1 }, { from: 0, to: 0.5, n: 4 }, { from: 0.5, to: 1, n: 3 }, { from: 1, to: 1.5, n: 2 }, { from: 1.5, to: 2, n: 3 }, { from: 2, to: 3, n: 5 }, { from: 3, to: 4, n: 2 }, { from: 4, to: null, n: 0 }],
  equity: eq,
  worst_drawdowns: [{ start: "2026-08-02T00:00:00Z", trough: "2026-08-14T00:00:00Z", depth_r: 4.2 }],
  run: scope === "backtest" ? { id: 3, strategy_version: "1.1.0", period: ["2022-01-01", "2026-10-01"], instruments: 20, entry_type: "market", note: "walk-forward", created_at: null } : null,
  scope,
  generated_at: new Date().toISOString(),
});
const trade = (i) => ({ id: `s${i}`, symbol: i % 2 ? "BTCUSDT" : "ETHUSDT", direction: i % 3 ? "long" : "short", signal_time: new Date(Date.UTC(2026, 8, 1 + (i % 28), 8)).toISOString(), grade: "AB"[i % 2], score: 60 + i, entry: "100", stop: "98", rr_tp2: "2.5", entry_type: "market", status: i % 4 ? "closed_tp3" : "closed_sl", tp_hits: i % 4 ? 3 : 0, realized_r: i % 4 ? 2.9 : -1, mfe_r: 3, mae_r: 0.2, exit_time: null });

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const J = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const p = u.pathname;
    if (p === "/health") return J(200, { status: "ok", db: "ok", schema: "0005", candles: "123456", env: "test" });
    if (p === "/v1/stats") {
      const scope = u.searchParams.get("scope") ?? "live";
      if (scope === "live") return J(200, { ...stats("live"), metrics: m(0, null, 0), by_grade: {}, by_symbol: {}, by_month: {}, by_direction: {}, by_entry_type: {}, r_histogram: [], equity: [], worst_drawdowns: [] });
      const s = stats(scope);
      if (u.searchParams.get("grade") === "A") s.metrics = m(15, 0.55, 9);
      return J(200, s);
    }
    if (p === "/v1/stats/trades") {
      const scope = u.searchParams.get("scope") ?? "live";
      if (scope === "live") return J(200, { items: [], total: 0, limit: 50, offset: 0, scope });
      if (scope === "forward") return J(403, { detail: "построчная история форварда не публикуется" });
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const all = Array.from({ length: 73 }, (_, i) => trade(i));
      return J(200, { items: all.slice(offset, offset + 50), total: all.length, limit: 50, offset, scope });
    }
    if (p === "/v1/stats/runs") return J(200, [{ id: 3, strategy_version: "1.1.0", period: ["2022-01-01", "2026-10-01"], instruments: 20, entry_type: "market", closed: 40, note: "walk-forward", created_at: null }]);
    if (p === "/v1/strategies") return J(200, [{ id: 1, strategy: "trend-ob-retest", name: "Trend OB retest", version: "1.0.0", status: "forward", activated_at: null }, { id: 2, strategy: "trend-ob-retest", name: "Trend OB retest", version: "1.1.0", status: "forward", activated_at: null }]);
    if (p === "/v1/signals") return J(200, { items: [], sparklines: {}, prices: {}, total: 0, scope: "live", limit: 50, offset: 0 });
    if (p === "/v1/instruments") return J(200, [{ id: 1, symbol: "BTCUSDT", tick_size: "0.1" }]);
    J(404, { detail: "нет заглушки" });
  })
  .listen(8099);
