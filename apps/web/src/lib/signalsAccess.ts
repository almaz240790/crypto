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

/**
 * Cookie-подсказка «сигналы видны» (без секретов, как pl_auth): её ставит браузер по ответу /v1/auth/me, чтобы
 * сервер сайта, который не знает токена, отвечал вошедшему без прав настоящим 404 на /signals, а не страницей
 * «не найдена» со статусом 200. Подделка подсказки ничего не открывает — данные закрывает API (404), страницу —
 * SignalsGate. Имя нейтральное: оно видно в JS каждой страницы.
 */
export const ACCESS_HINT_COOKIE = "pl_x";

/**
 * Что отдать по адресу раздела сигналов (/signals, /stats с вкладками сигналов) на сервере.
 * pub — сигналы открыты всем; authed — cookie pl_auth; access — cookie ACCESS_HINT_COOKIE.
 * "show" — страница; "login" — сначала вход (сигналы открыты, гость); "absent" — как несуществующий адрес.
 */
export function signalsRoute(pub: boolean, authed: boolean, access: boolean): "show" | "login" | "absent" {
  if (pub) return authed ? "show" : "login";
  return authed && access ? "show" : "absent";
}

/**
 * Ссылка из админки на страницу сигналов на сайте (ADR-0013). Сеанс админки на сайт не переносится (ADR-0011):
 * если на сайте не выполнен вход под аккаунтом с доступом к сигналам, ссылка ведёт на вход сайта с возвратом
 * на эту страницу (а не на «не найдена»).
 */
export function siteSignalsHref(path: string, user: { role: string; signals?: boolean } | null | undefined): string {
  return canSeeSignals(user) ? path : `/login?next=${encodeURIComponent(path)}`;
}
