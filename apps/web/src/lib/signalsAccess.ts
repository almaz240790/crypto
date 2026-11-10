/**
 * Кому видны сигналы (ADR-0013): пока владелец не открыл продажи, ленту, карточки, статистику сигналов
 * и всё, что о них говорит, видят только admin и owner (STAFF_ROLES в apps/api/app/signals_access.py).
 * Решает API (выключатель SIGNALS_PUBLIC): гостю он отвечает в /v1/features, вошедшему — полем signals
 * в /v1/auth/me. Сайт по этим ответам только прячет ссылки и разделы; данные закрывает сам API (404).
 */

/**
 * pub — открыты ли сигналы всем (серверная страница узнаёт это у API). Вошедшему API говорит сам
 * (поле signals). Поля нет — API старше ADR-0013: тогда сигналы были видны всем вошедшим, и сайт
 * показывает их, как раньше (данные отдаёт и закрывает всё равно API).
 */
export function canSeeSignals(user: { role: string; signals?: boolean } | null | undefined, pub = false): boolean {
  if (pub) return true;
  if (!user) return false;
  return user.signals ?? true;
}

/** Адрес раздела сигналов, с которого гостя уводят на вход (прокси → layout сигналов): layout не знает пути. */
export const SIGNALS_NEXT_HEADER = "x-pl-next";
