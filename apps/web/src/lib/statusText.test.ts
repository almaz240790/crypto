import { describe, expect, it } from "vitest";
import { makeT } from "@/i18n";
import { componentTitle, statusDetail } from "./statusText";

/**
 * Статус-страница: монитор (apps/api/app/monitor.py) отдаёт названия и подробности русскими фразами — здесь проверяется,
 * что компонент «Сверка сигналов» (задача 8 пакета «Сигналы») и его подробности переводятся, а не выводятся как есть.
 */
describe("statusText: сверка сигналов", () => {
  const ru = makeT("ru");
  const en = makeT("en");

  it("название компонента берётся по ключу, а не из ответа API", () => {
    expect(componentTitle(ru, "reconcile", "что-то другое")).toBe("Сверка сигналов");
    expect(componentTitle(en, "reconcile", "Сверка сигналов")).toBe("Signal reconciliation");
    expect(componentTitle(en, "неизвестный", "Как пришло")).toBe("Как пришло");
  });

  it("подробности без расхождений и с расхождениями — с числами из ответа", () => {
    expect(statusDetail(ru, "проверено сигналов: 14, расхождений нет")).toBe("проверено сигналов: 14, расхождений нет");
    expect(statusDetail(en, "проверено сигналов: 14, расхождений нет")).toBe("signals checked: 14, no discrepancies");
    const diff = "расхождений: критичных 1, предупреждений 2; проверено сигналов: 14";
    expect(statusDetail(ru, diff)).toBe(diff);
    expect(statusDetail(en, diff)).toBe("discrepancies: 1 critical, 2 warnings; signals checked: 14");
  });

  it("состояния «не выполнялась» и «ошибка» переведены", () => {
    for (const detail of ["сверка ещё не выполнялась", "сверка не выполнялась больше 36 ч", "сверка не выполнена: ошибка", "итог сверки не читается"]) {
      expect(statusDetail(ru, detail)).toBe(detail);
      expect(statusDetail(en, detail)).not.toBe(detail);
      expect(statusDetail(en, detail)).not.toMatch(/[а-яё]/i);
    }
  });

  it("прежние форматы не задеты, неизвестная фраза выводится как есть", () => {
    expect(statusDetail(en, "heartbeat 30 с назад")).toBe("heartbeat 30 s ago");
    expect(statusDetail(en, "нет закрытия свечи у 4 из 59 инструментов")).toBe("no candle close for 4 of 59 instruments");
    expect(statusDetail(en, "что-то новое")).toBe("что-то новое");
  });
});
