/** Таймфреймы терминала (план 2A.3): общий список для серверных и клиентских модулей. */
export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const INTRADAY: readonly Timeframe[] = ["1m", "5m", "15m"];

/**
 * Подписи таймфреймов (план 2B.9): русский исходник, выводится через t(); en.json — «1m 5m 15m 1h 4h 1D 1W».
 * Одни и те же в терминале, ячейках мультичарта, подписи снимка, заголовках, карточке сигнала и списках.
 * Код таймфрейма (value, URL, имя файла снимка) не меняется — меняется только подпись.
 */
export const TF_LABEL: Readonly<Record<Timeframe, string>> = { "1m": "1м", "5m": "5м", "15m": "15м", "1h": "1ч", "4h": "4ч", "1d": "1Д", "1w": "1Н" };

/** Сначала доступные, затем закрытые минутные (гость и тариф Free); без замков — канонический порядок. */
const LOCKED_ORDER: readonly Timeframe[] = [...TIMEFRAMES.filter((x) => !INTRADAY.includes(x)), ...INTRADAY];

/**
 * Порядок таймфреймов в ряду: intradayLocked — минутные ТФ закрыты (гость или Free) и стоят после
 * доступных («1ч 4ч 1Д 1Н 1м 5м 15м»); иначе — TIMEFRAMES. Клавиши 1–7 всегда идут по TIMEFRAMES.
 */
export function tfOrder(intradayLocked: boolean): readonly Timeframe[] {
  return intradayLocked ? LOCKED_ORDER : TIMEFRAMES;
}
