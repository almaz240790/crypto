import type { PanelKey } from "../types";

/**
 * Все слова, которые может показать график: подписи на холсте, подсказки при наведении, легенда «?»,
 * названия пресетов (план 2B.2, 5.2, 8). Пакет не знает про i18n: apps/web собирает SceneText из
 * литеральных t("…") (chart/chartText.ts), чтобы check-i18n видел ключи, а владелец проверял один файл.
 * Здесь — русский оригинал для тестов и снимков. Без обещаний доходности и прогнозов (план 2A.10.6).
 */
export type TextKey =
  // пресеты разметки
  | "preset.clean"
  | "preset.structure"
  | "preset.levels"
  | "preset.liquidity"
  | "preset.detailed"
  | "preset.compact"
  | "preset.custom"
  // подписи на холсте
  | "sr.support"
  | "sr.resistance"
  | "sr.support.short"
  | "sr.resistance.short"
  | "zone.demand"
  | "zone.supply"
  | "zone.mixed"
  | "structure.bos"
  | "structure.choch"
  | "structure.sweep"
  | "structure.eqh"
  | "structure.eql"
  | "level.pdh"
  | "level.pdl"
  | "level.pwh"
  | "level.pwl"
  | "figure.target"
  | "figure.invalidation"
  | "figure.forming"
  | "figure.confirmed"
  | "figure.invalidated"
  | "signal.entry"
  | "signal.stop"
  | "signal.tp"
  | "alert.up"
  | "alert.down"
  | "alert.range"
  | "liq.longs"
  | "liq.shorts"
  | "liq.estimate"
  | "liq.unavailable"
  | "liq.note"
  | "vp.poc"
  // подсказка при наведении
  | "hover.touches"
  | "hover.distance"
  | "hover.range"
  | "hover.amount"
  | "hover.inside"
  | "hover.since"
  | "hover.notAdvice"
  | "hover.bos.up"
  | "hover.bos.down"
  | "hover.choch.up"
  | "hover.choch.down"
  | "hover.closeBeyond"
  | "hover.sweep.high"
  | "hover.sweep.low"
  | "hover.eqh"
  | "hover.eql"
  | "hover.pdh"
  | "hover.pdl"
  | "hover.pwh"
  | "hover.pwl"
  | "hover.figureTarget"
  | "hover.figureInvalidation"
  | "hover.patternSignificant"
  | "hover.patternFound"
  | "hover.signal.long"
  | "hover.signal.short"
  | "hover.alert.up"
  | "hover.alert.down"
  | "hover.alert.range"
  | "hover.poc"
  // легенда «?»: слово и одна строка пояснения
  | "legend.price"
  | "legend.price.explain"
  | "legend.resistance.explain"
  | "legend.support.explain"
  | "legend.demand.explain"
  | "legend.supply.explain"
  | "legend.zone.explain"
  | "legend.bos"
  | "legend.bos.explain"
  | "legend.choch"
  | "legend.choch.explain"
  | "legend.sweep"
  | "legend.sweep.explain"
  | "legend.eq"
  | "legend.eq.explain"
  | "legend.level"
  | "legend.level.explain"
  | "legend.liq"
  | "legend.liq.explain"
  | "legend.figure"
  | "legend.figure.explain"
  | "legend.pattern"
  | "legend.pattern.explain"
  | "legend.poc.explain"
  | "legend.alert"
  | "legend.alert.explain"
  | "legend.position"
  | "legend.position.explain"
  | "legend.selection"
  | "legend.selection.explain"
  // заголовки панелей производных
  | "panel.funding"
  | "panel.oi"
  | "panel.liq"
  | "panel.ls";

export type SceneText = { readonly [K in TextKey]: string } & {
  /** Подстановка «{n}», тот же контракт, что у t(). */
  fill(template: string, vars: Readonly<Record<string, string | number>>): string;
  /** Название свечного паттерна по типу; неизвестный тип — название с сервера. */
  pattern(type: string, fallbackTitle: string): string;
  /** Название графической фигуры (с сервера приходит по-русски). */
  figure(type: string, title: string): string;
  /** Вид зоны словами, только для подсказки: «ордер-блок покупок» и т. п. */
  zoneKind(kind: string, dir: "up" | "down"): string;
  /** Заголовок панели производных: «Фандинг», «Открытый интерес», «Ликвидации», «Лонг/шорт». */
  panel(key: PanelKey): string;
  /** Дата свечи в UTC: «12.10.26 08:00 UTC». */
  date(unixSec: number): string;
};

/** Подстановка «{name}» → значение; неизвестные имена остаются как есть. */
export function fillTemplate(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** «12.10.26 08:00 UTC»: время свечи всегда в UTC, без зависимости от часового пояса браузера. */
export function formatUtcDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${pad2(d.getUTCFullYear() % 100)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** Русские названия свечных паттернов (те же, что PATTERN_LABEL в apps/web/src/lib/chart.ts). */
export const PATTERN_RU: Readonly<Record<string, string>> = {
  engulfing: "поглощение",
  pin_bar: "пин-бар",
  doji: "доджи",
  doji_dragonfly: "доджи-стрекоза",
  doji_gravestone: "доджи-надгробие",
  star: "звезда",
  three_line: "три свечи",
  harami: "харами",
  inside_bar: "внутренний бар",
  inside_bar_breakout: "пробой вн. бара",
  marubozu: "марубозу",
  tweezer: "пинцет",
};

/** Виды зон словами (те же фразы, что в apps/web/src/lib/zones.ts — переводы уже есть в en.json). */
export const ZONE_KIND_RU: Readonly<Record<string, { up: string; down: string }>> = {
  ob: { up: "ордер-блок покупок", down: "ордер-блок продаж" },
  sd: { up: "зона спроса", down: "зона предложения" },
  fvg: { up: "разрыв цены вверх", down: "разрыв цены вниз" },
};

const PANEL_KEY: Readonly<Record<PanelKey, TextKey>> = { funding: "panel.funding", oi: "panel.oi", liq: "panel.liq", ls: "panel.ls" };

/** Русский оригинал всех строк. Владелец проверяет тексты (ADR-0008, план 10.4). */
export const RU_STRINGS: { readonly [K in TextKey]: string } = {
  "preset.clean": "Чистый",
  "preset.structure": "Структура",
  "preset.levels": "Уровни и зоны",
  "preset.liquidity": "Карта ликвидаций",
  "preset.detailed": "Подробный",
  "preset.compact": "Компактный",
  "preset.custom": "Свой",

  "sr.support": "Поддержка",
  "sr.resistance": "Сопротивление",
  "sr.support.short": "Подд.",
  "sr.resistance.short": "Сопр.",
  "zone.demand": "Спрос",
  "zone.supply": "Предложение",
  "zone.mixed": "Зона",
  "structure.bos": "Пробой {dir}",
  "structure.choch": "Смена {dir}",
  "structure.sweep": "Снятие",
  "structure.eqh": "Равные макс.",
  "structure.eql": "Равные мин.",
  "level.pdh": "Макс. вчера",
  "level.pdl": "Мин. вчера",
  "level.pwh": "Макс. пр. нед.",
  "level.pwl": "Мин. пр. нед.",
  "figure.target": "Цель",
  "figure.invalidation": "Слом",
  "figure.forming": "формируется",
  "figure.confirmed": "подтверждена",
  "figure.invalidated": "отменена",
  "signal.entry": "Вход",
  "signal.stop": "Стоп",
  "signal.tp": "Цель {n}",
  "alert.up": "Алерт ↑",
  "alert.down": "Алерт ↓",
  "alert.range": "Алерт ↔",
  "liq.longs": "Ликвидации лонгов (оценка)",
  "liq.shorts": "Ликвидации шортов (оценка)",
  "liq.estimate": "оценка",
  "liq.unavailable": "нет данных открытого интереса на этом таймфрейме",
  "liq.note": "по приросту открытого интереса, плечи 10–100×, не данные биржи",
  "vp.poc": "Макс. объём",

  "hover.touches": "касаний: {n}",
  "hover.distance": "{pct} от цены",
  "hover.range": "от {from} до {to}",
  "hover.amount": "≈ {amount}",
  "hover.inside": "цена в зоне",
  "hover.since": "с {date}",
  "hover.notAdvice": "не сигнал и не рекомендация",
  "hover.bos.up": "Пробой структуры вверх",
  "hover.bos.down": "Пробой структуры вниз",
  "hover.choch.up": "Смена направления вверх",
  "hover.choch.down": "Смена направления вниз",
  "hover.closeBeyond": "закрытие за уровнем {date}",
  "hover.sweep.high": "Снятие ликвидности над максимумом",
  "hover.sweep.low": "Снятие ликвидности под минимумом",
  "hover.eqh": "Равные максимумы",
  "hover.eql": "Равные минимумы",
  "hover.pdh": "Максимум прошлого дня",
  "hover.pdl": "Минимум прошлого дня",
  "hover.pwh": "Максимум прошлой недели",
  "hover.pwl": "Минимум прошлой недели",
  "hover.figureTarget": "Расчётная цель фигуры",
  "hover.figureInvalidation": "Слом фигуры: закрытие за этой ценой отменяет её",
  "hover.patternSignificant": "значимый",
  "hover.patternFound": "найден",
  "hover.signal.long": "сигнал {grade}, лонг",
  "hover.signal.short": "сигнал {grade}, шорт",
  "hover.alert.up": "Алерт: пересечение вверх",
  "hover.alert.down": "Алерт: пересечение вниз",
  "hover.alert.range": "Алерт: вход в диапазон",
  "hover.poc": "Цена с наибольшим объёмом на видимом участке",

  "legend.price": "Цена",
  "legend.price.explain": "Текущая цена; под ней — время до закрытия свечи.",
  "legend.resistance.explain": "Цена несколько раз разворачивалась вниз у этого уровня. Сплошная линия — 5 касаний и больше.",
  "legend.support.explain": "Цена несколько раз разворачивалась вверх у этого уровня. Сплошная линия — 5 касаний и больше.",
  "legend.demand.explain": "Зона, откуда цена раньше уходила вверх.",
  "legend.supply.explain": "Зона, откуда цена раньше уходила вниз.",
  "legend.zone.explain": "Пересекаются зоны спроса и предложения.",
  "legend.bos": "Пробой ↑↓",
  "legend.bos.explain": "Свеча закрылась за последним максимумом или минимумом — так отмечается продолжение текущего движения.",
  "legend.choch": "Смена ↑↓",
  "legend.choch.explain": "Первый пробой против прежнего движения — так отмечается возможная смена направления.",
  "legend.sweep": "Снятие",
  "legend.sweep.explain": "Цена проколола максимум или минимум и вернулась — снятие ликвидности: за такими уровнями обычно стоят стоп-заявки.",
  "legend.eq": "Равные макс./мин.",
  "legend.eq.explain": "Несколько максимумов или минимумов на одной цене; за такими уровнями обычно стоят стоп-заявки.",
  "legend.level": "Макс./мин. вчера и прошлой недели",
  "legend.level.explain": "Максимум и минимум прошлого дня и прошлой недели.",
  "legend.liq": "Ликвидации",
  "legend.liq.explain": "Где могли бы закрыться позиции с плечом 10–100× (оценка по открытому интересу, не данные биржи).",
  "legend.figure": "Фигура",
  "legend.figure.explain": "Графическая фигура по закрытым свечам. Цель — расчётная, Слом — цена, за которой фигура отменяется. Не рекомендация.",
  "legend.pattern": "Паттерн",
  "legend.pattern.explain": "Свечной паттерн: треугольник показывает направление, ромб — без направления. Наведите, чтобы увидеть название.",
  "legend.poc.explain": "Цена, где за видимый период прошло больше всего объёма.",
  "legend.alert": "Алерт",
  "legend.alert.explain": "Ваш алерт по цене.",
  "legend.position": "Вход / Стоп / Цель",
  "legend.position.explain": "Уровни сигнала стратегии.",
  "legend.selection": "Выделение",
  "legend.selection.explain": "Так подсвечивается выбранный объект.",

  "panel.funding": "Фандинг",
  "panel.oi": "Открытый интерес",
  "panel.liq": "Ликвидации",
  "panel.ls": "Лонг/шорт",
};

/**
 * Сборка SceneText из функции перевода (в web — t из useT()). Ключи — русские строки RU_STRINGS, поэтому
 * перевод по ним совпадает с t("…") в chartText.ts; при tr = identity получается RU_TEXT.
 */
export function makeSceneText(tr: (ru: string) => string): SceneText {
  const strings = {} as Record<TextKey, string>;
  for (const k of Object.keys(RU_STRINGS) as TextKey[]) strings[k] = tr(RU_STRINGS[k]);
  return {
    ...strings,
    fill: fillTemplate,
    pattern: (type, fallbackTitle) => tr(PATTERN_RU[type] ?? fallbackTitle),
    figure: (_type, title) => tr(title),
    zoneKind: (kind, dir) => {
      const n = ZONE_KIND_RU[kind];
      return n ? tr(dir === "down" ? n.down : n.up) : kind.toUpperCase();
    },
    panel: (key) => strings[PANEL_KEY[key]],
    date: formatUtcDate,
  };
}

/** Русские строки для юнит-тестов и снимков (без React). */
export const RU_TEXT: SceneText = makeSceneText((s) => s);
