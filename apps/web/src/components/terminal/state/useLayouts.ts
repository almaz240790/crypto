"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/i18n/client";
import { deleteLayout, getLayout, listLayouts, putLayout } from "@/lib/drawings";
import { layoutData, type SavedV5 } from "./useTerminalSettings";

/**
 * Именованные раскладки (план 2A.4): список вошедшего, сохранение текущих настроек, применение
 * (через миграцию настроек, с переходом на инструмент и таймфрейм раскладки) и удаление.
 */
export function useLayouts({ authed, symbol, tf, current, applyLayout, say }: { authed: boolean; symbol: string; tf: string; current: SavedV5; applyLayout: (raw: unknown) => void; say: (text: string) => void }) {
  const t = useT();
  const router = useRouter();
  const [layouts, setLayouts] = useState<{ name: string }[]>([]);
  useEffect(() => {
    if (!authed) return;
    listLayouts()
      .then((r) => setLayouts(r))
      .catch(() => {});
  }, [authed]);
  const saveLayout = (name: string) => {
    putLayout(layoutData(current, symbol, tf), Date.now(), name)
      .then(() => {
        setLayouts((l) => (l.some((x) => x.name === name) ? l : [...l, { name }]));
        say(t("Раскладка «{name}» сохранена", { name }));
      })
      .catch((e: Error) => say(e.message));
  };
  const loadLayout = (name: string) => {
    getLayout(name)
      .then((r) => {
        if (!r.data) return;
        const d = r.data as { symbol?: string; tf?: string };
        applyLayout(r.data);
        if (d.symbol && d.tf && (d.symbol !== symbol || d.tf !== tf)) router.push(`/chart/${d.symbol}/${d.tf}`);
        say(t("Раскладка «{name}» применена", { name }));
      })
      .catch((e: Error) => say(e.message));
  };
  const removeLayout = (name: string) => {
    deleteLayout(name)
      .then(() => setLayouts((l) => l.filter((x) => x.name !== name)))
      .catch((e: Error) => say(e.message));
  };
  return { layouts, saveLayout, loadLayout, removeLayout };
}
