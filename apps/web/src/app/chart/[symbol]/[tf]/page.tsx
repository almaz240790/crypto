import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app/AppShell";
import { TerminalClient } from "@/components/terminal/TerminalClient";
import { TF_LABEL, TIMEFRAMES, type Timeframe } from "@/lib/timeframes";
import { getT } from "@/i18n/server";

type Params = { symbol: string; tf: string };

const isTf = (tf: string): tf is Timeframe => (TIMEFRAMES as readonly string[]).includes(tf);

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { symbol, tf } = await params;
  const t = await getT();
  // подпись таймфрейма — та же, что в терминале (TF_LABEL): «BTCUSDT 4ч — график»
  const vars = { symbol: symbol.toUpperCase(), tf: isTf(tf) ? t(TF_LABEL[tf]) : tf };
  return {
    title: t("{symbol} {tf} — график", vars),
    description: t("График {symbol} на таймфрейме {tf}: структура рынка, зоны, уровни, индикаторы и инструменты рисования.", vars),
  };
}

export default async function ChartPage({ params }: { params: Promise<Params> }) {
  const { symbol, tf } = await params;
  if (!/^[A-Z0-9]{5,20}$/i.test(symbol) || !isTf(tf)) notFound();
  const t = await getT();
  return (
    <AppShell title={`${symbol.toUpperCase()} · ${t(TF_LABEL[tf])}`} flush rail>
      <TerminalClient symbol={symbol.toUpperCase()} tf={tf} />
    </AppShell>
  );
}
