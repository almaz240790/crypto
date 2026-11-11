"use client";

import type { ReactNode } from "react";
import { useSignalsAccess } from "@/components/auth/signalsAccess";
import { NotFound } from "@/components/site/NotFound";

/**
 * Лента и карточки сигналов (ADR-0013): пока сигналы закрыты, вошедшему без прав admin или owner —
 * та же страница «не найдена», что и на несуществующем адресе. Гостя до сюда не пускает сервер (404).
 * Данные закрывает API (404), здесь — только то, что видно на экране.
 */
export function SignalsGate({ pub, children }: { pub: boolean; children: ReactNode }) {
  const { open, loading } = useSignalsAccess(pub);
  if (loading) return null;
  return open ? children : <NotFound />;
}
