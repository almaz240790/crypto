"use client";

import { EmptyState } from "@/components/ui";
import { useT } from "@/i18n/client";
import p from "./panels.module.css";

/** «Разбор» (резерв, план 2A.11.12, ADR-0007): вкладка видна, только если ресурс topdown включён сервером. */
export function TopdownTab() {
  const t = useT();
  return (
    <div className={p.tab}>
      <EmptyState text={t("Разбор появится позже")} />
    </div>
  );
}
