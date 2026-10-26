import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app/AppShell";
import { TerminalClient } from "@/components/terminal/TerminalClient";
import { TIMEFRAMES } from "@/lib/timeframes";

type Params = { symbol: string; tf: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { symbol, tf } = await params;
  return { title: `${symbol.toUpperCase()} ${tf.toUpperCase()} — график`, description: `Терминал: ${symbol.toUpperCase()} на таймфрейме ${tf}. Структура рынка, зоны, сигналы, индикаторы.` };
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
