"""Сервис market-data (этап 2.1, план 6.1/6.3): живые свечи и деривативы Binance USDT-M → БД.

- WebSocket рыночных потоков (``WS_URL`` — ``/market/ws``, подписка командой SUBSCRIBE):
  kline_1m / kline_4h / kline_1d / kline_1w и forceOrder (ликвидации) по всем активным
  инструментам; до ``STREAMS_PER_CONNECTION`` потоков на соединение.
- Свечи пишутся батчами раз в секунду (upsert); текущая незакрытая свеча хранится с
  ``is_closed = false``, на закрытии перезаписывается с ``true`` и публикуется в Redis
  канал ``candles.closed`` (планировщик слушает 4h, трекер — 1m) — только после того, как
  закрытая строка записана в БД. Незакрытые 4h/1d/1w пишутся не чаще раза в
  ``FORMING_HTF_EVERY`` секунд (Binance шлёт их на каждой сделке), 1m и закрытые — сразу. Ошибка
  записи возвращает строки, события и ликвидации в буфер; на остановке — последняя запись всего.
- Ликвидации агрегируются по минутам: SELL = ликвидация лонга, BUY = шорта; сумма в USDT.
- Раз в ``DERIVATIVES_EVERY`` секунд — REST: funding, OI (1h), long/short (1h).
- Точка сверки (``last_closed``) пары (инструмент, tf) — последняя закрытая свеча, о которой
  ``candles.closed`` уже есть (или не нужно); при старте — последняя закрытая строка в БД.
- При старте — догрузка (``backfill``) по REST от последней закрытой свечи в БД (или от самой старой
  незакрытой, которой пора быть закрытой). Закрытые пишутся в БД сразу; свечи новее точки сверки,
  закрывшиеся не раньше ``LATE_CLOSE_MAX`` назад (закрылись, пока сервиса не было), — ещё и в
  ``candles.closed``, после записи. Старше — только в БД (история, не событие).
- Когда по соединению пошли данные (после старта и после обрыва), — сверка его инструментов
  (``resync``, в фоне): по REST всё от точки сверки до сейчас, так же. Binance после подписки шлёт
  только текущую свечу: закрывшаяся, пока соединения не было, иначе осталась бы незакрытой и без
  ``candles.closed``. Пока сверка не дошла до пары, её закрытия из стрима и опроса ждут (``hold``,
  не дольше ``HOLD_MAX``): более новая закрытая строка не попадает в БД раньше пропущенной — трекер
  идёт от последней обработанной свечи и пропустил бы её навсегда. Молчащий стрим не сверяется:
  его инструменты держит REST-опрос.
- Живые цены (план 2A.3, ADR-0010): раз в ``TICKER_EVERY`` секунд — одно сообщение в Redis канал
  ``prices.live`` с изменившимися ценами ``{"at": ISO, "p": {SYMBOL: "цена"}}``, каждое
  ``TICKER_FULL_EVERY``-е — со всеми (``"full": true``); все цены — ещё и в ключ ``prices:last``.
  Источник — kline 1m стрима, пока он у инструмента свежий, иначе один REST-запрос
  ``/fapi/v1/ticker/price`` на все символы (вес 2); инструменты без свежей цены — в ``"stale"``.
  Формирующаяся минутная свеча (из стрима или из REST-опроса раз в 15 с) уходит в тот же канал
  ``{"at": ISO, "c": {SYMBOL: {t, o, h, l, c, v, at}}}`` (``at`` внутри — момент снимка) — у текущей
  свечи терминала верные high, low и объём. В БД тики не пишутся.
- Heartbeat в Redis ``market_data:heartbeat`` (unix time) — для /health и алертов. Тикер и запись
  стартуют до стартовой догрузки; упавшая основная задача останавливает процесс (его перезапустят).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import signal as os_signal
import sys
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import redis.asyncio as aioredis
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from app.config import settings
from app.db import SessionLocal
from app.forward import UPSERT_CHUNK, _refresh_derivatives, upsert_candles
from app.models import Instrument, LiquidationRow
from engine.candles import Candle, Timeframe
from engine.data.binance import BinanceHistory

log = logging.getLogger("market_data")

WS_URL = "wss://fstream.binance.com/market/ws"
"""Рыночные потоки USDⓈ-M Futures: kline и forceOrder (как и aggTrade, markPrice) Binance
перенесла в категорию «market» — адрес ``/market/ws``. Потоки фьючерсов разделены по адресам:
``/public`` — bookTicker и depth, ``/market`` — kline, aggTrade, markPrice, forceOrder,
``/private`` — данные аккаунта (listenKey). Подключение без потоков в URL; подписка командой
SUBSCRIBE — Binance подтверждает её ответом ``{"result": null, "id": 1}``, дальше события
приходят как есть (raw).

Проверка из контейнера 2026-11-05 (websockets, SUBSCRIBE на kline и forceOrder): старый
``wss://fstream.binance.com/ws`` подписку подтверждает ``{"result": null}``, но данных не шлёт
ни одного; ``/market/ws`` — kline (61 сообщение за 8 с на 4 потока) и ликвидации
(``!forceOrder@arr`` — 23 за 25 с); ``/public/ws`` — ни того, ни другого. Поэтому на хостинге
воркер со старым адресом работал в режиме REST (``klines=0``) и ликвидации не приходили."""
STREAMS_PER_CONNECTION = 150
"""Кратно 5 (4 kline + forceOrder на инструмент): потоки инструмента — в одном соединении."""
SILENCE_TIMEOUT = 60
RECONNECT_MIN = 1.0
RECONNECT_MAX = 60.0
"""Пауза перед переподключением: с ``RECONNECT_MIN``, вдвое после каждой попытки без данных."""
POLL_EVERY = 15
"""REST-опрос инструментов, у которых стрим молчит дольше ``SILENCE_TIMEOUT``: 1m каждые 15 с,
старшие tf — каждую минуту (7 запросов веса 1 на инструмент в минуту). Ликвидаций по REST нет."""
POLL_WORKERS = 2
RATE_LIMIT_PAUSE = 120
TIMEFRAMES = (Timeframe.M1, Timeframe.H4, Timeframe.D1, Timeframe.W1)
FLUSH_EVERY = 1.0
FORMING_HTF_EVERY = 5.0
"""Незакрытая 4h/1d/1w инструмента пишется не чаще раза в столько секунд: Binance шлёт все четыре
kline на каждой сделке, и раньше 3/4 записей (около 70 строк в секунду на 59 инструментов) были
перезаписью этих строк. Терминал берёт идущий интервал из закрытых минут; хранимая свеча нужна
ему, только когда минут с начала интервала нет. Минутные и закрытые строки — каждую запись."""
FINAL_FLUSH_TIMEOUT = 10.0
"""Остановка: столько ждём последнюю запись (буфер, ликвидации текущей минуты, закрытые)."""
FLUSH_LOG_EVERY = 60
"""Ошибки записи в БД (при сбое — каждую секунду) пишутся в лог только первая и каждая 60-я."""
BUFFER_MAX = 50_000
"""Строк в буфере записи, пока БД недоступна (≈ 14 ч минут на 59 инструментов); сверх — самые
старые отбрасываются вместе с событиями, их догрузит ``backfill`` после переподключения."""
REPAIR_WINDOW = 1500
"""Догрузка смотрит назад на столько свечей tf в поисках незакрытой строки, которой пора быть
закрытой (её закрытие не пришло — например, свеча закрылась, пока не было соединения)."""
LATE_CLOSE_MAX = 1800
"""Свеча, закрывшаяся без соединения или без сервиса (её нашли догрузка и сверка), получает
``candles.closed``, если закрылась не раньше стольких секунд назад; старше — только строка в БД.
Это история, а не событие: трекер и планировщик догоняют по БД, ценовой алерт по старой минуте не
срабатывает (проверяет последнюю), а планировщик по давней 4h выдал бы устаревший сигнал."""
HOLD_MAX = 180.0
"""Удержание закрытий пары на время сверки соединения — не дольше стольких секунд (сверка 30
инструментов — 120 запросов, обычно 30–40 с). Не сверенная пара (ошибка REST, пауза 418/429)
ждёт догрузки опросом, но не дольше: дальше её закрытия идут без неё."""
DERIVATIVES_EVERY = 300
HEARTBEAT_KEY = "market_data:heartbeat"
STATUS_KEY = "market_data:status"
REPORT_EVERY = 60
CHANNEL_CLOSED = "candles.closed"
EVENTS_MAX = 10_000
"""Закрытые свечи, не ушедшие в Redis (он недоступен), ждут следующей записи — не больше этого."""
REDIS_LOG_EVERY = 60
"""Ошибки Redis у записи (при сбое — каждую секунду) пишутся в лог только первая и каждая 60-я."""

# --- живые цены (план 2A.3, ADR-0010) ------------------------------------------------------------
CHANNEL_PRICES = "prices.live"
PRICES_KEY = "prices:last"
"""Последние цены целиком ``{"at", "p"}``: хаб API читает их при (пере)подписке на канал."""
PRICES_KEY_TTL = 30
TICKER_URL = "https://fapi.binance.com/fapi/v1/ticker/price"
TICKER_EVERY = 1.0
"""Бюджет веса Binance (лимит 2400/мин на IP; истина — ``used_weight_1m`` в статусе, заголовок
``X-MBX-USED-WEIGHT-1M``). Тикер без symbol — вес 2, раз в секунду = 120/мин. REST-опрос свечей
молчащих инструментов — 7 запросов веса 1 на инструмент в минуту, т. е. 7·N: при N = 59 — 413,
вместе с тикером 533/мин (22 %), при N = 85 — 715/мин (30 %). Молчащий стрим переподключается без
догрузки (её заменяет опрос) и с растущей до 60 с задержкой. Догрузка после обрыва соединения с
данными — 4 запроса на инструмент этого соединения (≤ 4·30 = 120), разово; на паузе 418/429 не идёт.
Деривативы (fundingRate и futures/data/*) считаются в отдельных лимитах."""
TICKER_TIMEOUT = 3.0
TICKER_WS_FRESH = 5.0
"""kline 1m инструмента по WebSocket свежее этого — цена из стрима; иначе — из REST-тикера."""
TICKER_FULL_EVERY = 10
"""Каждое такое сообщение тикера — со всеми ценами: хаб, пропустивший сообщения, догонит."""
TICKER_LOG_EVERY = 60
"""Ошибки тикера (при сбое — каждую секунду) пишутся в лог только первая и каждая 60-я."""


def _dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


def _num(x: Decimal) -> str:
    """Цена строкой без хвостовых нулей и без экспоненты: «67000.1», «100», «0.0000123»."""
    return format(x.normalize(), "f")


def _ohlcv(c: Candle) -> dict[str, Any]:
    """Минутная свеча для Redis: время — unix с начала минуты, цены и объём строками."""
    return {
        "t": int(c.open_time.timestamp()),
        "o": _num(c.open),
        "h": _num(c.high),
        "l": _num(c.low),
        "c": _num(c.close),
        "v": _num(c.volume),
    }


def _forming(c: Candle, at: str) -> dict[str, Any]:
    """Формирующаяся минутная свеча для канала ``prices.live``; ``at`` — момент снимка: тик новее
    снимка его close не откатывает (ADR-0010)."""
    return {**_ohlcv(c), "at": at}


def _now_iso() -> str:
    return datetime.now(tz=UTC).isoformat(timespec="milliseconds")


def _dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"))


def _row(inst_id: int, tf: str, c: Candle, closed: bool) -> dict[str, Any]:
    """Строка таблицы ``candles`` для буфера записи."""
    return {
        "instrument_id": inst_id,
        "timeframe": tf,
        "open_time": c.open_time,
        "open": c.open,
        "high": c.high,
        "low": c.low,
        "close": c.close,
        "volume": c.volume,
        "quote_volume": c.quote_volume,
        "trades": c.trades,
        "is_closed": closed,
    }


def _event(symbol: str, inst_id: int, tf: str, c: Candle) -> dict[str, Any]:
    """Событие ``candles.closed``; у минуты — свеча целиком: хабу /v1/ws не нужно читать её из БД
    (ADR-0010)."""
    event: dict[str, Any] = {
        "symbol": symbol,
        "instrument_id": inst_id,
        "tf": tf,
        "open_time": c.open_time.isoformat(),
        "close_time": (c.open_time + Timeframe(tf).delta).isoformat(),
        "close": format(c.close.normalize(), "f"),
    }
    if tf == Timeframe.M1.value:
        event["candle"] = _ohlcv(c)
    return event


class MarketData:
    def __init__(self, redis: Any = None) -> None:
        self.redis = redis if redis is not None else aioredis.from_url(settings.redis_url)
        self.symbols: dict[str, int] = {}  # symbol → instrument_id
        self.candle_buffer: dict[tuple[int, str, datetime], dict[str, Any]] = {}
        self.liq_buffer: dict[tuple[int, datetime], list[Decimal]] = defaultdict(
            lambda: [Decimal(0), Decimal(0)]
        )
        self.closed_events: list[dict[str, Any]] = []
        """Закрытые свечи, чьи строки ещё в буфере записи: в ``candles.closed`` — после записи."""
        self.ready_events: list[dict[str, Any]] = []
        """Закрытые свечи, уже записанные в БД, ждут публикации (Redis недоступен — копятся)."""
        self._lock = threading.Lock()
        """Буфер записи и ``closed_events`` меняют поток событий и потоки REST (опрос, сверка)."""
        self.htf_written: dict[tuple[int, str], float] = {}  # (инструмент, tf) → monotonic записи
        self.held: dict[tuple[int, str], tuple[int, float]] = {}
        """Пары, чьи закрытия ждут сверки соединения: (инструмент, tf) → (номер удержания, monotonic
        конца). Закрытия из стрима и опроса — в ``deferred``, не в буфер и не в ``last_closed``."""
        self.deferred: dict[tuple[int, str], dict[datetime, tuple[str, Candle]]] = {}
        self._hold_gen = 0
        self.stop = asyncio.Event()
        # счётчики для ежеминутной сводки в лог и ключа статуса в Redis (план 2.16)
        self.n_klines = 0
        self.n_flushed = 0
        self.n_published = 0
        self.n_flush_errors = 0
        self.n_redis_errors = 0
        self.n_resynced = 0  # закрытых свечей, взятых сверкой соединения
        # REST-резерв: Binance может держать WebSocket открытым и не слать данные (так было со
        # старым адресом ``/ws`` после переноса рыночных потоков на ``/market``, см. WS_URL; так же
        # будет, если адрес сменится снова). Свежесть — по инструменту: соединений несколько, одно
        # может молчать при живом другом.
        self.kline_at: dict[str, float] = {}  # symbol → time.time() последней kline 1m
        self.n_polled = 0
        self.last_closed: dict[tuple[int, str], datetime] = {}
        """Точка сверки: (инструмент, tf) → последняя закрытая свеча, о которой ``candles.closed``
        уже в очереди или не нужен (меняется под ``_lock``)."""
        self.poll_pause_until = 0.0  # 429/418 от Binance: пауза опроса и тикера до этого момента
        self.backfill_needed: set[str] = set()  # догрузка прервана паузой — повторит опрос
        # живые цены (план 2A.3): последнее опубликованное, накопленное из стрима, счётчики
        self.last_prices: dict[str, str] = {}
        self.ws_prices: dict[str, str] = {}
        self.forming: dict[str, dict[str, Any]] = {}
        self.n_ticks = 0  # опубликовано сообщений с ценами (одно за цикл тикера)
        self.n_tick_prices = 0  # цен в них (только изменившиеся)
        self.n_full = 0  # из них со всеми ценами
        self.n_forming = 0  # опубликовано формирующихся минутных свечей
        self.n_ticker_errors = 0
        self.stale_prices = 0  # инструментов без свежей цены в последнем цикле
        self.used_weight: int | None = None  # X-MBX-USED-WEIGHT-1M из последнего ответа тикера

    # --- инструменты и догрузка ----------------------------------------------------------------
    def load_symbols(self) -> None:
        with SessionLocal() as s:
            rows = s.scalars(
                select(Instrument).where(Instrument.market_type == "futures", Instrument.is_active)
            ).all()
            self.symbols = {r.symbol: r.id for r in rows}
        log.info("инструментов: %d", len(self.symbols))

    def backfill(self, symbols: list[str] | None = None, history: Any = None) -> bool:
        """REST-догрузка по БД до сейчас, по каждому tf (``_sync_key`` с ``from_db``): от последней
        закрытой свечи в БД; если раньше неё (в пределах ``REPAIR_WINDOW`` свечей) есть незакрытая
        строка, которой пора быть закрытой, — от неё: такая дыра иначе не чинилась бы никогда.

        ``symbols`` — только эти инструменты (догрузка, прерванная паузой), иначе все. На паузе
        после 418/429 запросы не идут: недогруженные инструменты остаются в ``backfill_needed``, их
        догрузит опрос после паузы. Догруженная пара больше не ждёт сверки (``release``). На
        остановке — выход после текущего запроса. Возвращает ``True``, если догружено всё."""
        history = history if history is not None else BinanceHistory("futures")
        todo = list(symbols) if symbols is not None else list(self.symbols)
        done: list[str] = []
        with SessionLocal() as s:
            for symbol in todo:
                inst_id = self.symbols.get(symbol)
                if inst_id is None:
                    done.append(symbol)
                    continue
                if self._interrupted():
                    break
                for tf in TIMEFRAMES:
                    if self._interrupted():
                        break
                    if self._sync_key(s, history, symbol, inst_id, tf, from_db=True) is not None:
                        self.release([(inst_id, tf.value)])
                else:
                    done.append(symbol)
        left = [x for x in todo if x not in done]
        if left:
            self.backfill_needed.update(left)
            if not self.stop.is_set():
                log.warning("догрузка прервана паузой 418/429: осталось %d инструментов", len(left))
            return False
        self.backfill_needed.difference_update(todo)
        log.info("догрузка завершена (%d инструментов)", len(todo))
        return True

    def _interrupted(self) -> bool:
        """Догрузке и сверке пора остановиться: остановка сервиса или пауза после 418/429."""
        return self.stop.is_set() or time.time() < self.poll_pause_until

    def _sync_key(
        self, s: Any, history: Any, symbol: str, inst_id: int, tf: Timeframe, from_db: bool
    ) -> int | None:
        """Догрузка пары (инструмент, tf) до сейчас — общая часть догрузки и сверки.

        Начало — после точки сверки (``last_closed``); без неё или с ``from_db`` — ещё и по БД:
        после последней закрытой строки, с самой старой незакрытой, которой пора быть закрытой.
        Закрытые свечи пишутся в БД сразу, одной транзакцией по порядку (пропуск и всё после него
        вместе), затем ``_written``. Возвращает число записанных закрытых свечей; ``None`` — запрос
        не удался (418/429 — ещё и пауза)."""
        now = datetime.now(tz=UTC)
        key = (inst_id, tf.value)
        with self._lock:
            synced: datetime | None = self.last_closed.get(key)
        start = synced + tf.delta if synced is not None else now
        if from_db or synced is None:
            last = s.execute(
                text(
                    "select max(open_time) from candles where instrument_id=:i "
                    "and timeframe=:tf and is_closed"
                ),
                {"i": inst_id, "tf": tf.value},
            ).scalar()
            last = last.astimezone(UTC) if last is not None else None
            if last is not None:
                db_start = last + tf.delta
            elif tf is Timeframe.M1:
                db_start = now - timedelta(days=7)
            else:
                db_start = now - tf.delta * 1500
            stale = s.execute(
                text(
                    "select min(open_time) from candles where instrument_id=:i "
                    "and timeframe=:tf and open_time >= :w and open_time <= :due "
                    "and not is_closed"
                ),
                {
                    "i": inst_id,
                    "tf": tf.value,
                    "w": now - tf.delta * REPAIR_WINDOW,
                    "due": now - tf.delta,
                },
            ).scalar()
            if stale is not None:
                db_start = min(db_start, stale.astimezone(UTC))
            start = min(start, db_start)
            if synced is None:
                synced = last
        closed: list[Candle] = []
        if start < now:
            try:
                candles = history.fetch_rest(symbol, tf, start, now)
            except httpx.HTTPStatusError as exc:
                if not self._rate_limited(exc.response):
                    log.warning("%s %s: догрузка не удалась: %s", symbol, tf.value, exc)
                return None
            except Exception as exc:
                log.warning("%s %s: догрузка не удалась: %s", symbol, tf.value, exc)
                return None
            closed = sorted(
                (c for c in candles if c.close_time(tf) <= now), key=lambda c: c.open_time
            )
            if closed:
                upsert_candles(s, inst_id, tf, closed)
                s.commit()
        self._written(symbol, inst_id, tf, closed, synced)
        return len(closed)

    def _written(
        self,
        symbol: str,
        inst_id: int,
        tf: Timeframe,
        closed: list[Candle],
        synced: datetime | None,
    ) -> None:
        """Закрытые свечи пары записаны в БД мимо буфера (догрузка, сверка).

        ``candles.closed`` — тем, о которых его ещё не было: новее точки сверки ``synced`` (её нет —
        история, событий нет) и новее нынешней ``last_closed`` (свечу мог закрыть стрим, пока шёл
        запрос), если закрылись не раньше ``LATE_CLOSE_MAX`` назад; события — в очередь записи
        (уйдут со следующей). Точка сверки сдвигается на последнюю закрытую. Незакрытый снимок той
        же свечи в буфере (стрим до закрытия) заменяется закрытой строкой: запись не откатит её."""
        key = (inst_id, tf.value)
        fresh = datetime.now(tz=UTC) - timedelta(seconds=LATE_CLOSE_MAX)
        with self._lock:
            mark = self.last_closed.get(key)
            if synced is not None:
                mark = synced if mark is None else max(mark, synced)
            for c in closed:
                row_key = (inst_id, tf.value, c.open_time)
                row = self.candle_buffer.get(row_key)
                if row is not None and not row["is_closed"]:
                    self.candle_buffer[row_key] = _row(inst_id, tf.value, c, True)
                if mark is not None and c.open_time <= mark:
                    continue
                mark = c.open_time
                if synced is not None and c.close_time(tf) >= fresh:
                    self.closed_events.append(_event(symbol, inst_id, tf.value, c))
            if mark is not None:
                self.last_closed[key] = mark

    def hold(self, symbols: list[str]) -> int:
        """Закрытия пар этих инструментов (все tf) ждут сверки соединения — не дольше
        ``HOLD_MAX``: иначе закрытие из стрима попало бы в БД и в ``candles.closed`` раньше свечи,
        закрывшейся без соединения, и трекер (идёт от последней обработанной свечи) её бы пропустил.
        Возвращает номер удержания: его снимает только своя сверка (новое удержание тех же пар —
        после нового обрыва — ждёт следующей)."""
        until = time.monotonic() + HOLD_MAX
        with self._lock:
            self._hold_gen += 1
            for symbol in symbols:
                inst_id = self.symbols.get(symbol)
                if inst_id is None:
                    continue
                for tf in TIMEFRAMES:
                    self.held[(inst_id, tf.value)] = (self._hold_gen, until)
            return self._hold_gen

    def release(self, keys: list[tuple[int, str]], gen: int | None = None) -> None:
        """Пары больше не ждут (``gen`` — только своё удержание; ``None`` — любое): отложенные
        закрытия — в буфер по порядку, под тем же замком (новое закрытие стрима их не обгонит)."""
        with self._lock:
            for key in keys:
                held = self.held.get(key)
                if held is None or (gen is not None and held[0] != gen):
                    continue
                del self.held[key]
                for _, (symbol, c) in sorted(self.deferred.pop(key, {}).items()):
                    self._put_locked(symbol, key[0], key[1], c, closed=True)

    def release_expired(self) -> None:
        """Пары, ждущие сверки дольше ``HOLD_MAX`` (сверка или догрузка не удалась), — без неё."""
        now = time.monotonic()
        with self._lock:
            expired = [key for key, (_, until) in self.held.items() if until <= now]
        if expired:
            log.warning(
                "сверка не дошла до %d пар за %.0f с: их закрытия идут без неё",
                len(expired),
                HOLD_MAX,
            )
            self.release(expired)

    # --- обработка событий ---------------------------------------------------------------------
    def on_kline(self, k: dict[str, Any]) -> None:
        symbol = k["s"]
        inst_id = self.symbols.get(symbol)
        if inst_id is None:
            return
        self.n_klines += 1
        candle = Candle(
            open_time=_dt(int(k["t"])),
            open=Decimal(k["o"]),
            high=Decimal(k["h"]),
            low=Decimal(k["l"]),
            close=Decimal(k["c"]),
            volume=Decimal(k["v"]),
            quote_volume=Decimal(k["q"]),
            trades=int(k["n"]),
        )
        closed = bool(k["x"])
        self._put_candle(symbol, inst_id, k["i"], candle, closed=closed)
        if k["i"] == Timeframe.M1.value:
            # живая цена и формирующаяся минута — из стрима; публикует тикер/flusher раз в секунду
            self.kline_at[symbol] = time.time()
            self.ws_prices[symbol] = _num(candle.close)
            if closed:
                if self.forming.get(symbol, {}).get("t") == int(candle.open_time.timestamp()):
                    del self.forming[symbol]
            else:
                self.forming[symbol] = _forming(candle, _now_iso())

    def _put_candle(self, symbol: str, inst_id: int, tf: str, c: Candle, closed: bool) -> None:
        """Свеча в буфер записи; закрытая — ещё и событие ``candles.closed`` (один раз), оно уйдёт
        после записи этой строки. Снимок незакрытой свечи, которая уже закрылась (ответ REST,
        пришедший после закрытия по стриму), устарел — не пишется. Закрытие пары, ждущей сверки
        (``hold``), откладывается до её конца."""
        with self._lock:
            if closed and (inst_id, tf) in self.held:
                self.deferred.setdefault((inst_id, tf), {})[c.open_time] = (symbol, c)
                return
            self._put_locked(symbol, inst_id, tf, c, closed)

    def _put_locked(self, symbol: str, inst_id: int, tf: str, c: Candle, closed: bool) -> None:
        key = (inst_id, tf)
        prev = self.last_closed.get(key)
        if not closed and prev is not None and c.open_time <= prev:
            return
        self.candle_buffer[(inst_id, tf, c.open_time)] = _row(inst_id, tf, c, closed)
        if not closed or (prev is not None and c.open_time <= prev):
            return
        self.last_closed[key] = c.open_time
        self.closed_events.append(_event(symbol, inst_id, tf, c))

    # --- REST-резерв -------------------------------------------------------------------------
    def _rate_limited(self, resp: httpx.Response) -> bool:
        """418/429 от Binance: пауза REST-опроса и тикера не меньше ``RATE_LIMIT_PAUSE``."""
        if resp.status_code not in (418, 429):
            return False
        retry = resp.headers.get("Retry-After") or ""
        pause = max(int(retry) if retry.isdigit() else 0, RATE_LIMIT_PAUSE)
        self.poll_pause_until = time.time() + pause
        log.warning("Binance %s: лимит запросов, пауза опроса %d с", resp.status_code, pause)
        return True

    def _poll_symbol(self, history: BinanceHistory, symbol: str, tfs: tuple[Timeframe, ...]) -> int:
        inst_id = self.symbols[symbol]
        now = datetime.now(tz=UTC)
        n = 0
        for tf in tfs:
            if time.time() < self.poll_pause_until:
                return n
            try:
                candles = history.fetch_rest(symbol, tf, now - tf.delta * 2, now)
            except httpx.HTTPStatusError as exc:
                if self._rate_limited(exc.response):
                    return n
                log.warning("%s %s: REST-опрос не удался: %s", symbol, tf.value, exc)
                continue
            except Exception as exc:
                log.warning("%s %s: REST-опрос не удался: %s", symbol, tf.value, exc)
                continue
            polled_at = _now_iso()  # снимок формирующейся минуты — на момент ответа биржи
            for c in candles:
                closed = c.close_time(tf) <= now
                self._put_candle(symbol, inst_id, tf.value, c, closed=closed)
                if tf is Timeframe.M1 and not closed:
                    # уйдёт в prices.live со следующей записью
                    self.forming[symbol] = _forming(c, polled_at)
                n += 1
        return n

    def resync(self, symbols: list[str], history: Any = None, gen: int | None = None) -> int:
        """Сверка соединения, когда по нему пошли данные (после старта и после обрыва).

        Binance после подписки шлёт только текущую свечу: свеча, закрывшаяся, пока соединения не
        было (обрыв, переподключение раз в 24 ч, перезапуск сервиса), иначе осталась бы в БД
        незакрытой и без ``candles.closed`` — опрос живые по стриму инструменты не трогает. Для
        каждой пары — по REST всё от точки сверки до сейчас (``_sync_key``): закрытые пишутся в
        БД, не опубликованные — в ``candles.closed`` (как бы долго ни шла сверка), идущую свечу
        пишет стрим. Сверенная пара больше не ждёт (снимается удержание ``gen``). Сначала 1m:
        закрытия минут ждут трекер и алерты. На паузе 418/429 и при ошибке запроса инструменты
        уходят в ``backfill_needed`` — их догрузит опрос, их пары ждут его (не дольше
        ``HOLD_MAX``). На остановке — выход после текущего запроса. Возвращает число записанных
        закрытых свечей."""
        history = history if history is not None else BinanceHistory("futures")
        n = 0
        with SessionLocal() as s:
            for tf in TIMEFRAMES:
                for symbol in symbols:
                    inst_id = self.symbols.get(symbol)
                    if inst_id is None:
                        continue
                    if self.stop.is_set():
                        return n
                    if time.time() < self.poll_pause_until:
                        self.backfill_needed.update(symbols)
                        log.warning("сверка прервана паузой 418/429: %d инструментов", len(symbols))
                        return n
                    got = self._sync_key(s, history, symbol, inst_id, tf, from_db=False)
                    if got is None:
                        self.backfill_needed.add(symbol)
                        continue
                    n += got
                    self.n_resynced += got
                    self.release([(inst_id, tf.value)], gen)
        return n

    def ws_fresh(self, within: float, now: float | None = None) -> set[str]:
        """Инструменты, у которых kline 1m по WebSocket пришла не раньше ``within`` секунд назад."""
        now = time.time() if now is None else now
        return {s for s in self.symbols if now - self.kline_at.get(s, 0.0) < within}

    def mode(self, within: float = SILENCE_TIMEOUT) -> str:
        """``ws`` — стрим жив у всех инструментов, ``rest`` — ни у одного, ``mixed`` — у части."""
        fresh = len(self.ws_fresh(within))
        return "ws" if fresh == len(self.symbols) else "rest" if fresh == 0 else "mixed"

    async def poller(self) -> None:
        """REST-опрос инструментов, у которых стрим молчит дольше ``SILENCE_TIMEOUT``: 1m каждый
        цикл, старшие tf — каждый 4-й цикл. Сначала — догрузка, прерванная паузой 418/429."""
        history = BinanceHistory("futures")
        cycle = 0
        loop = asyncio.get_running_loop()
        with ThreadPoolExecutor(max_workers=POLL_WORKERS) as pool:
            while not self.stop.is_set():
                await asyncio.sleep(POLL_EVERY)
                if time.time() < self.poll_pause_until:
                    continue
                if self.backfill_needed:
                    try:
                        await loop.run_in_executor(
                            pool, self.backfill, sorted(self.backfill_needed), history
                        )
                    except Exception:
                        log.exception("догрузка после паузы не удалась")
                fresh = self.ws_fresh(SILENCE_TIMEOUT)
                targets = [s for s in self.symbols if s not in fresh]
                if not targets:
                    continue
                cycle += 1
                tfs: tuple[Timeframe, ...] = TIMEFRAMES if cycle % 4 == 0 else (Timeframe.M1,)
                if cycle == 1:
                    log.warning("стрим молчит у %d инструментов — REST-опрос свечей", len(targets))
                    tfs = TIMEFRAMES
                futures = [
                    loop.run_in_executor(pool, self._poll_symbol, history, s, tfs) for s in targets
                ]
                results = await asyncio.gather(*futures, return_exceptions=True)
                self.n_polled += sum(r for r in results if isinstance(r, int))

    # --- живые цены (план 2A.3) -----------------------------------------------------------------
    async def _fetch_prices(self, client: httpx.AsyncClient) -> dict[str, str] | None:
        """Один запрос ``ticker/price`` на все символы (вес 2); только наши инструменты.

        ``None`` — цен нет (таймаут, сеть, 418/429 — тогда же пауза опроса, как у свечей)."""
        try:
            resp = await client.get(TICKER_URL, timeout=TICKER_TIMEOUT)
            weight = resp.headers.get("X-MBX-USED-WEIGHT-1M") or ""
            if weight.isdigit():
                self.used_weight = int(weight)
            if self._rate_limited(resp):
                return None
            resp.raise_for_status()
            rows = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            self.n_ticker_errors += 1
            if self.n_ticker_errors % TICKER_LOG_EVERY == 1:
                log.warning(
                    "тикер цен: %s: %s (ошибок всего %d)",
                    type(exc).__name__,
                    exc,
                    self.n_ticker_errors,
                )
            return None
        out: dict[str, str] = {}
        for r in rows if isinstance(rows, list) else []:
            symbol = r.get("symbol") if isinstance(r, dict) else None
            if symbol not in self.symbols:
                continue
            try:
                out[symbol] = _num(Decimal(str(r["price"])))
            except (KeyError, ArithmeticError):
                continue
        return out

    async def ticker_cycle(self, client: httpx.AsyncClient) -> None:
        """Цикл тикера: цена инструмента из стрима, пока его kline 1m свежая, остальные — одним
        REST-запросом; в канал — только изменившиеся, каждое ``TICKER_FULL_EVERY``-е — все.

        Сообщение уходит и без изменений (``"p": {}``): по нему API понимает, что поток цен жив.
        Инструменты без свежей цены (стрим молчит, REST недоступен) — в ``"stale"``: их прежнюю цену
        хаб не выдаёт за живую. Нет ни одной свежей цены — сообщения нет (у клиента «без связи»)."""
        now = time.time()
        fresh = self.ws_fresh(TICKER_WS_FRESH, now)
        ws_prices, self.ws_prices = self.ws_prices, {}
        prices = {s: p for s, p in ws_prices.items() if s in fresh}
        stale = set(self.symbols) - fresh
        if stale and now >= self.poll_pause_until:
            fetched = await self._fetch_prices(client)
            if fetched is not None:
                prices.update({s: p for s, p in fetched.items() if s in stale})
                stale -= fetched.keys()
        self.stale_prices = len(stale)
        if stale and len(stale) == len(self.symbols):
            return
        changed = {s: p for s, p in prices.items() if self.last_prices.get(s) != p}
        latest = {**self.last_prices, **changed}
        at = _now_iso()
        full = self.n_ticks % TICKER_FULL_EVERY == 0
        live = {s: p for s, p in latest.items() if s not in stale}
        msg: dict[str, Any] = {"at": at, "p": live if full else changed}
        if full:
            msg["full"] = True
        if stale:
            msg["stale"] = sorted(stale)
        # ключ — до публикации: хаб, подписавшийся между ними, прочтёт ключ или получит сообщение
        await self.redis.set(PRICES_KEY, _dumps({"at": at, "p": live}), ex=PRICES_KEY_TTL)
        await self.redis.publish(CHANNEL_PRICES, _dumps(msg))
        # только после публикации: не ушедшее изменение уйдёт в следующем цикле
        self.last_prices = latest
        self.n_ticks += 1
        self.n_full += int(full)
        self.n_tick_prices += len(changed)

    async def ticker(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        """Раз в ``TICKER_EVERY`` секунд — цикл тикера; запросы не перекрываются (один в полёте)."""
        loop = asyncio.get_running_loop()
        async with httpx.AsyncClient(timeout=TICKER_TIMEOUT, transport=transport) as client:
            while not self.stop.is_set():
                started = loop.time()
                try:
                    await self.ticker_cycle(client)
                except Exception as exc:  # Redis недоступен и т. п. — не роняем цикл
                    self.n_ticker_errors += 1
                    if self.n_ticker_errors % TICKER_LOG_EVERY == 1:
                        log.warning("тикер цен: %s: %s", type(exc).__name__, exc)
                await asyncio.sleep(max(0.0, TICKER_EVERY - (loop.time() - started)))

    async def publish_forming(self) -> None:
        """Формирующиеся минутные свечи (из REST-опроса или стрима) — одним сообщением."""
        forming, self.forming = self.forming, {}
        if not forming:
            return
        try:
            await self.redis.publish(CHANNEL_PRICES, _dumps({"at": _now_iso(), "c": forming}))
        except Exception:
            # Redis недоступен: снимки вернутся в очередь, если их не сменили более свежие
            self.forming = {**forming, **self.forming}
            raise
        self.n_forming += len(forming)

    def on_force_order(self, o: dict[str, Any]) -> None:
        inst_id = self.symbols.get(o["s"])
        if inst_id is None:
            return
        minute = _dt(int(o["T"])).replace(second=0, microsecond=0)
        usd = Decimal(o["q"]) * Decimal(o["ap"])
        bucket = self.liq_buffer[(inst_id, minute)]
        if o["S"] == "SELL":  # продажа по рынку = ликвидирован лонг
            bucket[0] += usd
        else:
            bucket[1] += usd

    # --- запись ---------------------------------------------------------------------------------
    def _flush_sync(
        self,
        candles: list[dict[str, Any]],
        liqs: dict[tuple[int, datetime], list[Decimal]],
    ) -> None:
        with SessionLocal() as s:
            from app.models import Candle as CandleRow

            for i in range(0, len(candles), UPSERT_CHUNK):
                stmt = insert(CandleRow).values(candles[i : i + UPSERT_CHUNK])
                s.execute(
                    stmt.on_conflict_do_update(
                        index_elements=["instrument_id", "timeframe", "open_time"],
                        set_={
                            k: stmt.excluded[k]
                            for k in (
                                "open",
                                "high",
                                "low",
                                "close",
                                "volume",
                                "quote_volume",
                                "trades",
                                "is_closed",
                            )
                        },
                    )
                )
            if liqs:
                stmt2 = insert(LiquidationRow).values(
                    [
                        {
                            "instrument_id": i,
                            "time": t,
                            "long_usd": v[0],
                            "short_usd": v[1],
                            "source": "stream",
                        }
                        for (i, t), v in liqs.items()
                    ]
                )
                s.execute(
                    stmt2.on_conflict_do_update(
                        index_elements=["instrument_id", "time"],
                        set_={
                            "long_usd": LiquidationRow.long_usd + stmt2.excluded.long_usd,
                            "short_usd": LiquidationRow.short_usd + stmt2.excluded.short_usd,
                        },
                    )
                )
            s.commit()

    async def flusher(self) -> None:
        """Раз в ``FLUSH_EVERY`` секунд — запись; на остановке — последняя, всего буфера."""
        while True:
            if not self.stop.is_set():
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.stop.wait(), FLUSH_EVERY)
            final = self.stop.is_set()
            await self.flush_once(final=final)
            if final:
                return

    def _take_rows(self, final: bool) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Строки для записи и события их закрытых свечей — одним снимком под замком: событие,
        пришедшее во время записи, уйдёт со следующей записью вместе со своей строкой. Незакрытая
        4h/1d/1w остаётся в буфере, если её (инструмента и tf) писали меньше
        ``FORMING_HTF_EVERY`` секунд назад (``final`` — пишется всё)."""
        now = time.monotonic()
        take: list[dict[str, Any]] = []
        keep: dict[tuple[int, str, datetime], dict[str, Any]] = {}
        with self._lock:
            events, self.closed_events = self.closed_events, []
            for key, row in self.candle_buffer.items():
                if final or row["is_closed"] or row["timeframe"] == Timeframe.M1.value:
                    take.append(row)
                    continue
                tf_key = (row["instrument_id"], row["timeframe"])
                if now - self.htf_written.get(tf_key, -FORMING_HTF_EVERY) >= FORMING_HTF_EVERY:
                    self.htf_written[tf_key] = now
                    take.append(row)
                else:
                    keep[key] = row
            self.candle_buffer = keep
        return take, events

    def _requeue(
        self,
        candles: list[dict[str, Any]],
        events: list[dict[str, Any]],
        liqs: dict[tuple[int, datetime], list[Decimal]],
    ) -> None:
        """Запись не удалась: строки, события и ликвидации — обратно в буфер, к следующей записи.
        Строка, пришедшая во время записи, новее — она и остаётся. Сверх ``BUFFER_MAX`` строк
        отбрасываются самые старые вместе со своими событиями. Незакрытые 4h/1d/1w — со следующей
        записью, без ожидания ``FORMING_HTF_EVERY``."""
        with self._lock:
            buffer = {(r["instrument_id"], r["timeframe"], r["open_time"]): r for r in candles}
            for r in candles:
                self.htf_written.pop((r["instrument_id"], r["timeframe"]), None)
            buffer.update(self.candle_buffer)
            queued = events + self.closed_events
            if len(buffer) > BUFFER_MAX:
                dropped = sorted(buffer, key=lambda key: key[2])[: len(buffer) - BUFFER_MAX]
                for key in dropped:
                    del buffer[key]
                queued = [
                    e
                    for e in queued
                    if (
                        e["instrument_id"],
                        e["tf"],
                        datetime.fromisoformat(e["open_time"]),
                    )
                    in buffer
                ]
                log.error("буфер записи переполнен: отброшено %d строк", len(dropped))
            self.candle_buffer = buffer
            self.closed_events = queued
        for liq_key, (long_usd, short_usd) in liqs.items():
            bucket = self.liq_buffer[liq_key]
            bucket[0] += long_usd
            bucket[1] += short_usd

    async def flush_once(self, final: bool = False) -> None:
        """Запись буфера в БД, затем закрытые свечи этой записи — в ``candles.closed`` (не раньше
        их строк: планировщик и алерты читают свечу из БД), формирующиеся минуты — в
        ``prices.live``, heartbeat и статус. Ликвидации — за завершённые минуты (``final`` — и за
        текущую: строка ликвидаций складывается с уже записанной)."""
        if final:  # остановка: закрытия, ждавшие сверки, — в последнюю запись
            self.release(list(self.held))
        else:
            self.release_expired()
        candles, events = self._take_rows(final)
        cutoff = datetime.now(tz=UTC).replace(second=0, microsecond=0)
        liqs = {k: v for k, v in self.liq_buffer.items() if final or k[1] < cutoff}
        for k in liqs:
            del self.liq_buffer[k]
        if candles or liqs:
            try:
                await asyncio.to_thread(self._flush_sync, candles, liqs)
            except Exception:
                self.n_flush_errors += 1
                self._requeue(candles, events, liqs)
                events = []
                if self.n_flush_errors % FLUSH_LOG_EVERY == 1:
                    log.exception(
                        "ошибка записи в БД (всего %d); данные остаются в буфере до следующей "
                        "записи",
                        self.n_flush_errors,
                    )
            else:
                self.n_flushed += len(candles)
        self.ready_events = (self.ready_events + events)[-EVENTS_MAX:]
        try:
            await self.publish_closed()
            # после закрытых: клиент сначала закрывает минуту, затем видит следующую
            await self.publish_forming()
            await self.redis.set(HEARTBEAT_KEY, int(time.time()))
            await self.redis.set(STATUS_KEY, json.dumps(self.status()))
        except Exception as exc:
            # Redis недоступен: запись и опрос идут дальше, закрытые свечи уйдут потом
            self.n_redis_errors += 1
            if self.n_redis_errors % REDIS_LOG_EVERY == 1:
                log.warning(
                    "Redis: %s: %s (ошибок всего %d, ждут публикации %d)",
                    type(exc).__name__,
                    exc,
                    self.n_redis_errors,
                    len(self.ready_events),
                )

    async def publish_closed(self) -> None:
        """Записанные закрытые свечи в ``candles.closed`` по порядку; не ушедшие (Redis
        недоступен) остаются в очереди — не больше ``EVENTS_MAX`` последних."""
        events, self.ready_events = self.ready_events, []
        for i, e in enumerate(events):
            try:
                await self.redis.publish(CHANNEL_CLOSED, json.dumps(e))
            except Exception:
                self.ready_events = (events[i:] + self.ready_events)[-EVENTS_MAX:]
                raise
            self.n_published += 1

    def status(self) -> dict[str, Any]:
        """Счётчики для ключа ``market_data:status`` (видно в /debug/live и админке)."""
        return {
            "klines": self.n_klines,
            "polled": self.n_polled,
            "mode": self.mode(),
            "flushed": self.n_flushed,
            "published": self.n_published,
            "flush_errors": self.n_flush_errors,
            "redis_errors": self.n_redis_errors,
            "buffer": len(self.candle_buffer),
            "pending_closed": len(self.closed_events) + len(self.ready_events),
            "resynced": self.n_resynced,
            "ticks": self.n_ticks,
            "tick_prices": self.n_tick_prices,
            "ticks_full": self.n_full,
            "forming": self.n_forming,
            "ticker_errors": self.n_ticker_errors,
            "prices_mode": self.mode(TICKER_WS_FRESH),
            "stale_prices": self.stale_prices,
            "used_weight_1m": self.used_weight,
            "at": int(time.time()),
        }

    async def reporter(self) -> None:
        """Раз в минуту — строка сводки в лог: видно, идут ли данные и пишутся ли они."""
        while not self.stop.is_set():
            await asyncio.sleep(REPORT_EVERY)
            log.info(
                "сводка: klines=%d rest=%d записано=%d опубликовано=%d ошибок записи=%d режим=%s "
                "тиков=%d цен=%d формирующихся=%d ошибок тикера=%d без цены=%d ошибок redis=%d "
                "вес=%s",
                self.n_klines,
                self.n_polled,
                self.n_flushed,
                self.n_published,
                self.n_flush_errors,
                self.mode(),
                self.n_ticks,
                self.n_tick_prices,
                self.n_forming,
                self.n_ticker_errors,
                self.stale_prices,
                self.n_redis_errors,
                self.used_weight,
            )

    # --- деривативы -----------------------------------------------------------------------------
    def _derivatives_sync(self) -> None:
        history = BinanceHistory("futures")
        now = datetime.now(tz=UTC)
        with SessionLocal() as s:
            rows = s.scalars(
                select(Instrument).where(Instrument.symbol.in_(list(self.symbols)))
            ).all()
            for inst in rows:
                _refresh_derivatives(s, history, inst, now)
            s.commit()

    async def derivatives_loop(self) -> None:
        while not self.stop.is_set():
            try:
                await asyncio.to_thread(self._derivatives_sync)
            except Exception:
                log.exception("деривативы не обновлены")
            await asyncio.sleep(DERIVATIVES_EVERY)

    # --- websocket -------------------------------------------------------------------------------
    def _streams(self) -> list[list[str]]:
        names: list[str] = []
        for symbol in self.symbols:
            s = symbol.lower()
            names += [f"{s}@kline_{tf.value}" for tf in TIMEFRAMES]
            names.append(f"{s}@forceOrder")
        return [
            names[i : i + STREAMS_PER_CONNECTION]
            for i in range(0, len(names), STREAMS_PER_CONNECTION)
        ]

    async def connection(self, streams: list[str], idx: int) -> None:
        """Одно WebSocket-соединение Binance. Когда по нему пошли данные (после старта и после
        обрыва) — удержание закрытий его инструментов (``hold``) и сверка (``resync``, в фоне: приём
        не ждёт REST). Сверки не перекрываются: данные, пошедшие во время сверки, — ровно одна
        следующая, и удержание этих данных снимает только она.
        Молчащий стрим (подписка подтверждена, данных нет — так молчал в production старый адрес
        ``/ws``, см. ``WS_URL``) переподключается без сверки — его инструменты держит REST-опрос —
        и с растущей до 60 с задержкой."""
        backoff = RECONNECT_MIN
        symbols = sorted({name.split("@", 1)[0].upper() for name in streams})
        wanted = asyncio.Event()
        gen = 0  # удержание закрытий до сверки — с первых данных этого подключения

        async def resyncer() -> None:
            history = BinanceHistory("futures")
            while True:
                await wanted.wait()
                wanted.clear()
                try:
                    n = await asyncio.to_thread(self.resync, symbols, history, gen)
                    log.info("соединение %d: сверка — закрытых свечей %d", idx, n)
                except Exception:
                    self.backfill_needed.update(symbols)
                    log.exception("соединение %d: сверка не удалась", idx)

        worker = asyncio.create_task(resyncer(), name=f"resync-{idx}")
        try:
            while not self.stop.is_set():
                got_data = False
                try:
                    async with connect(
                        WS_URL, ping_interval=20, ping_timeout=20, max_size=2**22
                    ) as ws:
                        await ws.send(
                            json.dumps({"method": "SUBSCRIBE", "params": streams, "id": idx + 1})
                        )
                        log.info("соединение %d: подписка на %d потоков", idx, len(streams))
                        received = 0
                        while not self.stop.is_set():
                            try:
                                raw = await asyncio.wait_for(ws.recv(), timeout=SILENCE_TIMEOUT)
                            except TimeoutError:
                                # Binance шлёт kline каждые ~250 мс: тишина = мёртвое соединение
                                log.warning(
                                    "соединение %d: нет данных %d с (получено %d), переподключаюсь",
                                    idx,
                                    SILENCE_TIMEOUT,
                                    received,
                                )
                                break
                            received += 1
                            msg = json.loads(raw)
                            # raw-стрим отдаёт событие как есть; combined — в поле "data"
                            data = msg.get("data", msg) if isinstance(msg, dict) else {}
                            event = data.get("e")
                            if received == 1:
                                log.info("соединение %d: первое сообщение: %s", idx, str(raw)[:200])
                            if event in ("kline", "forceOrder") and not got_data:
                                got_data = True
                                # стрим ожил — следующий обрыв снова с короткой паузы; закрытое,
                                # пока соединения не было, Binance не пришлёт — сверка по REST, а
                                # закрытия из стрима до неё ждут (раньше первого же сообщения)
                                backoff = RECONNECT_MIN
                                gen = self.hold(symbols)
                                wanted.set()
                            if event == "kline":
                                self.on_kline(data["k"])
                            elif event == "forceOrder":
                                self.on_force_order(data["o"])
                            elif "error" in msg or received <= 3:
                                log.warning(
                                    "соединение %d: сообщение без данных: %s", idx, str(raw)[:300]
                                )
                                continue
                            else:
                                continue
                except (ConnectionClosed, OSError) as exc:
                    log.warning(
                        "соединение %d разорвано: %s; повтор через %.0f с", idx, exc, backoff
                    )
                except Exception:
                    log.exception("соединение %d: ошибка", idx)
                if self.stop.is_set():
                    break
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, RECONNECT_MAX)
        finally:
            worker.cancel()

    async def run(self) -> bool:
        """Задачи сервиса до сигнала остановки. Тикер цен и запись (heartbeat) — до стартовой
        догрузки: она идёт десятки секунд, а цены и «жив» нужны сразу. Основная задача, вышедшая
        без остановки, останавливает сервис (``False``): хостинг перезапустит процесс. Запись
        останавливается последней: после источников данных она пишет весь буфер (и ликвидации
        текущей минуты) и публикует закрытые — деплой их не теряет."""
        self.load_symbols()
        flusher = asyncio.create_task(self.flusher(), name="flusher")
        tasks = [
            asyncio.create_task(self.ticker(), name="ticker"),
            flusher,
            asyncio.create_task(self.reporter(), name="reporter"),
        ]
        try:
            await asyncio.to_thread(self.backfill)
        except Exception:
            log.exception("стартовая догрузка не удалась")
        tasks += [
            asyncio.create_task(self.derivatives_loop(), name="derivatives"),
            asyncio.create_task(self.poller(), name="poller"),
        ]
        tasks += [
            asyncio.create_task(self.connection(chunk, i), name=f"connection-{i}")
            for i, chunk in enumerate(self._streams())
        ]
        stop = asyncio.create_task(self.stop.wait())
        done, _ = await asyncio.wait([stop, *tasks], return_when=asyncio.FIRST_COMPLETED)
        failed = [t for t in done if t is not stop and not self.stop.is_set()]
        for t in failed:
            exc = None if t.cancelled() else t.exception()
            log.error("задача %s остановилась: %r — останавливаю сервис", t.get_name(), exc)
        self.stop.set()
        sources = [t for t in [stop, *tasks] if t is not flusher]
        for t in sources:
            t.cancel()
        await asyncio.gather(*sources, return_exceptions=True)
        try:
            if flusher.done():  # запись упала сама — последняя запись здесь
                await self.flush_once(final=True)
            else:
                await asyncio.wait_for(flusher, FINAL_FLUSH_TIMEOUT)
        except Exception:
            log.exception("последняя запись не удалась")
        await self.redis.aclose()
        return not failed


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    md = MarketData()
    loop = asyncio.new_event_loop()
    for sig in (os_signal.SIGINT, os_signal.SIGTERM):
        loop.add_signal_handler(sig, md.stop.set)
    ok = loop.run_until_complete(md.run())
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
