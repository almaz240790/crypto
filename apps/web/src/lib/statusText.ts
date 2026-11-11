import type { T } from "@/i18n";

/** Названия компонентов монитора (apps/api/app/monitor.py) — ключи перевода по коду компонента. */
const TITLES: Record<string, string> = {
  data: "Данные с биржи",
  candles: "Свечи H4",
  engine: "Движок сигналов",
  tracker: "Трекер сделок",
  notifier: "Уведомления",
  patterns: "Паттерны на графике",
  alerts: "Алерты",
  api: "API и база",
  reconcile: "Сверка сигналов",
};

export function componentTitle(t: T, key: string, fallback: string): string {
  const k = TITLES[key];
  return k ? t(k) : fallback;
}

/** Подробности монитора приходят готовой русской фразой; известные форматы переводим, остальное показываем как есть. */
const DETAILS: [RegExp, string][] = [
  [/^heartbeat (\d+) мин назад$/, "heartbeat {n} мин назад"],
  [/^heartbeat (\d+) с назад$/, "heartbeat {n} с назад"],
  [/^последняя 1m-свеча (\d+) мин назад$/, "последняя 1m-свеча {n} мин назад"],
  [/^последняя 1m-свеча (\d+) с назад$/, "последняя 1m-свеча {n} с назад"],
  [/^(\d+) инструментов в срок$/, "{n} инструментов в срок"],
  [/^нет прогона по свече (.+) UTC$/, "нет прогона по свече {n} UTC"],
];

const FIXED = [
  "нет heartbeat",
  "нет минутных свечей",
  "нет инструментов",
  "ок",
  "нет Redis",
  "нет базы",
  // сверка сигналов (apps/api/app/monitor.py, reconcile_component)
  "сверка ещё не выполнялась",
  "сверка не выполнялась больше 36 ч",
  "сверка не выполнена: ошибка",
  "итог сверки не читается",
];

export function statusDetail(t: T, detail: string): string {
  if (FIXED.includes(detail)) return t(detail);
  const stale = /^нет закрытия свечи у (\d+) из (\d+) инструментов$/.exec(detail);
  if (stale) return t("нет закрытия свечи у {a} из {b} инструментов", { a: stale[1], b: stale[2] });
  const clean = /^проверено сигналов: (\d+), расхождений нет$/.exec(detail);
  if (clean) return t("проверено сигналов: {n}, расхождений нет", { n: clean[1] });
  const diff = /^расхождений: критичных (\d+), предупреждений (\d+); проверено сигналов: (\d+)$/.exec(detail);
  if (diff) return t("расхождений: критичных {a}, предупреждений {b}; проверено сигналов: {n}", { a: diff[1], b: diff[2], n: diff[3] });
  for (const [re, key] of DETAILS) {
    const m = re.exec(detail);
    if (m) return t(key, { n: m[1] });
  }
  return detail;
}
