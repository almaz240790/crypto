"use client";

/**
 * Источник живой цены символа (ADR-0010, дополнение «цена с биржи»): биржа напрямую (BinanceFeed) или сервер (/v1/ws).
 * Одна модель — один LiveBar: события обоих источников идут в тот же автомат через тот же API (tick, forming, candle).
 *
 * - Биржа свежа (соединение живо и по символу после подписки пришли данные; тихий рынок без сделок свежести не снимает)
 *   — она основной источник: её сделки, формирующиеся и закрытые минуты идут в LiveBar, тики, формирующиеся минуты и
 *   цены закрытых минут сервера по этому символу пропускаются (сокет сервера остаётся — сигналы, статусы, запасной
 *   источник). Тик сервера с новой ценой, которой у биржи нет дольше 3 с, — улика отставания: символ с сервера сразу.
 * - Биржа недоступна, соединение мёртво или отстало — те же события сервера, как раньше. Переход незаметен: автомат не
 *   откатывает close к тику старше последнего, объём минуты не уменьшает, high/low только расширяет.
 * - Закрытые минуты сервера проходят всегда: закрытая минута — окончательная из любого источника, повтор автомат
 *   пропускает (не новее последней закрытой), а минуту, пропущенную биржей (переподключение), сервер дописывает без догона.
 *
 * Цена в шапке — HeaderPrice: шапка подписана на неё сама (useHeaderPrice), не чаще раза в HEADER_PRICE_MS, а
 * терминал на тиках не перерисовывается.
 */
import type { LiveStep } from "@platform/charts";
import { useSyncExternalStore } from "react";
import type { BinanceListener } from "./binanceFeed";
import type { LiveBar } from "./liveBar";
import { isNewer, PriceBatch, type LiveCandle, type LivePrice, type LiveTick } from "./useLive";

export type PriceSource = "binance" | "server";

/** Цена в шапке — не чаще (≤ 4 обновлений React в секунду); график получает каждую сделку сразу. */
export const HEADER_PRICE_MS = 250;

/**
 * Живая цена символа для шапки и ячейки мультичарта: внешнее хранилище для useSyncExternalStore. Цена не новее
 * последней порции истории (restAt — время сервера ответа) не показывается — шапка берёт закрытие свечи.
 */
export class HeaderPrice {
  private shown: LivePrice | null = null;
  private latest: LivePrice | null = null;
  private restAt = 0;
  private readonly fns = new Set<() => void>();
  private readonly batch: PriceBatch;

  constructor(every = HEADER_PRICE_MS, clock?: () => number) {
    this.batch = new PriceBatch(
      (b) => {
        if (!b.p) return;
        this.shown = b.p;
        this.notify();
      },
      every,
      clock,
    );
  }

  push(p: LivePrice): void {
    if (!isNewer(this.latest ?? undefined, p)) return;
    this.latest = p;
    this.batch.push("p", p);
  }

  /** Время сервера последней порции истории, unix с (0 — неизвестно). */
  setRestAt(sec: number): void {
    if (sec === this.restAt) return;
    this.restAt = sec;
    this.notify();
  }

  /** Цена для React (меняется не чаще HEADER_PRICE_MS); null — живой нет. */
  readonly get = (): string | null => this.visible(this.shown);

  /** Самая свежая цена, не дожидаясь пачки (черновик алерта, копия рисунка). */
  now(): string | null {
    return this.visible(this.latest);
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.fns.add(fn);
    return () => {
      this.fns.delete(fn);
    };
  };

  dispose(): void {
    this.batch.dispose();
  }

  private visible(p: LivePrice | null): string | null {
    if (!p) return null;
    return Date.parse(p.at) / 1000 <= this.restAt ? null : p.p;
  }

  private notify(): void {
    for (const fn of this.fns) fn();
  }
}

const NO_SUB = () => () => {};
const NONE = () => null;

/** Живая цена для шапки: перерисовывается только подписанный компонент. */
export function useHeaderPrice(store: HeaderPrice | null): string | null {
  return useSyncExternalStore(store?.subscribe ?? NO_SUB, store?.get ?? NONE, NONE);
}

/** Куда идут принятые события: шаг LiveBar, цена шапки, смена источника. */
export type MuxOut = {
  step: (s: LiveStep | null) => void;
  price: (p: LivePrice) => void;
  source: (s: PriceSource) => void;
};

type Bar = Pick<LiveBar, "started" | "tick" | "forming" | "candle">;

/**
 * Выбор источника событий одного символа для одного LiveBar. Выход (attach) подключается в эффекте: шаги LiveBar
 * уходят в состояние React и график, а не во время рендера.
 */
export class LiveMux {
  private src: PriceSource | null = null;
  private out: MuxOut | null = null;
  /** Слушатель BinanceFeed: события биржи принимаются всегда — раз они идут, биржа свежа. */
  readonly binance: BinanceListener;

  constructor(
    readonly symbol: string,
    private readonly bar: Bar,
    /** Биржа — основной источник символа сейчас (BinanceFeed.isFresh). */
    private readonly binanceFresh: () => boolean,
    /** Тик сервера, пока биржа свежа: улика её отставания (BinanceFeed.server) — символ с сервера сразу. */
    private readonly serverSeen: (t: LiveTick) => void = () => {},
  ) {
    this.binance = {
      tick: (t) => {
        if (t.s !== this.symbol) return;
        this.out?.price({ p: t.p, at: t.at });
        // до загрузки свечей сделки не копим: kline (раз в 250 мс) несёт high/low и close минуты
        if (this.bar.started) this.step(this.bar.tick(t));
      },
      forming: (c) => {
        this.closePrice(c);
        this.step(this.bar.forming(c));
      },
      candle: (c) => {
        this.closePrice(c);
        this.step(this.bar.candle(c));
      },
      fresh: (on) => this.setSource(on ? "binance" : "server"),
    };
  }

  /** Куда отдавать принятые события (null — отключить); текущий источник отдаётся сразу. */
  attach(out: MuxOut | null): void {
    this.out = out;
    if (out && this.src) out.source(this.src);
  }

  get source(): PriceSource {
    return this.src ?? "server";
  }

  /**
   * Тик сервера — только если биржа не свежа. Пока свежа, тик — улика: сервер видит новую цену, которой у биржи нет
   * дольше BEHIND_MS, — биржа отстала, и этот же тик уже идёт в свечу и шапку.
   */
  readonly serverTick = (t: LiveTick): void => {
    if (t.s !== this.symbol) return;
    if (this.binanceFresh()) this.serverSeen(t);
    if (this.binanceFresh()) return;
    this.out?.price({ p: t.p, at: t.at });
    this.step(this.bar.tick(t));
  };

  /** Формирующаяся минута сервера (снимок REST-опроса) — только если биржа не свежа: её снимок новее. */
  readonly serverForming = (c: LiveCandle): void => {
    if (c.s !== this.symbol || this.binanceFresh()) return;
    this.step(this.bar.forming(c));
  };

  /** Закрытая минута сервера — всегда (окончательная; повтор автомат пропускает, пропущенную биржей — дописывает). */
  readonly serverCandle = (c: LiveCandle): void => {
    this.step(this.bar.candle(c));
  };

  /** Цена закрытой минуты сервера (`price`) — в шапку, только если биржа не свежа. */
  readonly serverPrice = (s: string, p: LivePrice): void => {
    if (s !== this.symbol || this.binanceFresh()) return;
    this.out?.price(p);
  };

  /**
   * Close kline биржи — цена на момент события (at): шапка совпадает с close свечи, даже если поток сделок отстал;
   * сделка старше kline цену шапки не откатывает (HeaderPrice — только более свежие).
   */
  private closePrice(c: LiveCandle): void {
    if (c.s === this.symbol && c.c.at) this.out?.price({ p: c.c.c, at: c.c.at });
  }

  /** Шаг LiveBar (график уже обновлён его подписчиком) — в состояние React. */
  private step(s: LiveStep | null): void {
    this.out?.step(s);
  }

  private setSource(s: PriceSource): void {
    if (s === this.src) return;
    this.src = s;
    this.out?.source(s);
  }
}
