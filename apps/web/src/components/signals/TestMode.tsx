"use client";

import { Badge } from "@/components/ui";
import { useT } from "@/i18n/client";
import { TEST_BADGE, TEST_LINE } from "@/lib/signals";
import s from "./TestMode.module.css";

/** Плашка «Тестовый режим» — у каждого тестового сигнала: строка ленты, шапка карточки, подсказка (ADR-0013). */
export function TestModeBadge({ short = false }: { short?: boolean }) {
  const t = useT();
  return (
    <span data-testid="test-badge" className={s.badge}>
      <Badge tone="warn" title={t(TEST_LINE)}>
        {short ? t("тест") : t(TEST_BADGE)}
      </Badge>
    </span>
  );
}

/** Плашка и одна строка пояснения: что такое тестовые сигналы. Без обещаний и без призывов (план 5.2, 8). */
export function TestModeNote() {
  const t = useT();
  return (
    <p className={s.note} role="note" data-testid="test-note">
      <TestModeBadge />
      <span>{t(TEST_LINE)}</span>
    </p>
  );
}
