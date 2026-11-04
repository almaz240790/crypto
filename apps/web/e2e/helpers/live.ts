import type { Page, WebSocketRoute } from "@playwright/test";

/**
 * Заглушка /v1/ws для e2e живой цены (ADR-0010) — одна на все спеки. Отвечает на ping: без pong сторож LiveSocket
 * считает сокет полуоткрытым и переподключается каждые ~10 с, а каждое переподключение — лишний запрос истории.
 * Умеет: тики каждые `every` мс по подписанным символам (вкл./выкл.: state.ticks), полуоткрытый сокет (state.halfOpen:
 * ни тиков, ни pong, подписка без ответа), отказ в соединении (state.refuse: сокета нет), сообщение сервера (send) и
 * закрытие текущего соединения сервером (close). Номер тика общий для всех соединений (время тика не идёт назад после
 * переподключения, как у сервера). Пишет подписки (subs) и соединения (sockets).
 */
export type LiveMock = {
  state: { ticks: boolean; halfOpen: boolean; refuse: boolean; k: number; sent: number; last: Map<string, number> };
  sockets: WebSocketRoute[];
  subs: string[][];
  /** Сообщение сервера во все открытые соединения. */
  send(m: unknown): void;
  /** Сервер закрыл последнее открытое соединение. */
  close(): Promise<void>;
  dispose(): void;
};

export type LiveMockOptions = {
  /** Тики сразу после подписки (по умолчанию — да). */
  ticks?: boolean;
  /** Время k-го тика, unix с. */
  at: (k: number) => number;
  /** Цена k-го тика символа (по умолчанию 100 + k · 0.1). */
  price?: (k: number, symbol: string) => number;
  every?: number;
};

const iso = (sec: number) => new Date(sec * 1000).toISOString();

export async function liveSocket(page: Page, o: LiveMockOptions): Promise<LiveMock> {
  const sockets: WebSocketRoute[] = [];
  const subs: string[][] = [];
  const open = new Map<WebSocketRoute, string[]>();
  const state = { ticks: o.ticks ?? true, halfOpen: false, refuse: false, k: 0, sent: 0, last: new Map<string, number>() };
  const price = o.price ?? ((k: number) => 100 + k * 0.1);
  await page.routeWebSocket(/\/v1\/ws/, (ws) => {
    if (state.refuse) {
      void ws.close();
      return;
    }
    sockets.push(ws);
    open.set(ws, []);
    ws.onClose(() => open.delete(ws));
    ws.onMessage((raw) => {
      if (state.halfOpen) return;
      const m = JSON.parse(String(raw)) as { sub?: string[]; ping?: number };
      if (Array.isArray(m.sub)) {
        open.set(ws, m.sub);
        subs.push(m.sub);
        ws.send(JSON.stringify({ t: "subscribed", n: m.sub.length }));
      } else if (m.ping) ws.send('{"t":"pong"}');
    });
  });
  const timer = setInterval(() => {
    if (!state.ticks || state.halfOpen) return;
    const live = [...open].filter(([, mine]) => mine.length > 0);
    if (!live.length) return;
    const k = ++state.k;
    for (const [ws, mine] of live) {
      for (const s of mine) {
        const p = price(k, s);
        state.last.set(s, p);
        state.sent++;
        ws.send(JSON.stringify({ t: "tick", s, p: p.toFixed(1), at: iso(o.at(k)) }));
      }
    }
  }, o.every ?? 250);
  // упавший тест не вызовет dispose — таймер тиков не переживает страницу
  page.once("close", () => clearInterval(timer));
  return {
    state,
    sockets,
    subs,
    send: (m) => {
      for (const ws of open.keys()) ws.send(JSON.stringify(m));
    },
    close: async () => {
      const ws = [...open.keys()].at(-1);
      if (!ws) return;
      open.delete(ws);
      await ws.close();
    },
    dispose: () => clearInterval(timer),
  };
}
