import { fillTemplate, formatUtcDate, PATTERN_RU, ZONE_KIND_RU, type PanelKey, type SceneText, type TextKey } from "@platform/charts";
import type { T } from "@/i18n";

/**
 * Все слова графика (план 2B.2, 5.2, 8; ADR-0005, ADR-0008): подписи на холсте, подсказки, легенда «?»,
 * названия пресетов и панелей. Пакет графика не знает про i18n, поэтому SceneText собирается здесь из
 * литеральных t("…") — check-i18n видит ключи, а владелец проверяет тексты в одном файле. Русский оригинал
 * совпадает с RU_TEXT пакета (chartText.test). Без обещаний доходности и прогнозов (план 2A.10.6).
 */
function strings(t: T): { readonly [K in TextKey]: string } {
  return {
    "preset.clean": t("Чистый"),
    "preset.structure": t("Структура"),
    "preset.levels": t("Уровни и зоны"),
    "preset.liquidity": t("Карта ликвидаций"),
    "preset.detailed": t("Подробный"),
    "preset.compact": t("Компактный"),
    "preset.custom": t("Свой"),
    "sr.support": t("Поддержка"),
    "sr.resistance": t("Сопротивление"),
    "sr.support.short": t("Подд."),
    "sr.resistance.short": t("Сопр."),
    "zone.demand": t("Спрос"),
    "zone.supply": t("Предложение"),
    "zone.mixed": t("Зона"),
    "structure.bos": t("Пробой {dir}"),
    "structure.choch": t("Смена {dir}"),
    "structure.sweep": t("Снятие"),
    "structure.eqh": t("Равные макс."),
    "structure.eql": t("Равные мин."),
    "level.pdh": t("Макс. вчера"),
    "level.pdl": t("Мин. вчера"),
    "level.pwh": t("Макс. пр. нед."),
    "level.pwl": t("Мин. пр. нед."),
    "figure.target": t("Цель"),
    "figure.invalidation": t("Слом"),
    "figure.forming": t("формируется"),
    "figure.confirmed": t("подтверждена"),
    "figure.invalidated": t("отменена"),
    "signal.entry": t("Вход"),
    "signal.stop": t("Стоп"),
    "signal.tp": t("Цель {n}"),
    "alert.up": t("Алерт ↑"),
    "alert.down": t("Алерт ↓"),
    "alert.range": t("Алерт ↔"),
    "liq.longs": t("Ликвидации лонгов (оценка)"),
    "liq.shorts": t("Ликвидации шортов (оценка)"),
    "liq.estimate": t("оценка"),
    "liq.unavailable": t("нет данных открытого интереса на этом таймфрейме"),
    "liq.note": t("по приросту открытого интереса, плечи 10–100×, не данные биржи"),
    "vp.poc": t("Макс. объём"),
    "hover.touches": t("касаний: {n}"),
    "hover.distance": t("{pct} от цены"),
    "hover.range": t("от {from} до {to}"),
    "hover.amount": t("≈ {amount}"),
    "hover.inside": t("цена в зоне"),
    "hover.since": t("с {date}"),
    "hover.notAdvice": t("не сигнал и не рекомендация"),
    "hover.bos.up": t("Пробой структуры вверх"),
    "hover.bos.down": t("Пробой структуры вниз"),
    "hover.choch.up": t("Смена направления вверх"),
    "hover.choch.down": t("Смена направления вниз"),
    "hover.closeBeyond": t("закрытие за уровнем {date}"),
    "hover.sweep.high": t("Снятие ликвидности над максимумом"),
    "hover.sweep.low": t("Снятие ликвидности под минимумом"),
    "hover.eqh": t("Равные максимумы"),
    "hover.eql": t("Равные минимумы"),
    "hover.pdh": t("Максимум прошлого дня"),
    "hover.pdl": t("Минимум прошлого дня"),
    "hover.pwh": t("Максимум прошлой недели"),
    "hover.pwl": t("Минимум прошлой недели"),
    "hover.figureTarget": t("Расчётная цель фигуры"),
    "hover.figureInvalidation": t("Слом фигуры: закрытие за этой ценой отменяет её"),
    "hover.patternSignificant": t("значимый"),
    "hover.patternFound": t("найден"),
    "hover.signal.long": t("сигнал {grade}, лонг"),
    "hover.signal.short": t("сигнал {grade}, шорт"),
    "hover.alert.up": t("Алерт: пересечение вверх"),
    "hover.alert.down": t("Алерт: пересечение вниз"),
    "hover.alert.range": t("Алерт: вход в диапазон"),
    "hover.poc": t("Цена с наибольшим объёмом на видимом участке"),
    "legend.price": t("Цена"),
    "legend.price.explain": t("Текущая цена; под ней — время до закрытия свечи."),
    "legend.resistance.explain": t("Цена несколько раз разворачивалась вниз у этого уровня. Сплошная линия — 5 касаний и больше."),
    "legend.support.explain": t("Цена несколько раз разворачивалась вверх у этого уровня. Сплошная линия — 5 касаний и больше."),
    "legend.demand.explain": t("Зона, откуда цена раньше уходила вверх."),
    "legend.supply.explain": t("Зона, откуда цена раньше уходила вниз."),
    "legend.zone.explain": t("Пересекаются зоны спроса и предложения."),
    "legend.bos": t("Пробой ↑↓"),
    "legend.bos.explain": t("Свеча закрылась за последним максимумом или минимумом — так отмечается продолжение текущего движения."),
    "legend.choch": t("Смена ↑↓"),
    "legend.choch.explain": t("Первый пробой против прежнего движения — так отмечается возможная смена направления."),
    "legend.sweep": t("Снятие"),
    "legend.sweep.explain": t("Цена проколола максимум или минимум и вернулась — снятие ликвидности: за такими уровнями обычно стоят стоп-заявки."),
    "legend.eq": t("Равные макс./мин."),
    "legend.eq.explain": t("Несколько максимумов или минимумов на одной цене; за такими уровнями обычно стоят стоп-заявки."),
    "legend.level": t("Макс./мин. вчера и прошлой недели"),
    "legend.level.explain": t("Максимум и минимум прошлого дня и прошлой недели."),
    "legend.liq": t("Ликвидации"),
    "legend.liq.explain": t("Где могли бы закрыться позиции с плечом 10–100× (оценка по открытому интересу, не данные биржи)."),
    "legend.figure": t("Фигура"),
    "legend.figure.explain": t("Графическая фигура по закрытым свечам. Цель — расчётная, Слом — цена, за которой фигура отменяется. Не рекомендация."),
    "legend.pattern": t("Паттерн"),
    "legend.pattern.explain": t("Свечной паттерн: треугольник показывает направление, ромб — без направления. Наведите, чтобы увидеть название."),
    "legend.poc.explain": t("Цена, где за видимый период прошло больше всего объёма."),
    "legend.alert": t("Алерт"),
    "legend.alert.explain": t("Ваш алерт по цене."),
    "legend.position": t("Вход / Стоп / Цель"),
    "legend.position.explain": t("Уровни сигнала стратегии."),
    "legend.selection": t("Выделение"),
    "legend.selection.explain": t("Так подсвечивается выбранный объект."),
    "panel.funding": t("Фандинг"),
    "panel.oi": t("Открытый интерес"),
    "panel.liq": t("Ликвидации"),
    "panel.ls": t("Лонг/шорт"),
  };
}

const PANEL_KEY: Readonly<Record<PanelKey, TextKey>> = { funding: "panel.funding", oi: "panel.oi", liq: "panel.liq", ls: "panel.ls" };

const cache = new WeakMap<T, SceneText>();

/** SceneText для текущего языка; кэш по функции перевода (она меняется только со сменой языка). */
export function chartText(t: T): SceneText {
  const hit = cache.get(t);
  if (hit) return hit;
  const s = strings(t);
  const text: SceneText = {
    ...s,
    fill: fillTemplate,
    pattern: (type, fallbackTitle) => t(PATTERN_RU[type] ?? fallbackTitle),
    figure: (_type, title) => t(title),
    zoneKind: (kind, dir) => {
      const n = ZONE_KIND_RU[kind];
      return n ? t(dir === "down" ? n.down : n.up) : kind.toUpperCase();
    },
    panel: (key) => s[PANEL_KEY[key]],
    date: formatUtcDate,
  };
  cache.set(t, text);
  return text;
}
