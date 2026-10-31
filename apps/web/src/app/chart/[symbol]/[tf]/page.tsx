import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app/AppShell";
import { TerminalClient } from "@/components/terminal/TerminalClient";
import { TIMEFRAMES } from "@/lib/timeframes";
import { getT } from "@/i18n/server";

type Params = { symbol: string; tf: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { symbol, tf } = await params;
  const t = await getT();
  const vars = { symbol: symbol.toUpperCase(), tf: tf.toUpperCase() };
  return {
    title: t("{symbol} {tf} — график", vars),
    description: t("График {symbol} на таймфрейме {tf}: структура рынка, зоны, уровни, индикаторы и инструменты рисования.", vars),
  };
}

export default async function ChartPage({ params }: { params: Promise<Params> }) {
  const { symbol, tf } = await params;
  if (!/^[A-Z0-9]{5,20}$/i.test(symbol) || !(TIMEFRAMES as readonly string[]).includes(tf)) notFound();
  return (
    <AppShell title={`${symbol.toUpperCase()} · ${tf === "4h" ? "H4" : tf.toUpperCase()}`} flush>
      <TerminalClient symbol={symbol.toUpperCase()} tf={tf as (typeof TIMEFRAMES)[number]} />
    </AppShell>
  );
}
