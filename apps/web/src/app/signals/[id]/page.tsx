"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { DirectionBadge, EmptyState, GradeBadge, Panel, StatusBadge } from "@/components/ui";
import { api } from "@/lib/auth-client";
import { formatPrice, formatR, formatTimeUTC } from "@/lib/format";
import type { SignalRow } from "@/lib/signals";

type Detail = SignalRow & {
  facts: string[];
  zone: Record<string, string> | null;
  score_breakdown: Record<string, number> | null;
  events: { type: string; price: string | null; at: string; source: string }[];
};

// Базовая карточка; график и разбор — задача 2.10.
export default function SignalPage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Detail>(`/v1/signals/${id}`)
      .then(setD)
      .catch((e: Error) => setError(e.message));
  }, [id]);
  const title = d ? `${d.symbol} ${d.direction}` : "Сигнал";
  return (
    <AppShell title={title}>
      {error ? (
        <Panel>
          <EmptyState text={`Сигнал недоступен: ${error}`} />
        </Panel>
      ) : !d ? (
        <Panel>
          <EmptyState text="Загрузка…" />
        </Panel>
      ) : (
        <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
          <Panel
            title={
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                {d.symbol} <DirectionBadge direction={d.direction} /> <GradeBadge grade={d.grade} /> <StatusBadge status={d.status} />
              </span>
            }
            actions={<span>{formatTimeUTC(d.candle_close_time)}</span>}
          >
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 16px", margin: 0 }}>
              <dt className="text-2">Вход</dt>
              <dd className="num" style={{ margin: 0, textAlign: "left" }}>
                {formatPrice(d.entry_limit ?? d.entry_market, "0.0001")}
              </dd>
              <dt className="text-2">Стоп</dt>
              <dd className="num down" style={{ margin: 0, textAlign: "left" }}>
                {formatPrice(d.stop_loss, "0.0001")}
              </dd>
              <dt className="text-2">Цели</dt>
              <dd className="num" style={{ margin: 0, textAlign: "left" }}>
                {[d.tp1, d.tp2, d.tp3].map((x) => formatPrice(x, "0.0001")).join(" / ")}
              </dd>
              <dt className="text-2">R:R до TP2</dt>
              <dd className="num" style={{ margin: 0, textAlign: "left" }}>
                {d.rr_tp2 ? Number(d.rr_tp2).toFixed(2) : "—"}
              </dd>
              <dt className="text-2">Оценка</dt>
              <dd style={{ margin: 0 }}>
                {d.score} из 100, градация {d.grade}
              </dd>
              {d.result && (
                <>
                  <dt className="text-2">Результат</dt>
                  <dd className="num" style={{ margin: 0, textAlign: "left" }}>
                    {formatR(d.result.realized_r)}
                  </dd>
                </>
              )}
            </dl>
          </Panel>
          <Panel title="Почему сигнал">
            {d.facts.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {d.facts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : (
              <EmptyState text="Факты не записаны." />
            )}
          </Panel>
          <Panel title="События" flush>
            {d.events.length === 0 ? (
              <EmptyState text="Событий пока нет: ждём касания входа." />
            ) : (
              <table style={{ width: "100%", fontSize: 14 }}>
                <tbody>
                  {d.events.map((e) => (
                    <tr key={e.at + e.type}>
                      <td style={{ padding: "6px 12px" }}>{formatTimeUTC(e.at)}</td>
                      <td style={{ padding: "6px 12px" }}>{e.type}</td>
                      <td className="num" style={{ padding: "6px 12px" }}>
                        {formatPrice(e.price, "0.0001")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <p className="caption">График и разбор по шагам появятся в следующем обновлении карточки.</p>
        </div>
      )}
    </AppShell>
  );
}
