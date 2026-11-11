import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SignalsGate } from "@/components/signals/SignalsGate";
import { getSignalsPublic } from "@/lib/api";
import { ACCESS_HINT_COOKIE, SIGNALS_NEXT_HEADER, signalsRoute } from "@/lib/signalsAccess";

/**
 * Сигналы — только для владельца до запуска продаж (ADR-0013). Пока сигналы закрыты, гостю и вошедшему без прав —
 * 404, как у несуществующего адреса (а не вход и не «закрыто»): сервер не знает роли (токен — только в браузере),
 * поэтому смотрит на cookie-подсказку доступа, которую браузер ставит по ответу /v1/auth/me. Когда сигналы открыты
 * всем — гостю вход, как раньше. Подделанную подсказку отсекает SignalsGate (роль из профиля), данные — API.
 */
export default async function SignalsLayout({ children }: { children: ReactNode }) {
  const pub = await getSignalsPublic();
  const jar = await cookies();
  const route = signalsRoute(pub, jar.get("pl_auth")?.value === "1", jar.get(ACCESS_HINT_COOKIE)?.value === "1");
  if (route === "absent") notFound();
  if (route === "login") {
    const next = (await headers()).get(SIGNALS_NEXT_HEADER) ?? "/signals";
    redirect(`/login?next=${encodeURIComponent(next.startsWith("/signals") ? next : "/signals")}`);
  }
  return <SignalsGate pub={pub}>{children}</SignalsGate>;
}
