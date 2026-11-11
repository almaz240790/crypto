"use client";

import { canSeeSignals } from "@/lib/signalsAccess";
import { useAuth } from "./AuthProvider";

/** Видны ли сигналы вошедшему (ADR-0013); pub — открыты ли они всем (передаёт серверная страница). */
export function useSignalsAccess(pub = false): { open: boolean; loading: boolean } {
  const { user, loading } = useAuth();
  return { open: canSeeSignals(user, pub), loading: pub ? false : loading };
}
