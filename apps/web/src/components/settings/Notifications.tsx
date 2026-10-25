"use client";

import { useEffect, useState } from "react";
import s from "@/components/tools/tools.module.css";
import { Button, EmptyState, Input, Panel, Select } from "@/components/ui";
import { api } from "@/lib/auth-client";

export type NotificationSettings = {
  email_digest: "daily" | "weekly" | "off";
  email_signals: boolean;
  email_events: boolean;
  grades: string[];
  scope: "all" | "watchlist";
  quiet_from: number | null;
  quiet_to: number | null;
  daily_limit: number;
  telegram_linked: boolean;
};

const TG_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT;

export function NotificationsPanel({ userId, onMessage }: { userId: number; onMessage: (text: string, kind?: "ok" | "error") => void }) {
  const [ns, setNs] = useState<NotificationSettings | null>(null);
  const [draft, setDraft] = useState<Partial<NotificationSettings> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<NotificationSettings>("/v1/me/notifications")
      .then((r) => setNs(r))
      .catch((e: Error) => setError(e.message));
  }, []);

  const v = <K extends keyof NotificationSettings>(k: K): NotificationSettings[K] => (draft && k in draft ? (draft[k] as NotificationSettings[K]) : (ns as NotificationSettings)[k]);
  const set = <K extends keyof NotificationSettings>(k: K, x: NotificationSettings[K]) => setDraft((d) => ({ ...(d ?? {}), [k]: x }));

  if (error) return <Panel title="Уведомления"><EmptyState text={error} /></Panel>;
  if (!ns) return <Panel title="Уведомления"><EmptyState text="Загрузка…" /></Panel>;

  const toggleGrade = (g: string) => {
    const cur = v("grades");
    set("grades", cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g].sort());
  };

  return (
    <Panel title="Уведомления" footer="Тихие часы — по UTC. Лимит ограничивает письма о сигналах и событиях в сутки; дайджест в лимит не входит.">
      <form
        className={s.form}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft) return;
          try {
            const body: Record<string, unknown> = { ...draft };
            if (draft.quiet_from === null || draft.quiet_to === null) {
              body.clear_quiet = true;
              delete body.quiet_from;
              delete body.quiet_to;
            }
            const r = await api<NotificationSettings>("/v1/me/notifications", { method: "PATCH", json: body });
            setNs(r);
            setDraft(null);
            onMessage("Уведомления сохранены");
          } catch (err) {
            onMessage(err instanceof Error ? err.message : "ошибка", "error");
          }
        }}
      >
        <div className={s.row}>
          <Select label="Email-дайджест" value={v("email_digest")} onChange={(e) => set("email_digest", e.target.value as NotificationSettings["email_digest"])}>
            <option value="daily">ежедневно (если были сделки)</option>
            <option value="weekly">раз в неделю, по понедельникам</option>
            <option value="off">выключен</option>
          </Select>
          <Select label="Письма о новых сигналах" value={v("email_signals") ? "on" : "off"} onChange={(e) => set("email_signals", e.target.value === "on")}>
            <option value="off">нет</option>
            <option value="on">сразу при публикации</option>
          </Select>
          <Select label="Письма о событиях" value={v("email_events") ? "on" : "off"} onChange={(e) => set("email_events", e.target.value === "on")}>
            <option value="off">нет</option>
            <option value="on">вход, цели, стоп</option>
          </Select>
        </div>
        <div className={s.row}>
          <div>
            <div className="caption" style={{ marginBottom: 4 }}>
              Градации
            </div>
            <div className={s.actions}>
              {["A", "B", "C"].map((g) => (
                <label key={g} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}>
                  <input type="checkbox" checked={v("grades").includes(g)} onChange={() => toggleGrade(g)} /> {g}
                </label>
              ))}
            </div>
          </div>
          <Select label="Инструменты" value={v("scope")} onChange={(e) => set("scope", e.target.value as NotificationSettings["scope"])}>
            <option value="all">все</option>
            <option value="watchlist">только вотчлист</option>
          </Select>
          <Input label="Лимит в сутки" mono inputMode="numeric" value={String(v("daily_limit"))} onChange={(e) => set("daily_limit", Math.max(1, Math.min(200, Number(e.target.value) || 1)))} />
        </div>
        <div className={s.row}>
          <Select label="Тихие часы с (UTC)" value={v("quiet_from") === null ? "" : String(v("quiet_from"))} onChange={(e) => set("quiet_from", e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">нет</option>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
          <Select label="до (UTC)" value={v("quiet_to") === null ? "" : String(v("quiet_to"))} onChange={(e) => set("quiet_to", e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">нет</option>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, color: "var(--text-2)" }}>
          <li>
            Telegram —{" "}
            {ns.telegram_linked ? "подключён" : TG_BOT ? (
              <a href={`https://t.me/${TG_BOT}?start=${userId}`} target="_blank" rel="noreferrer">
                открыть бота
              </a>
            ) : (
              "появится после подключения бота"
            )}
            .
          </li>
          <li>Push в браузере — после установки приложения на телефон.</li>
        </ul>
        <div className={s.actions}>
          <Button type="submit" size="sm" variant="primary" disabled={!draft}>
            Сохранить уведомления
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={async () => {
              try {
                const r = await api<{ status: string }>("/v1/me/notifications/test", { method: "POST" });
                onMessage(`Тестовое письмо: ${r.status}`);
              } catch (err) {
                onMessage(err instanceof Error ? err.message : "ошибка", "error");
              }
            }}
          >
            Отправить тестовое письмо
          </Button>
        </div>
      </form>
    </Panel>
  );
}
