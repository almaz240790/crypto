"use client";

import { useEffect, useState } from "react";
import { getInstruments, type Instrument } from "@/lib/user";

/** Список инструментов для выбора символа, наложения и копирования рисунка; пока не загружен — пустой. */
export function useInstruments(): Instrument[] {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  useEffect(() => {
    getInstruments()
      .then((r) => setInstruments(r))
      .catch(() => {});
  }, []);
  return instruments;
}
