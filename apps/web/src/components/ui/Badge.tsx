"use client";

import type { ReactNode } from "react";
import s from "./Badge.module.css";
import { useT } from "@/i18n/client";

export type Tone = "neutral" | "up" | "down" | "accent" | "warn" | "muted";

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  const cls = [s.badge, tone !== "neutral" ? s[tone] : ""].filter(Boolean).join(" ");
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

/** Статусы сигнала из API (план 2.10): pending/active/tp1_hit/.../closed_sl/expired/cancelled. */
export const STATUS_LABEL: Record<string, { text: string; tone: Tone }> = {
  pending: { text: "ожидает", tone: "neutral" },
  active: { text: "в работе", tone: "accent" },
  tp1_hit: { text: "TP1", tone: "up" },
  tp2_hit: { text: "TP2", tone: "up" },
  closed_tp3: { text: "TP3", tone: "up" },
  closed_be: { text: "б/у", tone: "muted" },
  closed_sl: { text: "стоп", tone: "down" },
  closed_time: { text: "по времени", tone: "muted" },
  expired: { text: "не вошёл", tone: "muted" },
  cancelled: { text: "отменён", tone: "muted" },
};

export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const m = STATUS_LABEL[status] ?? { text: status, tone: "neutral" as Tone };
  return <Badge tone={m.tone}>{t(m.text)}</Badge>;
}

export function GradeBadge({ grade }: { grade: "A" | "B" | "C" | string }) {
  const t = useT();
  const cls = [s.grade, grade === "B" ? s.gradeB : "", grade === "C" ? s.gradeC : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} aria-label={t("градация {g}", { g: grade })}>
      {grade}
    </span>
  );
}

export function DirectionBadge({ direction }: { direction: "long" | "short" | string }) {
  const up = direction === "long";
  return (
    <Badge tone={up ? "up" : "down"}>
      <span className={s.dir}>{up ? "long" : "short"}</span>
    </Badge>
  );
}
