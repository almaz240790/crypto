"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/auth-client";

/** Задержка проверки: после первой свечи и данных разметки, чтобы не занимать сеть на старте (бюджет D). */
const PROBE_DELAY_MS = 2500;
/** Повторы после сбоя (5xx, сеть, 429): ответ не окончательный, вкладка не прячется на всю сессию. */
const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

/** Кому сервер может ответить 200 (план 2A.11.12): владелец и админы; остальным — 404 topdown_disabled. */
export const isStaff = (role: string | null | undefined): boolean => role === "admin" || role === "owner";

/** Окончательный ответ (200 → true, 404/403 → false) по пользователю и роли; сбой — null, не кэшируется. */
const answers = new Map<string, boolean>();
const inflight = new Map<string, Promise<boolean | null>>();

/** Ответ ресурса: 200 — включён; 404 (topdown_disabled) или 403 — выключен; остальное — сбой, повторить позже. */
export function topdownAnswer(result: { ok: true } | { ok: false; error: unknown }): boolean | null {
  if (result.ok) return true;
  const e = result.error;
  return e instanceof ApiError && (e.status === 404 || e.status === 403) ? false : null;
}

function probe(key: string, symbol: string, tf: string): Promise<boolean | null> {
  let p = inflight.get(key);
  if (!p) {
    p = api(`/v1/chart/topdown?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`, { auth: true }).then(
      () => topdownAnswer({ ok: true }),
      (error: unknown) => topdownAnswer({ ok: false, error }),
    );
    inflight.set(key, p);
    void p.then((r) => {
      inflight.delete(key);
      if (r !== null) answers.set(key, r);
    });
  }
  return p;
}

/**
 * Резерв «Разбора сверху вниз» (план 2A.11.12, ADR-0007; замечание критика): вкладка и пункт тулбара «Разбор» есть,
 * только если /v1/chart/topdown ответил 200. Сервер отвечает 200 владельцу и админам, остальным — 404, поэтому гость
 * и обычный пользователь не проверяют вовсе (запроса нет). Ответ кэшируется по id пользователя и роли: выход и вход
 * другим пользователем в той же вкладке проверяют заново; сбой (не 200/404) не кэшируется и повторяется.
 */
export function useTopdown(symbol: string, tf: string, user: { id: number; role: string } | null): boolean {
  const key = user && isStaff(user.role) ? `${user.id}:${user.role}` : null;
  const [answer, setAnswer] = useState<{ key: string; on: boolean } | null>(null);
  useEffect(() => {
    if (!key) return;
    const known = answers.get(key);
    if (known !== undefined) {
      queueMicrotask(() => setAnswer({ key, on: known }));
      return;
    }
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (attempt: number) => {
      timer = setTimeout(
        () => {
          void probe(key, symbol, tf).then((r) => {
            if (dead) return;
            if (r !== null) setAnswer({ key, on: r });
            else if (attempt < RETRY_DELAYS_MS.length) run(attempt + 1);
          });
        },
        attempt === 0 ? PROBE_DELAY_MS : RETRY_DELAYS_MS[attempt - 1],
      );
    };
    run(0);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [key, symbol, tf]);
  return key !== null && answer?.key === key && answer.on;
}
