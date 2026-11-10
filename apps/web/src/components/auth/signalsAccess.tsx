"use client";

import type { ReactNode } from "react";
import { canSeeSignals } from "@/lib/signalsAccess";
import { useAuth } from "./AuthProvider";

/** Видны ли сигналы вошедшему (ADR-0013); pub — открыты ли они всем (передаёт серверная страница). */
export function useSignalsAccess(pub = false): { open: boolean; loading: boolean } {
  const { user, loading } = useAuth();
  return { open: canSeeSignals(user, pub), loading: pub ? false : loading };
}

/**
 * Содержимое только для тех, кому видны сигналы. В серверных страницах — для ссылок и строк о сигналах:
 * сервер не знает, кто вошёл (токен есть только в браузере), и показывает их, лишь если сигналы открыты всем.
 */
export function SignalsOnly({ pub = false, children, fallback = null }: { pub?: boolean; children: ReactNode; fallback?: ReactNode }) {
  return useSignalsAccess(pub).open ? children : fallback;
}
