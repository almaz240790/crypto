import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SignalsGate } from "@/components/signals/SignalsGate";
import { getSignalsPublic } from "@/lib/api";
import { SIGNALS_NEXT_HEADER } from "@/lib/signalsAccess";

/**
 * Сигналы — только для владельца до запуска продаж (ADR-0013). Гостю, пока сигналы закрыты, — 404 (адрес
 * выглядит несуществующим, а не закрытым паролем); когда открыты — вход, как раньше. Вошедшего проверяет
 * SignalsGate: роль известна только в браузере.
 */
export default async function SignalsLayout({ children }: { children: ReactNode }) {
  const pub = await getSignalsPublic();
  if ((await cookies()).get("pl_auth")?.value !== "1") {
    if (!pub) notFound();
    const next = (await headers()).get(SIGNALS_NEXT_HEADER) ?? "/signals";
    redirect(`/login?next=${encodeURIComponent(next.startsWith("/signals") ? next : "/signals")}`);
  }
  return <SignalsGate pub={pub}>{children}</SignalsGate>;
}
