import type { Metadata } from "next";
import {
  Badge,
  Button,
  DirectionBadge,
  EmptyState,
  FieldRow,
  GradeBadge,
  Input,
  Panel,
  Select,
  STATUS_LABEL,
  StatusBadge,
  Table,
  Td,
  Th,
  ThemeToggle,
  Tooltip,
} from "@/components/ui";
import { formatDuration, formatPct, formatPrice, formatR, formatTimeUTC } from "@/lib/format";
import s from "./page.module.css";

export const metadata: Metadata = { title: "Дизайн-система", robots: { index: false } };

const TOKENS = [
  ["--bg", "фон страницы"],
  ["--surface", "поверхность"],
  ["--surface-raised", "приподнятая"],
  ["--border", "граница"],
  ["--row-hover", "выделение строки"],
  ["--text", "текст"],
  ["--text-2", "текст вторичный"],
  ["--text-3", "приглушённый"],
  ["--up", "рост / лонг"],
  ["--down", "падение / шорт"],
  ["--accent", "акцент"],
  ["--warn", "предупреждение"],
  ["--ind-1", "индикатор 1"],
  ["--ind-2", "индикатор 2"],
  ["--ind-3", "индикатор 3"],
  ["--ind-4", "индикатор 4"],
  ["--ind-5", "индикатор 5"],
  ["--ind-6", "индикатор 6"],
] as const;

const ROWS = [
  {
    t: "2026-10-25T16:00:00Z",
    sym: "BTCUSDT",
    dir: "long",
    grade: "A",
    entry: "65432.1",
    sl: "64210.0",
    tp2: "68100.5",
    rr: "2.61",
    status: "active",
    r: null,
    tick: "0.1",
  },
  {
    t: "2026-10-25T12:00:00Z",
    sym: "ETHUSDT",
    dir: "short",
    grade: "B",
    entry: "2612.34",
    sl: "2688.10",
    tp2: "2440.00",
    rr: "2.27",
    status: "tp1_hit",
    r: null,
    tick: "0.01",
  },
  {
    t: "2026-10-24T20:00:00Z",
    sym: "SOLUSDT",
    dir: "long",
    grade: "C",
    entry: "142.312",
    sl: "138.900",
    tp2: "151.000",
    rr: "2.55",
    status: "closed_sl",
    r: -1,
    tick: "0.001",
  },
  {
    t: "2026-10-23T08:00:00Z",
    sym: "DOGEUSDT",
    dir: "short",
    grade: "A",
    entry: "0.08123",
    sl: "0.08410",
    tp2: "0.07420",
    rr: "2.45",
    status: "closed_tp3",
    r: 2.9,
    tick: "0.00001",
  },
];

export default function UiPage() {
  return (
    <main className={`container ${s.page}`}>
      <div className={s.top}>
        <div>
          <h1>Дизайн-система</h1>
          <p className="text-2">
            Токены, шрифты и компоненты по разделу 5 плана. Все экраны собираются только из них.
          </p>
        </div>
        <ThemeToggle />
      </div>

      <div className={s.grid}>
        <Panel title="Цвета (токены)">
          <div className={s.swatches}>
            {TOKENS.map(([v, name]) => (
              <div key={v} className={s.swatch}>
                <i style={{ background: `var(${v})` }} />
                <span>
                  <code>{v}</code>
                  <br />
                  <span className="text-3">{name}</span>
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Типографика" className={s.type}>
          <h1>Заголовок h1, 26px / 600</h1>
          <h2>Заголовок h2, 20px</h2>
          <h3>Заголовок h3, 16px</h3>
          <p>
            Основной текст 15px, IBM Plex Sans. Сигналы публикуются через 60 секунд после закрытия
            свечи H4. Система убыточна в периоды затяжного флэта.
          </p>
          <p className="caption">Подпись 12px, вторичный цвет. Время: {formatTimeUTC("2026-10-25T16:00:00Z")}</p>
          <div className={s.nums} style={{ marginTop: 12 }}>
            <span className="text-2">цена по шагу 0.1</span>
            <span className="num">{formatPrice("65432.10000000", "0.1")}</span>
            <span className="text-2">цена по шагу 0.00001</span>
            <span className="num">{formatPrice("0.08123", "0.00001")}</span>
            <span className="text-2">результат</span>
            <span className="num up">{formatR(0.62)}</span>
            <span className="text-2">результат</span>
            <span className="num down">{formatR(-1)}</span>
            <span className="text-2">изменение</span>
            <span className="num">{formatPct(1.23)}</span>
            <span className="text-2">длительность</span>
            <span className="num">{formatDuration(26.25)}</span>
          </div>
        </Panel>

        <Panel title="Кнопки">
          <div className={s.col}>
            <div className={s.row}>
              <Button variant="primary">Войти</Button>
              <Button>Фильтры</Button>
              <Button variant="ghost">Сбросить</Button>
              <Button variant="danger">Удалить</Button>
              <Button disabled>Недоступно</Button>
            </div>
            <div className={s.row}>
              <Button size="sm">Малая</Button>
              <Button size="md">Обычная</Button>
              <Button size="lg" variant="primary">
                Большая
              </Button>
              <Button href="/">Ссылка как кнопка</Button>
            </div>
          </div>
        </Panel>

        <Panel title="Бейджи">
          <div className={s.col}>
            <div className={s.row}>
              <GradeBadge grade="A" />
              <GradeBadge grade="B" />
              <GradeBadge grade="C" />
              <span className="caption">градация — буква в рамке, не цвет</span>
            </div>
            <div className={s.row}>
              <DirectionBadge direction="long" />
              <DirectionBadge direction="short" />
            </div>
            <div className={s.row}>
              {Object.keys(STATUS_LABEL).map((k) => (
                <StatusBadge key={k} status={k} />
              ))}
            </div>
            <div className={s.row}>
              <Badge>нейтральный</Badge>
              <Badge tone="accent">акцент</Badge>
              <Badge tone="warn">внимание</Badge>
              <Badge tone="muted">приглушён</Badge>
            </div>
          </div>
        </Panel>

        <Panel title="Формы">
          <div className={s.col}>
            <FieldRow>
              <Input label="Email" type="email" placeholder="name@example.com" />
              <Input label="Депозит, USDT" mono inputMode="decimal" defaultValue="10000" hint="для расчёта размера позиции" />
            </FieldRow>
            <FieldRow>
              <Select label="Биржа" defaultValue="binance">
                <option value="binance">Binance</option>
                <option value="bybit">Bybit</option>
                <option value="okx">OKX</option>
              </Select>
              <Input label="Риск на сделку, %" mono defaultValue="1.0" error="от 0.1 до 5" />
            </FieldRow>
            <div className={s.row}>
              <Tooltip text="R — отношение прибыли к риску: 1 R равен расстоянию от входа до стопа.">
                что такое R
              </Tooltip>
            </div>
          </div>
        </Panel>

        <Panel title="Пустое состояние">
          <EmptyState
            text="Нет активных сигналов. Следующая проверка через 2 ч 14 мин."
            action={<Button size="sm">История</Button>}
          />
        </Panel>
      </div>

      <Panel
        title="Таблица сигналов"
        actions={<span>обновлено {formatTimeUTC("2026-10-25T16:01:00Z")}</span>}
        footer="На узком экране строки превращаются в двухстрочный список."
        flush
      >
        <Table clickable>
          <thead>
            <tr>
              <Th>Время</Th>
              <Th>Инструмент</Th>
              <Th>Напр.</Th>
              <Th>Гр.</Th>
              <Th num>Вход</Th>
              <Th num>Стоп</Th>
              <Th num>TP2</Th>
              <Th num>R:R</Th>
              <Th>Статус</Th>
              <Th num>Результат</Th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.sym + r.t}>
                <Td mobile="secondary" className="text-2">
                  {formatTimeUTC(r.t)}
                </Td>
                <Td>
                  <strong>{r.sym}</strong> <DirectionBadge direction={r.dir} />{" "}
                  <GradeBadge grade={r.grade} />
                </Td>
                <Td mobile="hidden">{r.dir}</Td>
                <Td mobile="hidden">{r.grade}</Td>
                <Td num mobile="right">
                  {formatPrice(r.entry, r.tick)}
                </Td>
                <Td num mobile="hidden">
                  {formatPrice(r.sl, r.tick)}
                </Td>
                <Td num mobile="hidden">
                  {formatPrice(r.tp2, r.tick)}
                </Td>
                <Td num mobile="hidden">
                  {r.rr}
                </Td>
                <Td mobile="secondary">
                  <StatusBadge status={r.status} />
                </Td>
                <Td num mobile="right" className={r.r == null ? "" : r.r > 0 ? "up" : "down"}>
                  {r.r == null ? "—" : formatR(r.r)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </main>
  );
}
