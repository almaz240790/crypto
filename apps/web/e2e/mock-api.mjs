// Заглушка API для e2e серверных страниц (лендинг, /stats): Next рендерит их на сервере,
// и перехват запросов в браузере до них не дотягивается. Запускается Playwright-ом на :8099.
//
// Сигналы (ADR-0013): по умолчанию заглушка — API с открытыми сигналами (SIGNALS_PUBLIC=true), как было до
// решения, — на этом проверяются прежние спеки. MOCK_SIGNALS=closed — API с закрытыми сигналами, как в бою
// сейчас (отдельный экземпляр на своём порту MOCK_PORT, проект signals-closed): лента, статистика сигналов и
// версии стратегии отвечают 404 всем, кроме admin и owner; их заглушка узнаёт по токену «staff» — его выдаёт
// перехват /v1/auth/refresh в signals.closed.spec; /status — без движка сигналов и трекера.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8099);
const CLOSED = process.env.MOCK_SIGNALS === "closed";
const STAFF = "Bearer staff";
const SIGNAL_COMPONENTS = new Set(["engine", "tracker"]);

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
  // как API: у live и форварда — комиссия и проскальзывание из ExecutionParams (задача 3); у бэктеста — свои в run
  ...(scope === "backtest" ? {} : { execution: { fee_rate: "0.0005", slippage: "0.0003" } }),
  without_costs: 0,
  scope,
  generated_at: new Date().toISOString(),
});
const EMPTY = { by_grade: {}, by_symbol: {}, by_month: {}, by_direction: {}, by_entry_type: {}, r_histogram: [], equity: [], worst_drawdowns: [] };
// Форвард — как на production в день выкладки: 1.0.0 переведена в архив, её форвард-сделки записаны;
// 1.1.0 в форварде, сделок меньше порога «мало данных»; 1.2.0 в форварде без сделок, у неё наибольший id —
// это версия по умолчанию. 0.9.0 — в архиве и без форвард-истории: в селектор не попадает.
const sv = (id, version, status) => ({ id, strategy: "trend-ob-retest", name: "Trend OB retest", version, status, activated_at: null });
const VERSIONS = [sv(1, "0.9.0", "archived"), sv(2, "1.0.0", "archived"), sv(3, "1.1.0", "forward"), sv(4, "1.2.0", "forward")];
const FORWARD_METRICS = { "1.0.0": m(40, 0.47, 14.2), "1.1.0": m(12, 0.5, 2.4) };
// сделки, записанные до вычета комиссий (задача 3): у 1.0.0 — все, у 1.1.0 — 5 из 12
const FORWARD_WITHOUT_COSTS = { "1.0.0": 40, "1.1.0": 5 };
// Другие состояния API форварда выбираются параметром run_id. Настоящий API у форварда run_id не читает,
// а страница /stats передаёт его в запрос как есть, поэтому у каждого состояния свой адрес запроса и
// кэш fetch в Next (60 с, ключ — адрес) их не смешивает. Без run_id — состояние дня выкладки:
// плашка включена и без даты (настройки API по умолчанию).
const FORWARD_STATES = {
  9001: { until: "2026-11-06" }, // FORWARD_NOTICE_UNTIL задан
  9002: { notice: false }, // FORWARD_NOTICE=false
  9003: { noForward: true }, // ни одной версии в статусе forward: 1.1.0 и 1.2.0 тоже в архиве
};
function forwardStats(u) {
  const state = FORWARD_STATES[u.searchParams.get("run_id")] ?? {};
  const all = VERSIONS.map((v) => (state.noForward ? { ...v, status: "archived" } : v));
  const ref = ({ activated_at: _, ...v }) => v;
  // как API: форвард только по одной версии; без версии — наибольший id в статусе forward
  const want = u.searchParams.get("version");
  const cur = want ? all.find((v) => v.version === want) : all.filter((v) => v.status === "forward").at(-1);
  if (want && !cur) return [404, { detail: "версия стратегии не найдена" }];
  const metrics = (cur && FORWARD_METRICS[cur.version]) ?? m(0, null, 0);
  const body = metrics.closed ? { ...stats("forward"), metrics } : { ...stats("forward"), ...EMPTY, metrics };
  return [200, {
    ...body,
    strategy_version: cur ? ref(cur) : null,
    // селектор: версии в форварде и ушедшие из него с записанной форвард-историей
    versions: all.filter((v) => v.status === "forward" || FORWARD_METRICS[v.version]).map(ref),
    notice: state.notice === false ? null : { invalid_until: state.until ?? null },
    low_n_threshold: 30,
    low_data: metrics.closed < 30,
    without_costs: (cur && FORWARD_WITHOUT_COSTS[cur.version]) ?? 0,
  }];
}
/** Закрыт ли путь сигналов (ADR-0013): как signals_viewer / signals_member в API. */
const signalPath = (p) => p.startsWith("/v1/signals") || p === "/v1/strategies" || (p.startsWith("/v1/stats") && !p.startsWith("/v1/stats/patterns") && !p.startsWith("/v1/stats/figures"));
const PATTERN = (type, title, n, rate) => ({ type, title, horizon: 5, n, low_n: n < 30, success_rate: n < 30 ? null : rate, ci_low: n < 30 ? null : "0.45", ci_high: n < 30 ? null : "0.60", avg_move_atr: "1.2", avg_adverse_atr: "0.8", period_start: "2022-01-01", period_end: "2026-10-01" });
const STATUS = {
  status: "degraded",
  generated_at: "2026-10-25T10:01:00+00:00",
  components: [
    { key: "data", title: "Данные с биржи", status: "ok", detail: "heartbeat 12 с назад, 1m-свеча 40 с назад", uptime_7d: 100 },
    { key: "candles", title: "Свечи H4", status: "degraded", detail: "нет закрытия по 1 из 20 инструментов", uptime_7d: 100 },
    { key: "engine", title: "Движок сигналов", status: "ok", detail: "прогон по H4 08:00", uptime_7d: 99.8 },
    { key: "tracker", title: "Трекер сигналов", status: "ok", detail: "heartbeat 5 с назад", uptime_7d: 100 },
    { key: "notifier", title: "Уведомления", status: "ok", detail: "heartbeat 20 с назад", uptime_7d: 100 },
    { key: "api", title: "API и база", status: "ok", detail: "БД и Redis отвечают", uptime_7d: 100 },
  ],
  incidents: [
    { component: "candles", severity: "degraded", message: "нет закрытия по 1 из 20 инструментов", opened_at: "2026-10-25T09:58:00+00:00", closed_at: null },
    { component: "engine", severity: "down", message: "движок не отработал по 20 из 20 инструментов", opened_at: "2026-10-23T04:02:00+00:00", closed_at: "2026-10-23T04:31:00+00:00" },
  ],
};
// как hide_signal_components в API: без движка и трекера и их инцидентов
const PUBLIC_STATUS = CLOSED
  ? { ...STATUS, components: STATUS.components.filter((c) => !SIGNAL_COMPONENTS.has(c.key)), incidents: STATUS.incidents.filter((i) => !SIGNAL_COMPONENTS.has(i.component)) }
  : STATUS;
const trade = (i) => ({ id: `s${i}`, symbol: i % 2 ? "BTCUSDT" : "ETHUSDT", direction: i % 3 ? "long" : "short", signal_time: new Date(Date.UTC(2026, 8, 1 + (i % 28), 8)).toISOString(), grade: "AB"[i % 2], score: 60 + i, entry: "100", stop: "98", rr_tp2: "2.5", entry_type: "market", status: i % 4 ? "closed_tp3" : "closed_sl", tp_hits: i % 4 ? 3 : 0, realized_r: i % 4 ? 2.9 : -1, mfe_r: 3, mae_r: 0.2, exit_time: null });

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const J = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const p = u.pathname;
    const staff = req.headers.authorization === STAFF;
    if (p === "/v1/features") return J(200, { signals: !CLOSED || staff });
    if (CLOSED && !staff && signalPath(p)) return J(404, { detail: "Not Found" });
    if (p === "/v1/stats/patterns")
      return J(200, {
        scope: u.searchParams.get("scope") ?? "backfill", tf: u.searchParams.get("tf") ?? "4h", horizon: 5, with_context: null, note: "", computed_at: "2026-10-25T08:00:00+00:00",
        items: [PATTERN("engulfing", "Бычье поглощение / Медвежье поглощение", 412, "0.5340"), PATTERN("hammer", "Молот", 233, "0.5107"), PATTERN("doji", "Доджи", 12, null)],
      });
    if (p === "/v1/stats/figures") return J(200, { scope: "backfill", tf: u.searchParams.get("tf") ?? "4h", horizon: 20, items: [], note: "", computed_at: null });
    if (p === "/health") return J(200, { status: "ok", db: "ok", schema: "0005", candles: "123456", env: "test" });
    if (p === "/v1/stats") {
      const scope = u.searchParams.get("scope") ?? "live";
      if (scope === "live") return J(200, { ...stats("live"), ...EMPTY, metrics: m(0, null, 0) });
      if (scope === "forward") return J(...forwardStats(u));
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
    if (p === "/v1/strategies") return J(200, VERSIONS);
    if (p === "/v1/signals") return J(200, { items: [], sparklines: {}, prices: {}, total: 0, scope: "live", limit: 50, offset: 0 });
    if (p === "/status") return J(200, PUBLIC_STATUS);
    if (p === "/v1/instruments") return J(200, [{ id: 1, symbol: "BTCUSDT", tick_size: "0.1" }]);
    J(404, { detail: "нет заглушки" });
  })
  .listen(PORT);
