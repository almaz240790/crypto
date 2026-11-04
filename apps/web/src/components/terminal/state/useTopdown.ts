"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/auth-client";

/** Задержка проверки: после первой свечи и данных разметки, чтобы не занимать сеть на старте (бюджет D). */
const PROBE_DELAY_MS = 2500;
/** Ответ на вкладку — один на сессию и вход: ресурс включается сервером, а не сборкой. */
const cache = new Map<string, Promise<boolean>>();

/**
 * Резерв «Разбора сверху вниз» (план 2A.11.12, ADR-0007; замечание критика): вкладка «Разбор» появляется, только если
 * /v1/chart/topdown ответил 200. Сервер отвечает 404 topdown_disabled всем, кроме владельца и админов, — поэтому
 * без флага сборки. Проверка одна на сессию для гостя и для вошедшего.
 */
export function useTopdown(symbol: string, tf: string, authed: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let dead = false;
    const timer = setTimeout(() => {
      const key = authed ? "user" : "guest";
      let p = cache.get(key);
      if (!p) {
        p = api(`/v1/chart/topdown?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`, { auth: authed }).then(
          () => true,
          () => false,
        );
        cache.set(key, p);
      }
      void p.then((ok) => !dead && setOn(ok));
    }, PROBE_DELAY_MS);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [symbol, tf, authed]);
  return on;
}
